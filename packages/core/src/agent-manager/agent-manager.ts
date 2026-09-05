import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, AgentTaskRequestEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { ExecutionLogger } from './execution-logger.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { PermissionDeps } from './agent-session.ts';
import { runAgentTask } from './agent-session.ts';
import type { RavenMcpDeps } from '../mcp-server/index.ts';
import type { MemoryStore } from '../agent-memory/memory-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { getConfig } from '../config.ts';
import {
  resolveSkillCapabilities,
  validateResolvedAgentExecutionSettings,
} from '../agent-registry/agent-resolver.ts';
import { validateChatTarget } from '../session-manager/chat-validation.ts';

const log = createLogger('agent-manager');

/**
 * AgentManager owns the task queue and agent concurrency.
 * It listens for agent:task:request events and runs them using Claude Agent SDK.
 *
 * CRITICAL: The agent manager NEVER gives MCPs to the main orchestrator agent.
 * MCPs are only attached to sub-agents that are skill-specific.
 */
export interface AgentManagerDeps {
  eventBus: EventBus;
  permissionEngine?: PermissionEngine;
  auditLog?: AuditLog;
  pendingApprovals?: PendingApprovals;
  /** Threaded into PermissionDeps.capabilityLibrary (canUseTool policy's
   * unmapped-MCP-tool fallback) AND used directly by executeAction
   * to resolve a skillName's mcpServers/agentDefinitions. */
  capabilityLibrary?: CapabilityLibrary;
  executionLogger?: ExecutionLogger;
  messageStore?: MessageStore;
  sessionManager?: SessionManager;
  ravenMcpDeps?: RavenMcpDeps;
  memoryStore?: MemoryStore;
}

export interface ApprovedActionParams {
  actionName: string;
  skillName: string;
  details?: string;
  sessionId?: string;
  /** True ONLY when a human has already approved this exact action via the
   * pending-approvals flow (api/routes/approvals.ts's resolveApproval,
   * callback-handler.ts's approval-resolution path) — NOT when a background
   * service is simply re-dispatching an action it decided on its own
   * (autonomous-manager.ts, ticktick-sync.ts, email-triage.ts, etc.).
   * Defaults to false. Only when true does executeAction mark the synthetic
   * task's `approvedActionName`, which is what lets agent-session.ts's
   * pre-check gate and the canUseTool tool-policy skip re-resolving the
   * action's tier. Leaving this false (the default) means the call re-enters
   * enforcePermissionGate exactly like any other actionName-bearing task —
   * a red-tier action queues for approval instead of running ungated. */
  preApproved?: boolean;
}

export interface ActiveTaskInfo {
  taskId: string;
  skillName: string;
  actionName?: string;
  sessionId?: string;
  projectId?: string;
  priority: string;
  status: string;
  startedAt?: number;
  createdAt: number;
  durationMs?: number;
  namedAgentId?: string;
}

export class AgentManager {
  private queue: AgentTask[] = [];
  private running = new Map<string, Promise<void>>();
  private queuedFinalizers = new Map<string, Promise<void>>();
  // sessionIds with a currently-running task — checked by processQueue so a
  // second chat turn for the same Raven session never gets admitted while
  // the first is still in flight (both would `claude --resume <same id>`
  // concurrently; last-write-wins linkSdkSession would corrupt continuity).
  // Populated/cleared in admitTask, synchronously with running.set/delete.
  private runningSessionIds = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  private taskMeta = new Map<string, AgentTask>();
  private maxConcurrent: number;
  private eventBus: EventBus;
  private capabilityLibrary?: CapabilityLibrary;
  private permissionDeps?: PermissionDeps;
  private executionLogger?: ExecutionLogger;
  private messageStore?: MessageStore;
  private sessionManager?: SessionManager;
  private ravenMcpDeps?: RavenMcpDeps;
  private memoryStore?: MemoryStore;
  private accepting = true;
  private stopping?: Promise<void>;
  private completions = new Map<string, () => void>();
  private readonly requestHandler = (event: AgentTaskRequestEvent): void => {
    this.enqueue(event.payload);
  };

