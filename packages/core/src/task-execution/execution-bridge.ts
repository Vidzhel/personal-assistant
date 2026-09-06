import { createLogger, generateId } from '@raven/shared';
import type {
  AgentTaskRequestEvent,
  AgentTaskCompleteEvent,
  ExecutionTaskRunAgentEvent,
  ExecutionTreeCancelledEvent,
  ExecutionTreeCompletedEvent,
  NamedAgent,
  SubAgentDefinition,
  ModelConfig,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { TaskExecutionEngine } from './task-execution-engine.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { AgentResolver, ResolvedCapabilities } from '../agent-registry/agent-resolver.ts';
import { resolveAgentExecutionSettings } from '../agent-registry/agent-resolver.ts';
import { getConfig } from '../config.ts';
import type { ModelCatalog } from '../agent-registry/model-catalog.ts';
import { resolveModelConfig, MODEL_ALIAS_IDS } from '../agent-registry/model-settings.ts';
import { captureNestedModelSettings } from '../agent-registry/conversation-models.ts';
import { buildRetryPrompt } from './validation-pipeline.ts';
import { buildTaskBoardInstructions } from './task-board-protocol.ts';

const log = createLogger('execution-bridge');

const DEFAULT_RETRY_ATTEMPT = 1;

class ExecutionCapabilityUnavailableError extends Error {}

export interface ExecutionBridgeDeps {
  modelCatalog?: ModelCatalog;
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

function resolveAgent(deps: ExecutionBridgeDeps, payload: RunAgentPayload): NamedAgent {
  const { agent: agentName, projectId } = payload;
  const named = agentName ? deps.namedAgentStore.getAgentByName(agentName, projectId) : undefined;
  if (agentName && !named) {
    throw new Error(`Template names unknown agent '${agentName}'`);
  }
  return named ?? deps.namedAgentStore.getDefaultAgent(projectId);
}

function assertExecutionCapabilitiesAvailable(
  agent: NamedAgent,
  capabilities: ResolvedCapabilities,
): void {
  const unavailableSkills = new Set(capabilities.unavailableSkills ?? []);
  if (
    !capabilities.unavailableMcpServers?.length ||
    agent.skills.length === 0 ||
    !agent.skills.every((name) => unavailableSkills.has(name))
  ) {
    return;
  }
  throw new ExecutionCapabilityUnavailableError(
    `Agent "${agent.name}" has unavailable MCP integration: ${capabilities.unavailableMcpServers.join(', ')}`,
  );
}

async function captureExecutionModels(
  deps: ExecutionBridgeDeps,
  agent: NamedAgent,
  definitions: Record<string, SubAgentDefinition>,
): Promise<{
  modelConfig: ModelConfig & { model: string };
  agentDefinitions: Record<string, SubAgentDefinition>;
}> {
  const catalog = deps.modelCatalog;
  const requiresMetadata =
    (agent.model && !(agent.model in MODEL_ALIAS_IDS)) ||
    Object.values(definitions).some(
      (worker) =>
        worker.effort ||
        (worker.model && worker.model !== 'inherit' && !(worker.model in MODEL_ALIAS_IDS)),
    );
  if (catalog && !catalog.getSnapshot().models.length && requiresMetadata) {
    const refreshed = await catalog.refresh();
    if (!refreshed.models.length)
      throw new Error('Model catalog unavailable for explicit agent settings');
  }
  const snapshot = catalog?.getSnapshot() ?? {
    models: [],
    fetchedAt: null,
    revision: 0,
    stale: true,
    error: null,
  };
  const resolved = resolveModelConfig(
    {
      agent: agent.model ? { model: agent.model } : undefined,
      defaults: { model: getConfig().CLAUDE_MODEL },
    },
    snapshot,
  );
  const modelConfig = {
    model: resolved.model,
    effort: resolved.effort,
    thinking: resolved.thinking,
  };
  const agentDefinitions = captureNestedModelSettings(definitions, modelConfig, snapshot);
  return { modelConfig, agentDefinitions };
}

function agentPrompt(agent: NamedAgent, payload: RunAgentPayload): string {
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
  return agent.instructions
    ? `[Agent Instructions: ${agent.instructions}]\n\n${basePrompt}`
    : basePrompt;
}

async function buildAgentTaskRequest(
  deps: ExecutionBridgeDeps,
  payload: RunAgentPayload,
  agentTaskId: string,
): Promise<AgentTaskRequestEvent> {
  const agent = resolveAgent(deps, payload);
  const capabilities = deps.agentResolver.resolveAgentCapabilities(agent);
  assertExecutionCapabilitiesAvailable(agent, capabilities);
  const executionSettings = resolveAgentExecutionSettings({
    model: agent.model,
    maxTurns: agent.maxTurns,
    defaults: {
      model: getConfig().CLAUDE_MODEL,
      maxTurns: getConfig().RAVEN_AGENT_MAX_TURNS,
    },
  });
  const { modelConfig, agentDefinitions } = await captureExecutionModels(
    deps,
    agent,
    capabilities.agentDefinitions,
  );
  const prompt = agentPrompt(agent, payload);
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
      agentDefinitions,
      plugins: capabilities.plugins,
      namedAgentId: agent.id,
      namedAgentRevision: agent.definitionRevision,
      model: modelConfig.model,
      modelConfig,
      maxTurns: executionSettings.maxTurns,
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
      agentTaskId: entry.agentTaskId,
      summary: payload.result,
      artifacts: [],
    })
    .catch((err: unknown) => log.error(`onTaskCompleted failed for ${entry.taskId}: ${err}`));
}

