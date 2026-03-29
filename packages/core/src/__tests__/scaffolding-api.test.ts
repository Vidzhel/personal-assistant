import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { load as yamlLoad } from 'js-yaml';

import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import type { ScaffoldingApi, ScaffoldPlan } from '../scaffolding/scaffolding-api.ts';
import type { AgentYaml, ScheduleYaml, TaskTemplate } from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';

function makeAgent(overrides: Partial<AgentYaml> = {}): AgentYaml {
  return {
    name: 'test-agent',
    displayName: 'Test Agent',
    description: 'A test agent',
    skills: [],
    isDefault: false,
    model: 'sonnet',
    maxTurns: 15,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    name: 'test-template',
    displayName: 'Test Template',
    description: 'A test template',
    params: {},
    trigger: [{ type: 'manual' }],
    plan: { approval: 'manual', parallel: true },
    tasks: [
      {
        id: 'task-1',
        title: 'Do something',
        type: 'agent',
        agent: 'default',
        prompt: 'Do something',
      },
    ],
    ...overrides,
  } as TaskTemplate;
}

function makeSchedule(overrides: Partial<ScheduleYaml> = {}): ScheduleYaml {
  return {
    name: 'test-schedule',
    cron: '0 9 * * *',
    timezone: 'UTC',
    template: 'test-template',
    enabled: true,
    ...overrides,
  };
}

function makeMockProjectRegistry(): ProjectRegistry {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn(),
    findByName: vi.fn(),
    getGlobal: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getProjectChildren: vi.fn().mockReturnValue([]),
    resolveProjectContext: vi.fn(),
  } as unknown as ProjectRegistry;
}

function makeMockAgentYamlStore(): AgentYamlStore {
  return {
    createAgent: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
  };
}