  constructor(deps: AgentManagerDeps) {
    this.eventBus = deps.eventBus;
    this.capabilityLibrary = deps.capabilityLibrary;
    this.executionLogger = deps.executionLogger;
    this.messageStore = deps.messageStore;
    this.sessionManager = deps.sessionManager;
    this.ravenMcpDeps = deps.ravenMcpDeps;
    this.memoryStore = deps.memoryStore;
    if (deps.permissionEngine && deps.auditLog && deps.pendingApprovals) {
      this.permissionDeps = {
        permissionEngine: deps.permissionEngine,
        auditLog: deps.auditLog,
        pendingApprovals: deps.pendingApprovals,
        capabilityLibrary: deps.capabilityLibrary,
      };
    }
    this.maxConcurrent = getConfig().RAVEN_MAX_CONCURRENT_AGENTS;

    this.eventBus.on('agent:task:request', this.requestHandler);
  }

  private rejectTaskRequest(payload: AgentTaskRequestEvent['payload'], error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    // Report rejected admission without mutating sessions/history or retrying.
    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: payload.projectId,
      type: 'agent:task:complete',
      payload: {
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        skillName: payload.skillName,
        result: '',
        durationMs: 0,
        success: false,
        blocked: true,
        errors: [reason],
      },
    });
  }

  private enqueue(payload: AgentTaskRequestEvent['payload']): void {
    if (!this.accepting) return;
    this.assertNewTaskId(payload.taskId);
    try {
      validateResolvedAgentExecutionSettings({ model: payload.model, maxTurns: payload.maxTurns });
    } catch (error) {
      this.rejectTaskRequest(payload, error);
      return;
    }
    const task: AgentTask = {
      id: payload.taskId,
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      skillName: payload.skillName,
      prompt: payload.prompt,
      status: 'queued',
      priority: payload.priority,
      mcpServers: payload.mcpServers,
      agentDefinitions: payload.agentDefinitions ?? {},
      plugins: payload.plugins,
      createdAt: Date.now(),
      actionName: payload.actionName,
      knowledgeContext: payload.knowledgeContext,
      projectContextChain: payload.projectContextChain,
      namedAgentInstructions: payload.namedAgentInstructions,
      systemAccessInstructions: payload.systemAccessInstructions,
      namedAgentId: payload.namedAgentId,
      model: payload.model,
      maxTurns: payload.maxTurns,
      bashAccess: payload.bashAccess,
      treeId: payload.treeId,
      executionTaskId: payload.executionTaskId,
      taskBoardContext: payload.taskBoardContext,
      internal: payload.internal,
    };

    this.queueTask(task);
  }

  private assertNewTaskId(taskId: string): void {
    if (
      this.running.has(taskId) ||
      this.queuedFinalizers.has(taskId) ||
      this.queue.some((queued) => queued.id === taskId)
    ) {
      throw new Error(`Agent task is already admitted: ${taskId}`);
    }
  }

  private queueTask(task: AgentTask): void {
    this.assertNewTaskId(task.id);
    // Insert by priority
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const idx = this.queue.findIndex(
      (t) => priorityOrder[t.priority] > priorityOrder[task.priority],
    );
    if (idx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(idx, 0, task);
    }

    log.info(`Task queued: ${task.id} (${task.skillName}, priority: ${task.priority})`);
    this.processQueue();
  }

  private static isValidatorTask(task: AgentTask): boolean {
    return task.internal === 'validator';
  }

  private admitTask(task: AgentTask): void {
    // Mark the session as occupied *before* runTask does any real work —
    // admitTask runs synchronously up to runTask's first await, so a second
    // processQueue call later in this same tick (e.g. from another admitted
    // task's turn through the loop) already sees this session as taken.
    if (task.sessionId) this.runningSessionIds.add(task.sessionId);
    const promise = this.runTask(task)
      .catch((error: unknown) => this.handleFinalizationFailure(task, error))
      .finally(() => {
        this.abortControllers.delete(task.id);
        this.taskMeta.delete(task.id);
        this.running.delete(task.id);
        if (task.sessionId) this.runningSessionIds.delete(task.sessionId);
        this.completions.get(task.id)?.();
        this.completions.delete(task.id);
        this.processQueue();
      });
    // Keep unexpected persistence/listener errors observable without an unhandled rejection.
    void promise.catch((err: unknown) =>
      log.error(`Task ${task.id} failed during finalization: ${err}`),
    );
    this.running.set(task.id, promise);
  }

  // Validator headroom: complete_task's handler awaits validation while
  // holding a running slot, so at maxConcurrent saturation the evaluator/
  // quality-reviewer would queue behind the very task it's validating and
  // starve until it times out. Admit validator tasks regardless of the
  // concurrency cap so they never starve behind normal task traffic.
  // (Validator tasks never carry sessionId — see agent-session.ts's resume
  // comment — so they never collide with the session-skip pass below.)
  private admitValidatorTasks(): void {
    let validatorIdx = this.queue.findIndex((t) => AgentManager.isValidatorTask(t));
    while (validatorIdx !== -1) {
      const task = this.queue.splice(validatorIdx, 1)[0];
      this.admitTask(task);
      validatorIdx = this.queue.findIndex((t) => AgentManager.isValidatorTask(t));
    }
  }

  // Serialize chat turns per session (F1): two tasks sharing a sessionId
  // must never run concurrently — both would `claude --resume <same id>` at
  // once, and the last one to finish would win the race to
  // linkSdkSession, corrupting continuity. A task whose session is already
  // running is skipped in place (left queued) rather than removed, and —
  // critically — skipping it must not stop *other*, admissible tasks
  // further back in the queue from being admitted. We walk the queue by
  // index: admitting a task splices it out (so the next item shifts into
  // the same index and gets examined next iteration); skipping one only
  // advances the index. Either branch strictly shrinks "queue.length -
  // idx", so the loop always terminates.
  private admitFromQueue(): void {
    let idx = 0;
    while (this.running.size < this.maxConcurrent && idx < this.queue.length) {
      const task = this.queue[idx];
      if (task.sessionId && this.runningSessionIds.has(task.sessionId)) {
        idx++;
        continue;
      }
      this.queue.splice(idx, 1);
      this.admitTask(task);
    }
  }

  private processQueue(): void {
    if (!this.accepting) return;
    this.admitValidatorTasks();
    this.admitFromQueue();
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- core agent task runner with many state transitions
  private async runTask(task: AgentTask): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    this.taskMeta.set(task.id, task);
    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    await this.executionLogger?.logTaskStart(task);
    if (abortController.signal.aborted) {
      this.markTaskCancelled(task);
      await this.persistCancellation(task, true);
      return;
    }
    if (task.sessionId) this.sessionManager?.updateStatus(task.sessionId, 'running');

    const thinkingContent = `Starting ${task.skillName} agent...`;

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:message',
      payload: {
        taskId: task.id,
        sessionId: task.sessionId,
        messageType: 'thinking',
        content: thinkingContent,
      },
    });

    if (task.sessionId && this.messageStore) {
      this.messageStore.appendMessage(task.sessionId, {
        role: 'thinking',
        content: thinkingContent,
        taskId: task.id,
      });
    }

    // Store context references in session transcript for frontend visibility
    if (task.knowledgeContext && task.sessionId && this.messageStore) {
      this.messageStore.appendMessage(task.sessionId, {
        role: 'context',
        content: task.knowledgeContext,
        taskId: task.id,
      });
    }

    const result = await runAgentTask({
      task,
      eventBus: this.eventBus,
      mcpServers: task.mcpServers,
      agentDefinitions: task.agentDefinitions,
      plugins: task.plugins,
      actionName: task.actionName,
      permissionDeps: this.permissionDeps,
      messageStore: this.messageStore,
      signal: abortController.signal,
      ravenMcpDeps: this.ravenMcpDeps,
      memoryStore: this.memoryStore,
      sessionManager: this.sessionManager,
      model: task.model,
      maxTurns: task.maxTurns,
    });

    this.abortControllers.delete(task.id);

    const isCancelled = result.errors?.includes('cancelled');
    task.status = isCancelled
      ? 'cancelled'
      : result.blocked
        ? 'blocked'
        : result.success
          ? 'completed'
          : 'failed';
    task.result = result.result;
    task.durationMs = result.durationMs;
    task.errors = result.errors;
    task.completedAt = Date.now();
    await this.executionLogger?.logTaskComplete(task);

    // Update session: increment turn count and set status back to idle
    if (task.sessionId && this.sessionManager) {
      this.sessionManager.incrementTurnCount(task.sessionId);
      this.sessionManager.updateStatus(task.sessionId, 'idle');
    }

    if (!result.success && !result.blocked && !isCancelled) {
      this.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'agent-manager',
        type: 'system:health:alert',
        payload: {
          severity: 'error' as const,
          source: 'agent-manager',
          message: `Task ${task.id} failed: ${result.errors?.join(', ') ?? 'unknown error'}`,
          taskId: task.id,
        },
      });
    }

    this.emitTaskComplete(task, result.sdkSessionId);

    log.info(
      `Task completed: ${task.id} (${result.success ? 'success' : 'failed'}, ${result.durationMs}ms)`,
    );
  }

  cancelTask(taskId: string): boolean {
    // Check queued tasks first
    const queueIdx = this.queue.findIndex((t) => t.id === taskId);
    if (queueIdx !== -1) {
      const task = this.queue.splice(queueIdx, 1)[0];
      this.markTaskCancelled(task);
      const finishing = this.persistCancellation(task)
        .catch((error: unknown) => this.handleFinalizationFailure(task, error))
        .finally(() => {
          this.queuedFinalizers.delete(task.id);
          this.completions.get(task.id)?.();
          this.completions.delete(task.id);
        });
      this.queuedFinalizers.set(task.id, finishing);
      void finishing.catch((error: unknown) =>
        log.error(`Cancellation finalization failed: ${String(error)}`),
      );
      return true;
    }

    // Check running tasks
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      log.info(`Cancelling running task: ${taskId}`);
      return true;
    }

    return false;
  }

  private markTaskCancelled(task: AgentTask): void {
    task.status = 'cancelled';
    task.completedAt = Date.now();
    task.errors = ['cancelled'];
    task.result = '';
    task.durationMs = 0;
  }

  private async persistCancellation(task: AgentTask, ownsSession = false): Promise<void> {
    await this.executionLogger?.logTaskComplete(task);
    if (task.sessionId && (ownsSession || !this.runningSessionIds.has(task.sessionId))) {
      this.sessionManager?.updateStatus(task.sessionId, 'idle');
    }
    log.info(`Cancelled task before dispatch: ${task.id}`);
    this.emitTaskComplete(task);
  }

  private emitTaskComplete(task: AgentTask, sdkSessionId?: string): void {
    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:task:complete',
      payload: {
        taskId: task.id,
        sessionId: task.sessionId,
        sdkSessionId,
        skillName: task.skillName,
        result: task.result ?? '',
        durationMs: task.durationMs ?? 0,
        success: task.status === 'completed',
        errors: task.errors,
        blocked: task.status === 'blocked',
        cancelled: task.status === 'cancelled',
      },
    });
  }

  private handleFinalizationFailure(task: AgentTask, error: unknown): void {
    const message = `Agent run finalization failed; durable outcome is unresolved: ${error instanceof Error ? error.message : String(error)}`;
    // A completed side effect may already exist. Block automatic retries and
    // report the failure; never overwrite a conflicting history file to hide it.
    if (task.status !== 'cancelled') task.status = 'blocked';
    task.errors = [...(task.errors ?? []), message];
    task.completedAt = Date.now();
    log.error(`Task ${task.id}: ${message}`);
    if (
      task.sessionId &&
      (this.taskMeta.has(task.id) || !this.runningSessionIds.has(task.sessionId))
    ) {
      try {
        this.sessionManager?.updateStatus(task.sessionId, 'idle');
      } catch (sessionError) {
        log.error(`Task ${task.id} session finalization failed: ${String(sessionError)}`);
      }
    }
    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'system:health:alert',
      payload: { severity: 'error', source: 'agent-manager', message, taskId: task.id },
    });
    this.emitTaskComplete(task);
  }

  getActiveTasks(): { running: ActiveTaskInfo[]; queued: ActiveTaskInfo[] } {
    const now = Date.now();
    const running: ActiveTaskInfo[] = [];
    for (const task of this.taskMeta.values()) {
      if (this.running.has(task.id)) {
        running.push({
          taskId: task.id,
          skillName: task.skillName,
          actionName: task.actionName,
          sessionId: task.sessionId,
          projectId: task.projectId,
          priority: task.priority,
          status: task.status === 'running' ? 'running' : 'finalizing',
          startedAt: task.startedAt,
          createdAt: task.createdAt,
          durationMs: task.startedAt ? now - task.startedAt : undefined,
          namedAgentId: task.namedAgentId,
        });
      }
    }
    const queued: ActiveTaskInfo[] = this.queue.map((task) => ({
      taskId: task.id,
      skillName: task.skillName,
      actionName: task.actionName,
      sessionId: task.sessionId,
      projectId: task.projectId,
      priority: task.priority,
      status: task.status,
      createdAt: task.createdAt,
      namedAgentId: task.namedAgentId,
    }));
    return { running, queued };
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  /** Stop admission synchronously, then settle every queued/running task while stores are open. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    this.eventBus.off('agent:task:request', this.requestHandler);
    for (const task of [...this.queue]) this.cancelTask(task.id);
    for (const controller of this.abortControllers.values()) controller.abort();
    this.stopping = this.drainFinalizers();
    return this.stopping;
  }

  private async drainFinalizers(): Promise<void> {
    while (this.running.size > 0 || this.queuedFinalizers.size > 0) {
      await Promise.allSettled([...this.running.values(), ...this.queuedFinalizers.values()]);
    }
  }

  private resolveActionProject(sessionId?: string): string | undefined {
    if (sessionId === undefined) return undefined;
    if (!this.sessionManager) throw new Error('Session manager is unavailable');
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const target = validateChatTarget(this.sessionManager, session.projectId, {
      sessionId,
      projectRegistry: this.ravenMcpDeps?.projectRegistry,
    });
    if (!target.ok) throw new Error(target.error);
    return session.projectId;
  }

  private buildActionTask(params: ApprovedActionParams): AgentTask {
    const projectId = this.resolveActionProject(params.sessionId);
    if (!this.capabilityLibrary) {
      throw new Error(`Skill "${params.skillName}" requires a capability library`);
    }
    const capabilities = resolveSkillCapabilities(this.capabilityLibrary, [params.skillName]);
    return {
      id: generateId(),
      sessionId: params.sessionId,
      projectId,
      skillName: params.skillName,
      prompt: `Execute ${params.preApproved ? 'approved ' : ''}action: ${params.actionName}. Context: ${params.details ?? 'none'}`,
      status: 'queued',
      priority: 'high',
      ...capabilities,
      createdAt: Date.now(),
      actionName: params.actionName,
      // Only set when a human already approved exactly this action via the
      // pending-approvals flow (params.preApproved === true — see
      // api/routes/approvals.ts's resolveApproval and callback-handler.ts's
      // approval-resolution path). Marking it lets agent-session.ts's
      // pre-check gate and the canUseTool policy both treat this re-dispatch
      // as pre-approved instead of re-resolving the same (still red) tier and
      // queuing it for approval again. Background/service call sites that
      // never had human approval (autonomous-manager.ts, ticktick-sync.ts,
      // email-triage.ts, etc.) must NOT set preApproved, so their actions
      // keep re-entering enforcePermissionGate/tool-policy like any other
      // actionName-bearing task.
      approvedActionName: params.preApproved === true ? params.actionName : undefined,
    };
  }

  async executeAction(
    params: ApprovedActionParams,
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    if (!this.accepting) return { success: false, error: 'Agent manager is stopping' };
    let task: AgentTask;
    try {
      task = this.buildActionTask(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Action admission failed for "${params.actionName}": ${message}`);
      return { success: false, error: message };
    }

    const completion = new Promise<void>((resolve) => this.completions.set(task.id, resolve));
    this.queueTask(task);
    await completion;

    return {
      success: task.status === 'completed',
      result: task.result,
      error:
        task.status !== 'completed'
          ? (task.errors?.join(', ') ?? 'Task did not complete successfully')
          : undefined,
    };
  }
}
