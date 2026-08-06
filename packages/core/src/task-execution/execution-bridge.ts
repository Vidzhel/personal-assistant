import { createLogger, generateId } from '@raven/shared';
import type {
  AgentTaskRequestEvent,
  AgentTaskCompleteEvent,
  ExecutionTaskRunAgentEvent,
  ExecutionTreeCancelledEvent,
  NamedAgent,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { TaskExecutionEngine } from './task-execution-engine.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { AgentResolver } from '../agent-registry/agent-resolver.ts';
import { buildRetryPrompt } from './validation-pipeline.ts';
import { buildTaskBoardInstructions } from './task-board-protocol.ts';

const log = createLogger('execution-bridge');

const DEFAULT_RETRY_ATTEMPT = 1;

export interface ExecutionBridgeDeps {
  eventBus: EventBus;
  executionEngine: TaskExecutionEngine;
  namedAgentStore: NamedAgentStore;
  agentResolver: AgentResolver;
  /** Cancels an in-flight agent-manager task by its agentTaskId. Wired to
   * agentManager.cancelTask so execution:tree:cancelled can abort in-flight
   * agent runs instead of leaving them orphaned. */
  cancelAgentTask?: (agentTaskId: string) => boolean;
}

export interface ExecutionBridge {
  start(): void;
  stop(): void;
}

type RunAgentPayload = ExecutionTaskRunAgentEvent['payload'];
type CompletePayload = AgentTaskCompleteEvent['payload'];

interface PendingEntry {
  treeId: string;
  taskId: string;
  agentTaskId: string;
}

function resolveAgent(deps: ExecutionBridgeDeps, agentName?: string): NamedAgent {
  const named = agentName ? deps.namedAgentStore.getAgentByName(agentName) : undefined;
  if (agentName && !named) {
    log.warn(`Template names unknown agent '${agentName}', using default agent`);
  }
  return named ?? deps.namedAgentStore.getDefaultAgent();
}

function buildAgentTaskRequest(
  deps: ExecutionBridgeDeps,
  payload: RunAgentPayload,
  agentTaskId: string,
): AgentTaskRequestEvent {
  const agent = resolveAgent(deps, payload.agent);
  const capabilities = deps.agentResolver.resolveAgentCapabilities(agent);
  const basePrompt = payload.retryFeedback
    ? buildRetryPrompt(
        payload.prompt,
        payload.retryFeedback,
        payload.retryCount ?? DEFAULT_RETRY_ATTEMPT,
      )
    : payload.prompt;
  // Carry the resolved agent's persona into the dispatch the same way
  // orchestrator.ts does for chat turns (see handleUserChat) — the named
  // agent's own instructions outrank the generic template prompt.
  const prompt = agent.instructions
    ? `[Agent Instructions: ${agent.instructions}]\n\n${basePrompt}`
    : basePrompt;
  return {
    id: generateId(),
    timestamp: Date.now(),
    source: 'execution-bridge',
    type: 'agent:task:request',
    payload: {
      taskId: agentTaskId,
      prompt,
      skillName: agent.name,
      mcpServers: capabilities.mcpServers,
      agentDefinitions: capabilities.agentDefinitions,
      plugins: capabilities.plugins,
      namedAgentId: agent.id,
      bashAccess: agent.bash,
      priority: 'normal',
      projectId: payload.projectId,
      treeId: payload.treeId,
      executionTaskId: payload.taskId,
      // The retry feedback (if any) is already folded into `prompt` above via
      // buildRetryPrompt — don't have the task-board instructions embed it a
      // second time.
      taskBoardContext: buildTaskBoardInstructions(payload.parentTaskId),
    },
  };
}

function handleTaskSuccess(
  deps: ExecutionBridgeDeps,
  entry: PendingEntry,
  payload: CompletePayload,
): void {
  deps.executionEngine
    .onTaskCompleted({
      treeId: entry.treeId,
      taskId: entry.taskId,
      summary: payload.result,
      artifacts: [],
    })
    .catch((err: unknown) => log.error(`onTaskCompleted failed for ${entry.taskId}: ${err}`));
}

function handleTaskFailure(
  deps: ExecutionBridgeDeps,
  entry: PendingEntry,
  payload: CompletePayload,
): void {
  const reason = payload.errors?.join('; ');
  if (payload.cancelled) {
    // Cancellation is terminal and must never enter the retry ladder — check
    // this before blocked/failed so a cancelled task can't be misread as a
    // retryable failure or an approval-pending block.
    deps.executionEngine.onTaskCancelled(entry.treeId, entry.taskId);
    return;
  }
  if (payload.blocked) {
    deps.executionEngine.onTaskBlocked(
      entry.treeId,
      entry.taskId,
      reason ?? 'agent task blocked pending approval',
    );
    return;
  }
  deps.executionEngine.onTaskFailed(entry.treeId, entry.taskId, reason ?? 'agent task failed');
}

/**
 * Drives the tree forward from an `agent:task:complete` event, unless the
 * model already completed/blocked the task itself via the raven MCP
 * `complete_task`/`fail_task` tools — in which case the tree task is no
 * longer `in_progress` and this is a no-op (the model's own completion wins).
 */
function advanceTree(
  deps: ExecutionBridgeDeps,
  entry: PendingEntry,
  payload: CompletePayload,
): void {
  const tree = deps.executionEngine.getTree(entry.treeId);
  const task = tree?.tasks.get(entry.taskId);
  if (!task || task.status !== 'in_progress') return;

  // Stale completion from a superseded dispatch (e.g. a validation-triggered
  // retry already minted a new agentTaskId while this one was in flight) —
  // the current attempt owns the tree state, not this one.
  if (task.agentTaskId !== entry.agentTaskId) {
    log.debug(`Ignoring stale completion for task ${entry.taskId} (agentTaskId superseded)`);
    return;
  }

  if (payload.success) {
    handleTaskSuccess(deps, entry, payload);
  } else {
    handleTaskFailure(deps, entry, payload);
  }
}

/**
 * Runtime-owned task completion bridge.
 *
 * The task-execution engine emits `execution:task:run-agent` when a tree
 * task is ready to run; this bridge resolves the template's named `agent`
 * (falling back to the default agent) to its capabilities and forwards a
 * real `agent:task:request` to the agent manager. It then listens for
 * `agent:task:complete` and drives `onTaskCompleted`/`onTaskBlocked`/
 * `onTaskFailed` on the engine itself — the runtime advances the tree
 * instead of relying solely on the model calling `complete_task` via the
 * raven MCP.
 */
export function createExecutionBridge(deps: ExecutionBridgeDeps): ExecutionBridge {
  // agent-task id -> tree coordinates; in-memory is acceptable: an orphaned
  // entry only means the tree waits for the next manual retry
  const pending = new Map<string, PendingEntry>();

  const onRunAgent = (event: ExecutionTaskRunAgentEvent): void => {
    const payload = event.payload;
    const agentTaskId = generateId();

    let request: AgentTaskRequestEvent;
    try {
      request = buildAgentTaskRequest(deps, payload, agentTaskId);
    } catch (err) {
      // e.g. resolveAgent's getDefaultAgent() throws 'No default agent
      // configured' — never emit a request or register a pending entry for
      // a task we couldn't actually dispatch; route straight into the
      // failure/retry ladder instead.
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`Agent resolution failed for task ${payload.taskId}: ${reason}`);
      deps.executionEngine.onTaskFailed(
        payload.treeId,
        payload.taskId,
        `Agent resolution failed: ${reason}`,
      );
      return;
    }

    pending.set(agentTaskId, { treeId: payload.treeId, taskId: payload.taskId, agentTaskId });
    deps.executionEngine.setAgentTaskId(payload.treeId, payload.taskId, agentTaskId);
    deps.eventBus.emit(request);
  };

  const onComplete = (event: AgentTaskCompleteEvent): void => {
    const entry = pending.get(event.payload.taskId);
    if (!entry) return;
    pending.delete(event.payload.taskId);
    advanceTree(deps, entry, event.payload);
  };

  const onTreeCancelled = (event: ExecutionTreeCancelledEvent): void => {
    // Always drop this tree's pending entries — even when cancelAgentTask
    // isn't wired (e.g. some test doubles), a cancelled tree's tasks must
    // stop being tracked so a later completion for them can't advance it.
    for (const [agentTaskId, entry] of pending) {
      if (entry.treeId !== event.payload.treeId) continue;
      deps.cancelAgentTask?.(agentTaskId);
      pending.delete(agentTaskId);
    }
  };

  return {
    start(): void {
      deps.eventBus.on<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
      deps.eventBus.on<ExecutionTreeCancelledEvent>('execution:tree:cancelled', onTreeCancelled);
    },
    stop(): void {
      deps.eventBus.off<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.off<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
      deps.eventBus.off<ExecutionTreeCancelledEvent>('execution:tree:cancelled', onTreeCancelled);
    },
  };
}
