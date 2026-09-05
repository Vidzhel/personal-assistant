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
    memory: { maxFiles: 30, maxTotalKb: 64 },
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
    enabled: true,
    params: undefined,
    run: { kind: 'template', ref: 'test-template' },
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
    createAgent: vi.fn().mockResolvedValue('/tmp/agent.yaml'),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    resolveAgentFile: vi.fn().mockReturnValue('/tmp/agent.yaml'),
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
      await api.createProject({ path: 'uni' });
      await api.createProject({ path: 'uni/calculus' });

      const contextPath = join(tmpDir, 'uni/calculus', 'context.md');
      expect(existsSync(contextPath)).toBe(true);

      const content = await readFile(contextPath, 'utf-8');
      expect(content).toContain('# uni/calculus');
    });

    it('uses displayName and description when provided', async () => {
      await api.createProject({ path: 'work' });
      await api.createProject({
        path: 'work/project-x',
        displayName: 'Project X',
        description: 'Top secret project',
      });

      const content = await readFile(join(tmpDir, 'work/project-x', 'context.md'), 'utf-8');
      expect(content).toContain('# Project X');
      expect(content).toContain('Top secret project');
    });

    it('rejects nested project paths without parent definitions', async () => {
      await expect(api.createProject({ path: 'deep/nested/project' })).rejects.toThrow(
        'Parent project',
      );
      expect(existsSync(join(tmpDir, 'deep'))).toBe(false);
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

    // F1: croner throws synchronously on a bad pattern/timezone — this must
    // be caught and turned into a clean rejection BEFORE anything is
    // written, so a poisoned schedule never reaches disk (and therefore
    // never reaches the next boot's resync either).
    it('rejects an invalid cron pattern and writes nothing to disk', async () => {
      const schedule = makeSchedule({ name: 'bad-cron', cron: 'not a cron expression' });
      await expect(api.createSchedule({ projectPath: 'test-project', schedule })).rejects.toThrow(
        /bad-cron/,
      );

      expect(existsSync(join(tmpDir, 'test-project', 'schedules', 'bad-cron.yaml'))).toBe(false);
    });

    it('rejects an invalid IANA timezone and writes nothing to disk', async () => {
      const schedule = makeSchedule({ name: 'bad-tz', timezone: 'Not/AZone' });
      await expect(api.createSchedule({ projectPath: 'test-project', schedule })).rejects.toThrow(
        /bad-tz/,
      );

      expect(existsSync(join(tmpDir, 'test-project', 'schedules', 'bad-tz.yaml'))).toBe(false);
    });

    it('accepts a valid cron/timezone (control case)', async () => {
      const schedule = makeSchedule({ name: 'good-cron', cron: '0 9 * * *', timezone: 'UTC' });
      await expect(api.createSchedule({ projectPath: 'test-project', schedule })).resolves.toBe(
        'good-cron',
      );
    });
  });

  // F3: path/projectPath traversal guard, shared by every artifact-creating
  // function via projectDirFor. Not chat-reachable (chat hardcodes
  // projectPath:'' and kebab-validates names) but REST POST
  // /api/scaffold/project|agent|template|schedule and scaffoldDomain forward
  // caller-supplied values straight through.
  describe('path traversal guard (F3)', () => {
    it('createProject rejects a path containing ".."', async () => {
      await expect(api.createProject({ path: '../../etc/evil' })).rejects.toThrow(/\.\./);
    });

    it('createProject rejects a leading-slash absolute path', async () => {
      await expect(api.createProject({ path: '/etc/evil' })).rejects.toThrow();
    });

    it('createAgent rejects a projectPath containing ".." and writes nothing', async () => {
      const agent = makeAgent({ name: 'evil-agent' });
      await expect(api.createAgent({ projectPath: '../../etc', agent })).rejects.toThrow(/\.\./);
    });

    it('createTemplate rejects a projectPath containing ".."', async () => {
      const template = makeTemplate({ name: 'evil-template' });
      await expect(api.createTemplate({ projectPath: '../outside', template })).rejects.toThrow(
        /\.\./,
      );
    });

    it('createSchedule rejects a projectPath containing ".."', async () => {
      const schedule = makeSchedule({ name: 'evil-schedule' });
      await expect(api.createSchedule({ projectPath: '../outside', schedule })).rejects.toThrow(
        /\.\./,
      );
    });

    it('still allows the empty projectPath (global scope)', async () => {
      const agent = makeAgent({ name: 'global-ok' });
      await expect(api.createAgent({ projectPath: '', agent })).resolves.toBe('global-ok');
    });

    it('still allows an ordinary nested relative path with defined parents', async () => {
      await api.createProject({ path: 'a' });
      await api.createProject({ path: 'a/b' });
      await expect(api.createProject({ path: 'a/b/c' })).resolves.toBe('a/b/c');
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
