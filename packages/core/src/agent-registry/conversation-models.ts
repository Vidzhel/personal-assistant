import {
  MODEL_PRESET_ALIASES,
  type AgentSession,
  type ModelConfig,
  type ModelCatalogSnapshot,
  type SubAgentDefinition,
} from '@raven/shared';
import { getConfig } from '../config.ts';
import type { ProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { NamedAgentStore } from './yaml-named-agent-store.ts';
import type { ModelCatalog } from './model-catalog.ts';
import { resolveModelConfig } from './model-settings.ts';

export interface ConversationModelInput {
  projectId: string;
  sessionId?: string;
  turn?: ModelConfig;
  /** Present only when validating a prospective atomic settings replacement. */
  session?: ModelConfig | null;
  project?: ModelConfig | null;
  /** Capability definitions already resolved for this dispatch. */
  agentDefinitions?: Record<string, SubAgentDefinition>;
}

export type ConversationModelResolver = (input: ConversationModelInput) => ModelConfig & {
  model: string;
};
export type ConversationModelPreparation = (input: ConversationModelInput) => Promise<void>;

interface ConversationModelDeps {
  catalog: ModelCatalog;
  sessions: SessionManager;
  workspaces: ProjectWorkspaceStore;
  agents: NamedAgentStore;
}

function hasCapabilityControls(config?: ModelConfig): boolean {
  return config?.effort !== undefined || config?.thinking !== undefined;
}

function isPresetAlias(model: string): boolean {
  return MODEL_PRESET_ALIASES.includes(
    model.toLowerCase() as (typeof MODEL_PRESET_ALIASES)[number],
  );
}

function effectiveModelNeedsMetadata(configs: readonly (ModelConfig | undefined)[]): boolean {
  const model = configs.find((config) => config?.model !== undefined)?.model;
  return model !== undefined && !isPresetAlias(model);
}

function nestedDefinitionNeedsMetadata(definition: SubAgentDefinition): boolean {
  return (
    definition.effort !== undefined ||
    (definition.model !== undefined &&
      definition.model !== 'inherit' &&
      !isPresetAlias(definition.model))
  );
}

function getConversationSession(
  input: ConversationModelInput,
  sessions: SessionManager,
): AgentSession | undefined {
  const session = input.sessionId ? sessions.getSession(input.sessionId) : undefined;
  if (input.sessionId && session?.projectId !== input.projectId) {
    throw new Error('Session does not belong to this project');
  }
  return session;
}

function preparationNeedsMetadata(params: {
  input: ConversationModelInput;
  session?: AgentSession;
  project?: ModelConfig;
  agentModel?: string | null;
}): boolean {
  const controls = [
    params.input.turn,
    prospectiveOverride(params.input.session, params.session?.modelConfig),
    prospectiveOverride(params.input.project, params.project),
    params.agentModel ? { model: params.agentModel } : undefined,
  ];
  return (
    controls.some(hasCapabilityControls) ||
    effectiveModelNeedsMetadata(controls) ||
    Object.values(params.input.agentDefinitions ?? {}).some(nestedDefinitionNeedsMetadata)
  );
}

/** Restore capability evidence lazily for persisted controls, without a paid prompt. */
export function createConversationModelPreparation(
  deps: ConversationModelDeps,
): ConversationModelPreparation {
  return async (input) => {
    if (deps.catalog.getSnapshot().models.length > 0) return;
    const session = getConversationSession(input, deps.sessions);
    const workspace = deps.workspaces.getWorkspace(input.projectId);
    const agent = deps.agents.getDefaultAgent(input.projectId);
    if (
      !preparationNeedsMetadata({
        input,
        session,
        project: workspace.execution.modelConfig,
        agentModel: agent.model,
      })
    )
      return;
    const refreshed = await deps.catalog.refresh();
    if (refreshed.models.length === 0) {
      throw new Error(
        'Cannot validate explicit model settings because the model catalog is unavailable',
      );
    }
  };
}

function prospectiveOverride(
  replacement: ModelConfig | null | undefined,
  current?: ModelConfig,
): ModelConfig | undefined {
  return replacement === undefined ? current : (replacement ?? undefined);
}

/** Explicit worker models keep their own effort; only inherited models inherit effort. */
export function captureNestedModelSettings(
  definitions: Record<string, SubAgentDefinition>,
  parent: ModelConfig & { model: string },
  catalog: ModelCatalogSnapshot,
): Record<string, SubAgentDefinition> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const inherits = !definition.model || definition.model === 'inherit';
      const effort = definition.effort ?? (inherits ? parent.effort : undefined);
      const resolved = resolveModelConfig(
        {
          turn: { model: inherits ? parent.model : definition.model, effort },
          defaults: { model: parent.model },
        },
        catalog,
      );
      return [name, { ...definition, model: resolved.model, effort: resolved.effort }];
    }),
  );
}

/** Read current owner choices without mutating sessions or discovering through inference. */
export function createConversationModelResolver(
  deps: ConversationModelDeps,
): ConversationModelResolver {
  return (input) => {
    const session = input.sessionId ? deps.sessions.getSession(input.sessionId) : undefined;
    if (input.sessionId && session?.projectId !== input.projectId) {
      throw new Error('Session does not belong to this project');
    }
    const workspace = deps.workspaces.getWorkspace(input.projectId);
    const agent = deps.agents.getDefaultAgent(input.projectId);
    const resolved = resolveModelConfig(
      {
        turn: input.turn,
        session: prospectiveOverride(input.session, session?.modelConfig),
        project: prospectiveOverride(input.project, workspace.execution.modelConfig),
        agent: agent.model ? { model: agent.model } : undefined,
        defaults: { model: getConfig().CLAUDE_MODEL },
      },
      deps.catalog.getSnapshot(),
    );
    return { model: resolved.model, effort: resolved.effort, thinking: resolved.thinking };
  };
}
