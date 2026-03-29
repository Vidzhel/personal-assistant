import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemTools } from '../../../mcp-server/tools/system.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';
import type { NamedAgent } from '@raven/shared';
import type { ProjectNode } from '@raven/shared';

function makeAgent(overrides: Partial<NamedAgent> = {}): NamedAgent {
  return {
    id: 'agent-1',
    name: 'test-agent',
    description: null,
    instructions: null,
    suiteIds: [],
    skills: [],
    model: null,
    maxTurns: null,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id: 'proj-1',
    name: 'test-project',
    path: '/projects/test-project',
    relativePath: 'test-project',
    parentId: null,
    systemAccess: 'none',
    isMeta: false,
    contextMd: '',
    agents: [],
    schedules: [],
    children: [],
    ...overrides,
  };
}

describe('buildSystemTools', () => {
  let deps: RavenMcpDeps;
  let scope: ScopeContext;

  beforeEach(() => {
    deps = {
      eventBus: { emit: vi.fn() } as any,
      namedAgentStore: {
        listAgents: vi.fn().mockReturnValue([]),
        createAgent: vi.fn(),
        updateAgent: vi.fn(),
        deleteAgent: vi.fn(),
        getAgent: vi.fn(),
        getAgentByName: vi.fn(),
        getDefaultAgent: vi.fn(),
        syncToConfigFile: vi.fn(),
        loadFromConfigFile: vi.fn(),
      },
      projectRegistry: {
        listProjects: vi.fn().mockReturnValue([]),
        getProject: vi.fn(),
        findByName: vi.fn(),
        getGlobal: vi.fn(),
        getProjectChildren: vi.fn(),
        resolveProjectContext: vi.fn(),
        load: vi.fn(),
      },
      pipelineEngine: {
        initialize: vi.fn(),
        getPipeline: vi.fn(),
        getAllPipelines: vi.fn(),
        executePipeline: vi.fn(),
        triggerPipeline: vi
          .fn()
          .mockReturnValue({ runId: 'run-123', execution: Promise.resolve() }),
        savePipeline: vi.fn(),
        deletePipeline: vi.fn(),
        shutdown: vi.fn(),
      },
    } as any;
    scope = { role: 'system' };
  });

  describe('list_agents', () => {
    it('returns agents from store', async () => {
      const agents = [makeAgent({ id: 'agent-1', name: 'alpha' })];
      (deps.namedAgentStore!.listAgents as any).mockReturnValue(agents);

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_agents');
      expect(tool).toBeDefined();

      const result = await tool!.handler({}, {});

      expect(deps.namedAgentStore!.listAgents).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0].id).toBe('agent-1');
    });

    it('returns empty list when store has no agents', async () => {
      (deps.namedAgentStore!.listAgents as any).mockReturnValue([]);

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_agents');

      const result = await tool!.handler({}, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.agents).toHaveLength(0);
    });

    it('returns empty list when namedAgentStore is unavailable', async () => {
      deps.namedAgentStore = undefined;

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_agents');

      const result = await tool!.handler({}, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.agents).toHaveLength(0);
    });

    it('has readOnlyHint and idempotentHint annotations', () => {
      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_agents');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.idempotentHint).toBe(true);
    });
  });

  describe('list_projects', () => {
    it('returns projects from registry', async () => {
      const projects = [makeProject({ id: 'proj-1', name: 'alpha' })];
      (deps.projectRegistry!.listProjects as any).mockReturnValue(projects);

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_projects');
      expect(tool).toBeDefined();

      const result = await tool!.handler({}, {});

      expect(deps.projectRegistry!.listProjects).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.projects).toHaveLength(1);
      expect(parsed.projects[0].id).toBe('proj-1');
    });

    it('returns empty list when registry has no projects', async () => {
      (deps.projectRegistry!.listProjects as any).mockReturnValue([]);

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_projects');

      const result = await tool!.handler({}, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.projects).toHaveLength(0);
    });

    it('returns empty list when projectRegistry is unavailable', async () => {
      deps.projectRegistry = undefined;

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_projects');

      const result = await tool!.handler({}, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.projects).toHaveLength(0);
    });

    it('has readOnlyHint and idempotentHint annotations', () => {
      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'list_projects');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.idempotentHint).toBe(true);
    });
  });

  describe('create_agent', () => {
    it('calls createAgent and returns agentId', async () => {
      const created = makeAgent({ id: 'new-agent-id', name: 'my-bot' });
      (deps.namedAgentStore!.createAgent as any).mockReturnValue(created);

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_agent');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ name: 'my-bot', description: 'A bot' }, {});

      expect(deps.namedAgentStore!.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-bot',
          description: 'A bot',
          suiteIds: [],
          skills: [],
        }),
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.agentId).toBe('new-agent-id');
    });

    it('returns error when namedAgentStore is unavailable', async () => {
      deps.namedAgentStore = undefined;

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_agent');

      const result = await tool!.handler({ name: 'my-bot' }, {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('namedAgentStore');
    });
  });

  describe('update_agent', () => {
    it('calls updateAgent and returns ack', async () => {
      (deps.namedAgentStore!.updateAgent as any).mockReturnValue(makeAgent());

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'update_agent');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ agentId: 'agent-1', description: 'Updated desc' }, {});

      expect(deps.namedAgentStore!.updateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ description: 'Updated desc' }),
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
    });

    it('has idempotentHint annotation', () => {
      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'update_agent');
      expect(tool?.annotations?.idempotentHint).toBe(true);
    });
  });

  describe('trigger_pipeline', () => {
    it('triggers pipeline and returns treeId', async () => {
      (deps.pipelineEngine!.triggerPipeline as any).mockReturnValue({
        runId: 'run-abc',
        execution: Promise.resolve(),
      });

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'trigger_pipeline');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ name: 'daily-digest' }, {});

      expect(deps.pipelineEngine!.triggerPipeline).toHaveBeenCalledWith('daily-digest', 'manual');
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.treeId).toBe('run-abc');
    });

    it('returns error when pipelineEngine is unavailable', async () => {
      deps.pipelineEngine = undefined;

      const tools = buildSystemTools(deps, scope);
      const tool = tools.find((t) => t.name === 'trigger_pipeline');

      const result = await tool!.handler({ name: 'daily-digest' }, {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('pipelineEngine');
    });
  });
});
