import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as RavenShared from '@raven/shared';

// gitAutoCommit shells out to the real `git` binary against
// process.cwd() (see @raven/shared's git-commit.ts) — it has no `cwd`
// parameter, so there is no way to point it at a temp directory without
// either mutating the test process's cwd (fragile, and not how any other
// test in this codebase touches git — see memory-consolidation.test.ts,
// which lets the real gitAutoCommit run against a temp projectsDir and
// simply lets `git add` fail-and-swallow because the path is outside the
// repo). We mock it here instead, at the same boundary git-commit.test.ts
// itself tests against (execFile) one level up — so "git log would show
// this commit" is verified as "gitAutoCommit was invoked with the exact
// file path + a descriptive message," without executing real git commands
// against this developer's actual repository.
const { gitAutoCommitMock } = vi.hoisted(() => ({
  gitAutoCommitMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof RavenShared>();
  return { ...actual, gitAutoCommit: gitAutoCommitMock };
});

import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  createScaffoldAndActivate,
  createReloadRegistries,
  type ScaffoldAndActivateDeps,
} from '../scaffolding/scaffold-and-activate.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { TemplateRegistry } from '../template-engine/template-registry.ts';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { createScheduleEngine } from '../scheduler/schedule-engine.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import type { AgentYaml, TaskTemplate, SkillConfig } from '@raven/shared';

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
    tasks: [{ id: 'task-1', title: 'Do something', type: 'agent', agent: 'default', prompt: 'Go' }],
    ...overrides,
  } as TaskTemplate;
}

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'test-skill',
    displayName: 'Test Skill',
    description: 'A test skill',
    mcps: [],
    vendorSkills: [],
    tools: ['Read'],
    systemDeps: [],
    model: 'sonnet',
    maxTurns: 10,
    actions: [],
    expectedOutputs: [],
    ...overrides,
  };
}

function fakeTaskStore() {
  return { createTask: vi.fn(() => ({ id: 't' })), updateTask: vi.fn(() => ({ id: 't' })) };
}

