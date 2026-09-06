import type { AgentSession, ModelConfig, NamedAgent, SubAgentDefinition } from '@raven/shared';
import { projectWorkspaceDefaults } from '@raven/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createConversationModelPreparation,
  type ConversationModelInput,
} from '../agent-registry/conversation-models.ts';
import { ModelCatalog, type ModelDiscovery } from '../agent-registry/model-catalog.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { ProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';

const projectId = 'project-alpha';
const sessionId = 'session-alpha';

function defaultAgent(model: string | null = 'sonnet'): NamedAgent {
  return {
    id: 'default',
    name: 'default',
    description: null,
    instructions: null,
    skills: [],
    model,
    maxTurns: null,
    isDefault: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

function session(modelConfig?: ModelConfig): AgentSession {
  return {
    id: sessionId,
    projectId,
    status: 'idle',
    createdAt: 0,
    lastActiveAt: 0,
    turnCount: 0,
    modelConfig,
  };
}

interface PreparationFixtureOptions {
  sessionConfig?: ModelConfig;
  projectConfig?: ModelConfig;
  agentModel?: string | null;
  discover?: ModelDiscovery;
}

const successfulDiscovery: ModelDiscovery = async () => [
  {
    value: 'claude-custom-20260906',
    displayName: 'Custom',
    description: 'Fixture',
    supportsEffort: true,
    supportedEffortLevels: ['low'],
  },
];

function fixture(options: PreparationFixtureOptions = {}) {
  const discover = vi.fn<ModelDiscovery>(options.discover ?? successfulDiscovery);
  const catalog = new ModelCatalog({ discover });
  const workspace = projectWorkspaceDefaults();
  workspace.execution.modelConfig = options.projectConfig;
  const currentSession = session(options.sessionConfig);
  const prepare = createConversationModelPreparation({
    catalog,
    sessions: {
      getSession: (id: string) => (id === sessionId ? currentSession : undefined),
    } as unknown as SessionManager,
    workspaces: {
      getWorkspace: () => workspace,
    } as unknown as ProjectWorkspaceStore,
    agents: {
      getDefaultAgent: () => defaultAgent(options.agentModel),
    } as unknown as NamedAgentStore,
  });
  return { discover, prepare };
}

describe('conversation model preparation', () => {
  it.each<[string, Omit<ConversationModelInput, 'projectId'>, PreparationFixtureOptions?]>([
    ['turn', { turn: { model: 'claude-custom-20260906' } }],
    ['session', { sessionId }, { sessionConfig: { model: 'claude-custom-20260906' } }],
    ['project', {}, { projectConfig: { model: 'claude-custom-20260906' } }],
    ['named agent', {}, { agentModel: 'claude-custom-20260906' }],
  ])('discovers metadata for an explicit %s model', async (_layer, input, options) => {
    const { discover, prepare } = fixture(options);

    await prepare({ projectId, ...input });

    expect(discover).toHaveBeenCalledOnce();
  });

  it('discovers metadata for nested explicit models and effort controls', async () => {
    const definitions: Record<string, SubAgentDefinition> = {
      custom: { description: 'Custom', prompt: 'Work', model: 'claude-custom-20260906' },
      effort: { description: 'Effort', prompt: 'Work', model: 'sonnet', effort: 'low' },
    };
    const { discover, prepare } = fixture();

    await prepare({ projectId, agentDefinitions: definitions });

    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not discover for stable aliases without capability controls', async () => {
    const { discover, prepare } = fixture({
      sessionConfig: { model: 'opus' },
      projectConfig: { model: 'haiku' },
      agentModel: 'sonnet',
    });

    await prepare({
      projectId,
      sessionId,
      turn: { model: 'sonnet' },
      agentDefinitions: {
        inherited: { description: 'Inherited', prompt: 'Work', model: 'inherit' },
        alias: { description: 'Alias', prompt: 'Work', model: 'haiku' },
      },
    });

    expect(discover).not.toHaveBeenCalled();
  });

  it('does not discover for explicit lower layers masked by a stable turn alias', async () => {
    const { discover, prepare } = fixture({
      sessionConfig: { model: 'claude-session-custom' },
      projectConfig: { model: 'claude-project-custom' },
      agentModel: 'claude-agent-custom',
    });

    await prepare({ projectId, sessionId, turn: { model: 'sonnet' } });

    expect(discover).not.toHaveBeenCalled();
  });

  it('rejects explicit settings when discovery cannot provide metadata', async () => {
    const { prepare } = fixture({
      discover: async () => {
        throw new Error('offline');
      },
    });

    await expect(prepare({ projectId, turn: { model: 'claude-custom-20260906' } })).rejects.toThrow(
      /model catalog is unavailable/,
    );
  });
});
