import { createLogger, generateId } from '@raven/shared';
import type {
  AgentTaskRequestEvent,
  AgentTaskCompleteEvent,
  ExecutionTaskRunAgentEvent,
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
}

export interface ExecutionBridge {
  start(): void;
  stop(): void;
}

type RunAgentPayload = ExecutionTaskRunAgentEvent['payload'];
type CompletePayload = AgentTaskCompleteEvent['payload'];

function resolveAgent(deps: ExecutionBridgeDeps, agentName?: string): NamedAgent {
  const named = agentName
    ? (deps.namedAgentStore.getAgentByName(agentName) ?? deps.namedAgentStore.getAgent(agentName))
    : undefined;
  if (agentName && !named) {
    log.warn(`Template names unknown agent '${agentName}', using default agent`);
  }
  return named ?? deps.namedAgentStore.getDefaultAgent();
}

function buildAgentTaskRequest(
  deps: ExecutionBridgeDeps,
  payload: RunAgentPayload,
): AgentTaskRequestEvent {
  const agent = resolveAgent(deps, payload.agent);
  const capabilities = deps.agentResolver.resolveAgentCapabilities(agent);
  return {
    id: generateId(),
    timestamp: Date.now(),
    source: 'execution-bridge',
    type: 'agent:task:request',
    payload: {
      taskId: payload.taskId,
      prompt: payload.retryFeedback
        ? buildRetryPrompt(
            payload.prompt,
            payload.retryFeedback,
            payload.retryCount ?? DEFAULT_RETRY_ATTEMPT,
          )
        : payload.prompt,
      skillName: agent.name,
      mcpServers: capabilities.mcpServers,
      agentDefinitions: capabilities.agentDefinitions,
      plugins: capabilities.plugins,
      namedAgentId: agent.id,
      priority: 'normal',
      projectId: payload.projectId,
      treeId: payload.treeId,
      executionTaskId: payload.taskId,
      taskBoardContext: buildTaskBoardInstructions(payload.parentTaskId, payload.retryFeedback),
    },
  };
}

/**
 * Drives the tree forward from an `agent:task:complete` event, unless the
 * model already completed/blocked the task itself via the raven MCP
 * `complete_task`/`fail_task` tools — in which case the tree task is no
 * longer `in_progress` and this is a no-op (the model's own completion wins).
 */
function advanceTree(
  deps: ExecutionBridgeDeps,
  entry: { treeId: string; taskId: string },
  payload: CompletePayload,
): void {
  const tree = deps.executionEngine.getTree(entry.treeId);
  const task = tree?.tasks.get(entry.taskId);
  if (!task || task.status !== 'in_progress') return;

  if (payload.success) {
    deps.executionEngine
      .onTaskCompleted({
        treeId: entry.treeId,
        taskId: entry.taskId,
        summary: payload.result,
        artifacts: [],
      })
      .catch((err: unknown) => log.error(`onTaskCompleted failed for ${entry.taskId}: ${err}`));
  } else {
    deps.executionEngine.onTaskBlocked(
      entry.treeId,
      entry.taskId,
      payload.errors?.join('; ') ?? 'agent task failed',
    );
  }
}

/**
 * Runtime-owned task completion bridge.
 *
 * The task-execution engine emits `execution:task:run-agent` when a tree
 * task is ready to run; this bridge resolves the template's named `agent`
 * (falling back to the default agent) to its capabilities and forwards a
 * real `agent:task:request` to the agent manager. It then listens for
 * `agent:task:complete` and drives `onTaskCompleted`/`onTaskBlocked` on
 * the engine itself — the runtime advances the tree instead of relying
 * solely on the model calling `complete_task` via the raven MCP.
 */
export function createExecutionBridge(deps: ExecutionBridgeDeps): ExecutionBridge {
  // agent-task id -> tree coordinates; in-memory is acceptable: an orphaned
  // entry only means the tree waits for the next manual retry
  const pending = new Map<string, { treeId: string; taskId: string }>();

  const onRunAgent = (event: ExecutionTaskRunAgentEvent): void => {
    const payload = event.payload;
    pending.set(payload.taskId, { treeId: payload.treeId, taskId: payload.taskId });
    deps.eventBus.emit(buildAgentTaskRequest(deps, payload));
  };

  const onComplete = (event: AgentTaskCompleteEvent): void => {
    const entry = pending.get(event.payload.taskId);
    if (!entry) return;
    pending.delete(event.payload.taskId);
    advanceTree(deps, entry, event.payload);
  };

  return {
    start(): void {
      deps.eventBus.on<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
    },
    stop(): void {
      deps.eventBus.off<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.off<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
    },
  };
}