async function handleTaskFailure(
  deps: ExecutionBridgeDeps,
  entry: PendingEntry,
  payload: CompletePayload,
): Promise<void> {
  const reason = payload.errors?.join('; ');
  if (payload.cancelled) {
    // Cancellation is terminal and must never enter the retry ladder — check
    // this before blocked/failed so a cancelled task can't be misread as a
    // retryable failure or an approval-pending block.
    await deps.executionEngine.onTaskCancelled(entry.treeId, entry.taskId, entry.agentTaskId);
    return;
  }
  if (payload.blocked) {
    await deps.executionEngine.onTaskBlocked(entry.treeId, entry.taskId, {
      reason: reason ?? 'agent task blocked pending approval',
      agentTaskId: entry.agentTaskId,
    });
    return;
  }
  await deps.executionEngine.onTaskFailed(entry.treeId, entry.taskId, {
    reason: reason ?? 'agent task failed',
    agentTaskId: entry.agentTaskId,
  });
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

  if (payload.success && !payload.cancelled && !payload.blocked) {
    handleTaskSuccess(deps, entry, payload);
  } else {
    void handleTaskFailure(deps, entry, payload).catch((error: unknown) =>
      log.error(`Task failure transition failed for ${entry.taskId}: ${String(error)}`),
    );
  }
}

function cancelPending(
  deps: ExecutionBridgeDeps,
  pending: Map<string, PendingEntry>,
  treeId?: string,
): void {
  for (const [id, entry] of pending) {
    if (treeId !== undefined && entry.treeId !== treeId) continue;
    pending.delete(id);
    deps.cancelAgentTask?.(id);
  }
}

interface BridgeState {
  pending: Map<string, PendingEntry>;
  started: boolean;
  generation: number;
}

function isBoundAttempt(deps: ExecutionBridgeDeps, entry: PendingEntry): boolean {
  const tree = deps.executionEngine.getTree(entry.treeId);
  const task = tree?.tasks.get(entry.taskId);
  return (
    tree?.status === 'running' &&
    task?.status === 'in_progress' &&
    task.agentTaskId === entry.agentTaskId
  );
}

function isCurrentGeneration(state: BridgeState, generation: number): boolean {
  return state.started && state.generation === generation;
}

async function dispatchAgent(
  deps: ExecutionBridgeDeps,
  payload: RunAgentPayload,
  state: BridgeState,
): Promise<void> {
  const generation = state.generation;
  const agentTaskId = generateId();
  let request: AgentTaskRequestEvent;
  try {
    request = await buildAgentTaskRequest(deps, payload, agentTaskId);
  } catch (error) {
    if (!isCurrentGeneration(state, generation)) return;
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ExecutionCapabilityUnavailableError) {
      await deps.executionEngine.onTaskBlocked(
        payload.treeId,
        payload.taskId,
        `Agent capability unavailable: ${reason}`,
      );
      return;
    }
    await deps.executionEngine.onTaskFailed(
      payload.treeId,
      payload.taskId,
      `Agent resolution failed: ${reason}`,
    );
    return;
  }
  if (!isCurrentGeneration(state, generation)) return;
  if (!(await deps.executionEngine.setAgentTaskId(payload.treeId, payload.taskId, agentTaskId)))
    return;
  if (!isCurrentGeneration(state, generation)) return;
  const entry = { treeId: payload.treeId, taskId: payload.taskId, agentTaskId };
  if (!isBoundAttempt(deps, entry)) return;
  state.pending.set(agentTaskId, entry);
  deps.eventBus.emit(request);
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
  const state: BridgeState = { pending: new Map(), started: false, generation: 0 };
  const onRunAgent = (event: ExecutionTaskRunAgentEvent): void => {
    void dispatchAgent(deps, event.payload, state).catch((error: unknown) =>
      log.error(`Agent dispatch failed for ${event.payload.taskId}: ${String(error)}`),
    );
  };

  const onComplete = (event: AgentTaskCompleteEvent): void => {
    const entry = state.pending.get(event.payload.taskId);
    if (!entry) return;
    state.pending.delete(event.payload.taskId);
    advanceTree(deps, entry, event.payload);
  };

  const onTreeCancelled = (event: ExecutionTreeCancelledEvent): void => {
    cancelPending(deps, state.pending, event.payload.treeId);
  };

  const onTreeCompleted = (event: ExecutionTreeCompletedEvent): void => {
    if (event.payload.status === 'failed') cancelPending(deps, state.pending, event.payload.treeId);
  };

  return {
    start(): void {
      if (state.started) return;
      state.started = true;
      state.generation += 1;
      deps.eventBus.on<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
      deps.eventBus.on<ExecutionTreeCancelledEvent>('execution:tree:cancelled', onTreeCancelled);
      deps.eventBus.on<ExecutionTreeCompletedEvent>('execution:tree:completed', onTreeCompleted);
    },
    stop(): void {
      if (!state.started) return;
      state.started = false;
      state.generation += 1;
      deps.eventBus.off<ExecutionTaskRunAgentEvent>('execution:task:run-agent', onRunAgent);
      deps.eventBus.off<AgentTaskCompleteEvent>('agent:task:complete', onComplete);
      deps.eventBus.off<ExecutionTreeCancelledEvent>('execution:tree:cancelled', onTreeCancelled);
      deps.eventBus.off<ExecutionTreeCompletedEvent>('execution:tree:completed', onTreeCompleted);
      cancelPending(deps, state.pending);
    },
  };
}
