import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, AgentTaskRequestEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { McpManager } from '../mcp-manager/mcp-manager.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { ExecutionLogger } from './execution-logger.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { PermissionDeps } from './agent-session.ts';
import { runAgentTask } from './agent-session.ts';
import { getConfig } from '../config.ts';

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
  mcpManager: McpManager;
  suiteRegistry: SuiteRegistry;
  permissionEngine?: PermissionEngine;
  auditLog?: AuditLog;
  pendingApprovals?: PendingApprovals;
  executionLogger?: ExecutionLogger;
  messageStore?: MessageStore;
  sessionManager?: SessionManager;
}

export interface ApprovedActionParams {
  actionName: string;
  skillName: string;
  details?: string;
  sessionId?: string;
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
  private abortControllers = new Map<string, AbortController>();
  private taskMeta = new Map<string, AgentTask>();
  private maxConcurrent: number;
  private eventBus: EventBus;
  private mcpManager: McpManager;
  private suiteRegistry: SuiteRegistry;
  private permissionDeps?: PermissionDeps;
  private executionLogger?: ExecutionLogger;
  private messageStore?: MessageStore;
  private sessionManager?: SessionManager;

  constructor(deps: AgentManagerDeps) {
    this.eventBus = deps.eventBus;
    this.mcpManager = deps.mcpManager;
    this.suiteRegistry = deps.suiteRegistry;
    this.executionLogger = deps.executionLogger;
    this.messageStore = deps.messageStore;
    this.sessionManager = deps.sessionManager;
    if (deps.permissionEngine && deps.auditLog && deps.pendingApprovals) {
      this.permissionDeps = {
        permissionEngine: deps.permissionEngine,
        auditLog: deps.auditLog,
        pendingApprovals: deps.pendingApprovals,
      };
    }
    this.maxConcurrent = getConfig().RAVEN_MAX_CONCURRENT_AGENTS;

    this.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      this.enqueue(event.payload);
    });
  }

  private enqueue(payload: AgentTaskRequestEvent['payload']): void {
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
      createdAt: Date.now(),
      actionName: payload.actionName,
      knowledgeContext: payload.knowledgeContext,
      sessionReferencesContext: payload.sessionReferencesContext,
      namedAgentId: payload.namedAgentId,
    };

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

  private processQueue(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      const promise = this.runTask(task).finally(() => {
        this.running.delete(task.id);
        this.processQueue();
      });
      this.running.set(task.id, promise);
    }
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- core agent task runner with many state transitions
  private async runTask(task: AgentTask): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    this.taskMeta.set(task.id, task);
    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    this.executionLogger?.logTaskStart(task);

    const thinkingContent = `Starting ${task.skillName} agent...`;

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:message',
      payload: {
        taskId: task.id,
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
      actionName: task.actionName,
      permissionDeps: this.permissionDeps,
      messageStore: this.messageStore,
      signal: abortController.signal,
    });

    this.abortControllers.delete(task.id);
    this.taskMeta.delete(task.id);

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
    this.executionLogger?.logTaskComplete(task);

    // Update session: increment turn count and set status back to idle
    if (task.sessionId && this.sessionManager) {
      this.sessionManager.incrementTurnCount(task.sessionId);
      this.sessionManager.updateStatus(task.sessionId, 'idle');
    }

    if (!result.success && !result.blocked) {
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

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:task:complete',
      payload: {
        taskId: task.id,
        sessionId: result.sdkSessionId,
        result: result.result,
        durationMs: result.durationMs,
        success: result.success,
        errors: result.errors,
      },
    });

    log.info(
      `Task completed: ${task.id} (${result.success ? 'success' : 'failed'}, ${result.durationMs}ms)`,
    );
  }

  cancelTask(taskId: string): boolean {
    // Check queued tasks first
    const queueIdx = this.queue.findIndex((t) => t.id === taskId);
    if (queueIdx !== -1) {
      const task = this.queue.splice(queueIdx, 1)[0];
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.executionLogger?.logTaskComplete(task);
      log.info(`Cancelled queued task: ${taskId}`);
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

  getActiveTasks(): { running: ActiveTaskInfo[]; queued: ActiveTaskInfo[] } {
    const now = Date.now();
    const running: ActiveTaskInfo[] = [];
    for (const task of this.taskMeta.values()) {
      if (task.status === 'running') {
        running.push({
          taskId: task.id,
          skillName: task.skillName,
          actionName: task.actionName,
          sessionId: task.sessionId,
          projectId: task.projectId,
          priority: task.priority,
          status: task.status,
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

  async executeApprovedAction(
    params: ApprovedActionParams,
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    const mcpServers = this.mcpManager.resolveForSuite(params.skillName);
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions([params.skillName]);

    const task: AgentTask = {
      id: generateId(),
      sessionId: params.sessionId,
      skillName: params.skillName,
      prompt: `Execute approved action: ${params.actionName}. Context: ${params.details ?? 'none'}`,
      status: 'queued',
      priority: 'high',
      mcpServers,
      agentDefinitions,
      createdAt: Date.now(),
      actionName: params.actionName,
    };

    await this.runTask(task);

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