describe('scaffoldAndActivate', () => {
  let tmpDir: string;
  let projectsDir: string;
  let libraryDir: string;
  let deps: ScaffoldAndActivateDeps;
  let scaffoldAndActivate: ReturnType<typeof createScaffoldAndActivate>;

  beforeEach(async () => {
    gitAutoCommitMock.mockClear();
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-and-activate-'));
    projectsDir = join(tmpDir, 'projects');
    libraryDir = join(tmpDir, 'library');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(libraryDir, { recursive: true });

    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    const templateRegistry = new TemplateRegistry();
    await templateRegistry.load(projectsDir);
    const capabilityLibrary = new CapabilityLibrary();
    await capabilityLibrary.load(libraryDir);
    const jobRegistry = createJobRegistry();
    jobRegistry.register('test-job', async () => ({ summary: 'ok' }));
    const scheduleEngine = createScheduleEngine({
      schedules: projectRegistry.getGlobal().schedules,
      jobRegistry,
      taskStore: fakeTaskStore() as never,
      timezone: 'UTC',
    });
    scheduleEngine.start();

    const scaffoldingApi = createScaffoldingApi({
      projectsDir,
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      capabilityLibrary,
      libraryDir,
    });

    deps = {
      scaffoldingApi,
      projectRegistry,
      templateRegistry,
      scheduleEngine,
      capabilityLibrary,
      projectsDir,
      libraryDir,
    };
    scaffoldAndActivate = createScaffoldAndActivate(deps);
  });

  afterEach(() => {
    deps.scheduleEngine.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('kind: project', () => {
    it('writes context.md, reloads the project registry, and commits', async () => {
      const result = await scaffoldAndActivate({
        kind: 'project',
        input: { path: 'demo', displayName: 'Demo Project' },
      });

      expect(result.live).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(deps.projectRegistry.getProject('demo')).toBeDefined();
      expect(existsSync(join(projectsDir, 'demo', 'project.yaml'))).toBe(true);
      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path, join(projectsDir, 'demo', 'project.yaml')],
        expect.stringContaining('demo'),
      );
    });
  });

  describe('kind: agent', () => {
    it('writes the agent YAML, reloads the project registry, and commits', async () => {
      const result = await scaffoldAndActivate({
        kind: 'agent',
        input: { projectPath: '', agent: makeAgent({ name: 'new-helper' }) },
      });

      expect(result.live).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(deps.projectRegistry.getGlobal().agents.some((a) => a.name === 'new-helper')).toBe(
        true,
      );
      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path],
        expect.stringContaining('new-helper'),
      );
    });
  });

  describe('kind: template', () => {
    it('writes the template YAML, reloads the template registry, and commits', async () => {
      const result = await scaffoldAndActivate({
        kind: 'template',
        input: { projectPath: '', template: makeTemplate({ name: 'new-plan' }) },
      });

      expect(result.live).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(deps.templateRegistry.getTemplate('new-plan')).toBeDefined();
      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path],
        expect.stringContaining('new-plan'),
      );
    });
  });

  describe('kind: schedule', () => {
    it('writes the schedule YAML, resyncs the live cron engine, and commits', async () => {
      expect(deps.scheduleEngine.getActiveCount()).toBe(0);

      const result = await scaffoldAndActivate({
        kind: 'schedule',
        input: {
          projectPath: '',
          schedule: {
            name: 'new-cron',
            cron: '0 9 * * *',
            timezone: 'UTC',
            enabled: true,
            params: undefined,
            run: { kind: 'job', ref: 'test-job' },
          },
        },
      });

      expect(result.live).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(deps.projectRegistry.getGlobal().schedules.some((s) => s.name === 'new-cron')).toBe(
        true,
      );

      // The core "fires without restart" guarantee: the SAME engine
      // instance (never recreated) now has an active cron for the schedule
      // that was just scaffolded, with zero restart in between.
      const listed = deps.scheduleEngine.list().find((s) => s.name === 'new-cron');
      expect(listed?.registered).toBe(true);
      expect(listed?.nextRun).not.toBeNull();
      expect(deps.scheduleEngine.getActiveCount()).toBe(1);

      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path],
        expect.stringContaining('new-cron'),
      );
    });

    // F1: an invalid cron/timezone must be rejected BEFORE anything is
    // written — the poisoned YAML must never reach disk, and therefore
    // never reach the next boot's resync() loop either. Nothing should be
    // registered, reloaded, or committed.
    it('rejects an invalid cron and writes/commits/registers nothing', async () => {
      await expect(
        scaffoldAndActivate({
          kind: 'schedule',
          input: {
            projectPath: '',
            schedule: {
              name: 'poison-cron',
              cron: 'not a cron expression',
              timezone: 'UTC',
              enabled: true,
              params: undefined,
              run: { kind: 'job', ref: 'test-job' },
            },
          },
        }),
      ).rejects.toThrow(/poison-cron/);

      const filePath = join(projectsDir, 'schedules', 'poison-cron.yaml');
      expect(existsSync(filePath)).toBe(false);
      expect(deps.projectRegistry.getGlobal().schedules.some((s) => s.name === 'poison-cron')).toBe(
        false,
      );
      expect(deps.scheduleEngine.getActiveCount()).toBe(0);
      expect(gitAutoCommitMock).not.toHaveBeenCalled();
    });
  });

  describe('kind: skill', () => {
    it('writes config.json + skill.md, reloads the capability library, and commits the skill dir AND the new domain _index.md together (F2)', async () => {
      const result = await scaffoldAndActivate({
        kind: 'skill',
        input: {
          domain: 'new-domain',
          skill: makeSkill({ name: 'new-skill' }),
          skillMd: '# New Skill\n\nDo the thing.',
        },
      });

      const indexMdPath = join(libraryDir, 'skills', 'new-domain', '_index.md');
      expect(result.live).toBe(true);
      expect(deps.capabilityLibrary.getSkill('new-skill')).toBeDefined();
      expect(existsSync(indexMdPath)).toBe(true);
      // Regression guard for F2: the _index.md library-validator.ts requires
      // for a brand-new domain folder must land in the SAME commit as the
      // skill dir, or it ships outside the committed pathspec.
      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path, indexMdPath],
        expect.stringContaining('new-domain/new-skill'),
      );
    });

    it('does not re-add _index.md to the pathspec for a second skill in an already-indexed domain', async () => {
      await scaffoldAndActivate({
        kind: 'skill',
        input: {
          domain: 'shared-domain',
          skill: makeSkill({ name: 'first-skill' }),
          skillMd: '# First Skill',
        },
      });
      gitAutoCommitMock.mockClear();

      const result = await scaffoldAndActivate({
        kind: 'skill',
        input: {
          domain: 'shared-domain',
          skill: makeSkill({ name: 'second-skill' }),
          skillMd: '# Second Skill',
        },
      });

      expect(gitAutoCommitMock).toHaveBeenCalledWith(
        [result.path],
        expect.stringContaining('shared-domain/second-skill'),
      );
    });

    it('rejects a red-tier action and never reaches the git commit', async () => {
      await expect(
        scaffoldAndActivate({
          kind: 'skill',
          input: {
            domain: 'new-domain',
            skill: makeSkill({
              name: 'risky-skill',
              actions: [
                {
                  name: 'risky-skill:wipe',
                  description: 'wipes stuff',
                  defaultTier: 'red',
                  reversible: false,
                },
              ],
            }),
            skillMd: '# Risky',
          },
        }),
      ).rejects.toThrow(/red tier/);

      expect(deps.capabilityLibrary.getSkill('risky-skill')).toBeUndefined();
      expect(gitAutoCommitMock).not.toHaveBeenCalled();
    });

    it('rejects an mcp reference that does not exist in the library', async () => {
      await expect(
        scaffoldAndActivate({
          kind: 'skill',
          input: {
            domain: 'new-domain',
            skill: makeSkill({ name: 'needs-mcp', mcps: ['does-not-exist'] }),
            skillMd: '# Needs MCP',
          },
        }),
      ).rejects.toThrow(/does-not-exist/);
    });
  });
});