describe('ScaffoldingApi', () => {
  let tmpDir: string;
  let api: ScaffoldingApi;
  let mockRegistry: ProjectRegistry;
  let mockAgentStore: AgentYamlStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffolding-api-'));
    mockRegistry = makeMockProjectRegistry();
    mockAgentStore = makeMockAgentYamlStore();
    api = createScaffoldingApi({
      projectsDir: tmpDir,
      projectRegistry: mockRegistry,
      agentYamlStore: mockAgentStore,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createProject', () => {
    it('creates directory and context.md', async () => {
      await api.createProject({ path: 'uni/calculus' });

      const contextPath = join(tmpDir, 'uni/calculus', 'context.md');
      expect(existsSync(contextPath)).toBe(true);

      const content = await readFile(contextPath, 'utf-8');
      expect(content).toContain('# uni/calculus');
    });

    it('uses displayName and description when provided', async () => {
      await api.createProject({
        path: 'work/project-x',
        displayName: 'Project X',
        description: 'Top secret project',
      });

      const content = await readFile(join(tmpDir, 'work/project-x', 'context.md'), 'utf-8');
      expect(content).toContain('# Project X');
      expect(content).toContain('Top secret project');
    });

    it('creates nested project paths (parent created)', async () => {
      await api.createProject({ path: 'deep/nested/project' });

      expect(existsSync(join(tmpDir, 'deep/nested/project', 'context.md'))).toBe(true);
    });
  });

  describe('createAgent', () => {
    it('writes valid YAML file', async () => {
      const agent = makeAgent({ name: 'my-agent' });
      await api.createAgent({ projectPath: 'test-project', agent });

      const filePath = join(tmpDir, 'test-project', 'agents', 'my-agent.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = await readFile(filePath, 'utf-8');
      const parsed = yamlLoad(content) as Record<string, unknown>;
      expect(parsed.name).toBe('my-agent');
      expect(parsed.displayName).toBe('Test Agent');
    });

    it('rejects invalid agent input', async () => {
      const invalid = { name: 'INVALID NAME', displayName: '', description: '' } as any;
      await expect(api.createAgent({ projectPath: 'test', agent: invalid })).rejects.toThrow();
    });

    it('writes to global when projectPath is empty', async () => {
      const agent = makeAgent({ name: 'global-agent' });
      await api.createAgent({ projectPath: '', agent });

      const filePath = join(tmpDir, 'agents', 'global-agent.yaml');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('createTemplate', () => {
    it('writes valid YAML file', async () => {
      const template = makeTemplate({ name: 'my-template' });
      await api.createTemplate({ projectPath: 'test-project', template });

      const filePath = join(tmpDir, 'test-project', 'templates', 'my-template.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = await readFile(filePath, 'utf-8');
      const parsed = yamlLoad(content) as Record<string, unknown>;
      expect(parsed.name).toBe('my-template');
      expect(parsed.displayName).toBe('Test Template');
    });

    it('rejects invalid template input', async () => {
      const invalid = { name: 'BAD', tasks: [] } as any;
      await expect(
        api.createTemplate({ projectPath: 'test', template: invalid }),
      ).rejects.toThrow();
    });
  });

  describe('createSchedule', () => {
    it('writes valid YAML file', async () => {
      const schedule = makeSchedule({ name: 'daily-sync' });
      await api.createSchedule({ projectPath: 'test-project', schedule });

      const filePath = join(tmpDir, 'test-project', 'schedules', 'daily-sync.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = await readFile(filePath, 'utf-8');
      const parsed = yamlLoad(content) as Record<string, unknown>;
      expect(parsed.name).toBe('daily-sync');
      expect(parsed.cron).toBe('0 9 * * *');
    });

    it('rejects invalid schedule input', async () => {
      const invalid = { name: 'BAD SCHEDULE', cron: '' } as any;
      await expect(
        api.createSchedule({ projectPath: 'test', schedule: invalid }),
      ).rejects.toThrow();
    });
  });

  describe('scaffoldDomain', () => {
    it('creates complete structure', async () => {
      const plan: ScaffoldPlan = {
        projects: [
          { path: 'uni', displayName: 'University' },
          { path: 'uni/calculus', displayName: 'Calculus' },
        ],
        agents: [{ projectPath: 'uni', agent: makeAgent({ name: 'tutor' }) }],
        templates: [{ projectPath: 'uni', template: makeTemplate({ name: 'review-notes' }) }],
        schedules: [{ projectPath: 'uni', schedule: makeSchedule({ name: 'weekly-review' }) }],
      };

      const result = await api.scaffoldDomain(plan);

      expect(result.projectsCreated).toEqual(['uni', 'uni/calculus']);
      expect(result.agentsCreated).toEqual(['tutor']);
      expect(result.templatesCreated).toEqual(['review-notes']);
      expect(result.schedulesCreated).toEqual(['weekly-review']);
      expect(result.errors).toEqual([]);

      // Verify files exist
      expect(existsSync(join(tmpDir, 'uni', 'context.md'))).toBe(true);
      expect(existsSync(join(tmpDir, 'uni/calculus', 'context.md'))).toBe(true);
      expect(existsSync(join(tmpDir, 'uni', 'agents', 'tutor.yaml'))).toBe(true);
      expect(existsSync(join(tmpDir, 'uni', 'templates', 'review-notes.yaml'))).toBe(true);
      expect(existsSync(join(tmpDir, 'uni', 'schedules', 'weekly-review.yaml'))).toBe(true);

      // Verify registry was reloaded
      expect(mockRegistry.load).toHaveBeenCalledWith(tmpDir);
    });

    it('reports errors for invalid inputs without stopping', async () => {
      const plan: ScaffoldPlan = {
        projects: [{ path: 'valid-project' }],
        agents: [
          {
            projectPath: 'valid-project',
            agent: { name: 'INVALID', displayName: '', description: '' } as any,
          },
        ],
        templates: [],
        schedules: [],
      };

      const result = await api.scaffoldDomain(plan);

      expect(result.projectsCreated).toEqual(['valid-project']);
      expect(result.agentsCreated).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('agent INVALID');
    });
  });
});