describe('createReloadRegistries', () => {
  let tmpDir: string;
  let projectsDir: string;
  let libraryDir: string;
  let deps: ScaffoldAndActivateDeps;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reload-registries-'));
    projectsDir = join(tmpDir, 'projects');
    libraryDir = join(tmpDir, 'library');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(libraryDir, { recursive: true });

    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    const templateRegistry = new TemplateRegistry();
    await templateRegistry.load(projectsDir);
    const capabilityLibrary = new CapabilityLibrary();
    await capabilityLibrary.load(libraryDir);
    const scheduleEngine = createScheduleEngine({
      schedules: projectRegistry.getGlobal().schedules,
      jobRegistry: createJobRegistry(),
      taskStore: fakeTaskStore() as never,
      timezone: 'UTC',
    });
    scheduleEngine.start();

    deps = {
      scaffoldingApi: createScaffoldingApi({
        projectsDir,
        projectRegistry,
        agentYamlStore: createAgentYamlStore(),
        capabilityLibrary,
        libraryDir,
      }),
      projectRegistry,
      templateRegistry,
      scheduleEngine,
      capabilityLibrary,
      projectsDir,
      libraryDir,
    };
  });

  afterEach(() => {
    deps.scheduleEngine.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks up a schedule written to disk outside of scaffoldAndActivate', async () => {
    const schedulesDir = join(projectsDir, 'schedules');
    mkdirSync(schedulesDir, { recursive: true });
    writeFileSync(
      join(schedulesDir, 'manual.yaml'),
      'name: manual\ncron: "0 * * * *"\ntimezone: UTC\nenabled: true\nrun:\n  kind: job\n  ref: manual\n',
      'utf-8',
    );

    expect(deps.projectRegistry.getGlobal().schedules).toHaveLength(0);

    const reloadRegistries = createReloadRegistries(deps);
    const result = await reloadRegistries();

    expect(result).toEqual({ project: true, template: true, library: true, schedule: true });
    expect(deps.projectRegistry.getGlobal().schedules.some((s) => s.name === 'manual')).toBe(true);
  });
});
