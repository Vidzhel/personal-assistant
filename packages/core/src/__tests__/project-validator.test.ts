import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs/promises';

import { dump as yamlDump } from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { validateProjects } from '../project-registry/project-validator.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-validator-'));
});

afterEach(() => {
  vi.mocked(fs.readdir).mockReset();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(relPath: string, contextMd = 'Project context'): string {
  const dir = relPath ? join(tmpDir, relPath) : tmpDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), contextMd);
  return dir;
}

function mkAgent(relPath: string, agent: Record<string, unknown>): void {
  const base = relPath ? join(tmpDir, relPath) : tmpDir;
  const agentsDir = join(base, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const name = typeof agent.name === 'string' ? agent.name : 'unnamed';
  writeFileSync(join(agentsDir, `${name}.yaml`), yamlDump(agent));
}

function mkSchedule(relPath: string, schedule: Record<string, unknown>): void {
  const base = relPath ? join(tmpDir, relPath) : tmpDir;
  const schedulesDir = join(base, 'schedules');
  mkdirSync(schedulesDir, { recursive: true });
  const name = typeof schedule.name === 'string' ? schedule.name : 'unnamed';
  writeFileSync(join(schedulesDir, `${name}.yaml`), yamlDump(schedule));
}

function mkTemplate(relPath: string, template: Record<string, unknown>): void {
  const base = relPath ? join(tmpDir, relPath) : tmpDir;
  const templatesDir = join(base, 'templates');
  mkdirSync(templatesDir, { recursive: true });
  const name = typeof template.name === 'string' ? template.name : 'unnamed';
  writeFileSync(join(templatesDir, `${name}.yaml`), yamlDump(template));
}

const VALID_AGENT = {
  name: 'test-agent',
  displayName: 'Test Agent',
  description: 'A test agent',
  model: 'sonnet',
  maxTurns: 10,
};

const VALID_SCHEDULE = {
  name: 'test-schedule',
  cron: '0 9 * * *',
  template: 'morning-digest',
  timezone: 'UTC',
  enabled: true,
};

const VALID_TEMPLATE = {
  name: 'test-template',
  displayName: 'Test Template',
  tasks: [
    {
      id: 'step-1',
      type: 'agent',
      title: 'First step',
      prompt: 'Do something',
      blockedBy: [],
    },
    {
      id: 'step-2',
      type: 'agent',
      title: 'Second step',
      prompt: 'Do something else',
      blockedBy: ['step-1'],
    },
  ],
};

describe('validateProjects', () => {
  it('rejects duplicate effective identities including a legacy path identity', async () => {
    mkProject('legacy', '# Legacy');
    mkProject('managed', '---\nravenProject: {version: 1, id: legacy}\n---\n# Managed');

    expect((await validateProjects(tmpDir)).errors).toEqual([
      expect.stringContaining('Duplicate project identity legacy'),
    ]);
  });

  it.each([
    ['ordinary', 'meta'],
    ['system', 'another-id'],
    ['meta', undefined],
  ] as const)('rejects misplaced system identity at %s', async (path, id) => {
    mkProject(path, id ? `---\nravenProject: {version: 1, id: ${id}}\n---\n# Context` : '# Legacy');

    expect((await validateProjects(tmpDir)).errors).toEqual([
      expect.stringContaining('System project identity conflicts'),
    ]);
  });

  it.each(['', 'agents', 'schedules', 'templates'])(
    'reports inaccessible project definitions instead of claiming valid: %s',
    async (folder) => {
      mkProject('', '# Root context');
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.readdir).mockImplementation(async (...args) => {
        const [path] = args;
        if (String(path) === join(tmpDir, folder)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return actual.readdir(...args);
      });

      expect((await validateProjects(tmpDir)).errors).toEqual([
        expect.stringContaining('permission denied'),
      ]);
    },
  );

  it('rejects a folder that would replace the synthetic global project', async () => {
    mkProject('_global', '# Reserved project\n');

    expect((await validateProjects(tmpDir)).errors).toEqual([
      'The _global project path is reserved',
    ]);
  });

  it('accepts current project metadata and legacy human context together', async () => {
    mkProject('', 'Global context');
    mkProject('legacy', '# Legacy human context\n');
    mkProject(
      'current',
      '---\nravenProject:\n  version: 1\n  id: stable-id\n  displayName: Current\n  systemAccess: read\ncustom: keep\n---\n# Current human context\n',
    );

    expect((await validateProjects(tmpDir)).errors).toEqual([]);
  });

  it.each([
    '---\nravenProject: [broken\n---\nHuman context',
    '---\nravenProject:\n  version: 2\n---\nHuman context',
    '---\nravenProject:\n  version: 1\n  systemAccess: full\n---\nHuman context',
  ])('reports invalid project frontmatter before runtime startup: %s', async (context) => {
    mkProject('broken', context);

    expect((await validateProjects(tmpDir)).errors).toEqual([
      expect.stringContaining('Invalid project context broken/context.md'),
    ]);
  });

  it('returns no errors for valid structure', async () => {
    mkProject('', 'Global context');
    mkProject('work', 'Work project');
    mkAgent('', VALID_AGENT);
    mkAgent('work', { ...VALID_AGENT, name: 'work-agent' });
    mkSchedule('', VALID_SCHEDULE);

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('reports invalid agent YAML', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');

    // Write invalid agent YAML (missing required fields)
    const agentsDir = join(tmpDir, 'work', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'bad.yaml'), yamlDump({ name: 'BAD NAME!!' }));

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('Invalid agent YAML'))).toBe(true);
  });

  it('reports invalid schedule YAML', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');

    // Write invalid schedule YAML (missing required fields)
    const schedulesDir = join(tmpDir, 'work', 'schedules');
    mkdirSync(schedulesDir, { recursive: true });
    writeFileSync(join(schedulesDir, 'bad.yaml'), yamlDump({ name: 'bad' }));

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('Invalid schedule YAML'))).toBe(true);
  });

  it('reports bash.access: full outside global/system', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      ...VALID_AGENT,
      name: 'full-bash-agent',
      bash: { access: 'full' },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('bash.access: full not allowed'))).toBe(true);
  });

  it('allows bash.access: full in global agents', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'global-full',
      bash: { access: 'full' },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('allows bash.access: full in system agents', async () => {
    mkProject('', 'Global');
    mkProject('system', 'System');
    mkAgent('system', {
      ...VALID_AGENT,
      name: 'sys-full',
      bash: { access: 'full' },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('reports projects nested too deep (>3 levels)', async () => {
    mkProject('', 'Global');
    mkProject('a', 'Level 1');
    mkProject('a/b', 'Level 2');
    mkProject('a/b/c', 'Level 3');
    mkProject('a/b/c/d', 'Level 4 - too deep');

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('nested too deep'))).toBe(true);
  });

  it('reports duplicate agent names in same scope', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');

    // Create two agents with same name (different files)
    const agentsDir = join(tmpDir, 'work', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'helper.yaml'), yamlDump(VALID_AGENT));
    writeFileSync(
      join(agentsDir, 'helper-v2.yaml'),
      yamlDump({ ...VALID_AGENT, displayName: 'Duplicate' }),
    );

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('Duplicate agent name'))).toBe(true);
  });

  it('passes for valid template', async () => {
    mkProject('', 'Global');
    mkTemplate('', VALID_TEMPLATE);

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('reports invalid template YAML', async () => {
    mkProject('', 'Global');
    const templatesDir = join(tmpDir, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // Missing required fields (no tasks, no displayName)
    writeFileSync(join(templatesDir, 'bad.yaml'), yamlDump({ name: 'bad' }));

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('Invalid template YAML'))).toBe(true);
  });

  it('reports template with circular blockedBy', async () => {
    mkProject('', 'Global');
    mkTemplate('', {
      name: 'cycle-template',
      displayName: 'Cycle Template',
      tasks: [
        {
          id: 'a',
          type: 'agent',
          title: 'Task A',
          prompt: 'Do A',
          blockedBy: ['b'],
        },
        {
          id: 'b',
          type: 'agent',
          title: 'Task B',
          prompt: 'Do B',
          blockedBy: ['a'],
        },
      ],
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('circular dependency'))).toBe(true);
  });

  it('warns when bash config deniedPaths is missing .env', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'bash-agent',
      bash: { access: 'sandboxed', deniedPaths: ['.git'] },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('.env'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('.git'))).toBe(false);
  });

  it('warns when bash config deniedPaths is missing .git', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'bash-agent',
      bash: { access: 'sandboxed', deniedPaths: ['.env'] },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('.git'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('.env'))).toBe(false);
  });

  it('warns for both .env and .git when deniedPaths is empty', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      ...VALID_AGENT,
      name: 'bash-agent',
      bash: { access: 'sandboxed', deniedPaths: [] },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('.env'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('.git'))).toBe(true);
  });

  it('does not warn for deniedPaths when bash.access is none', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'no-bash-agent',
      bash: { access: 'none' },
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('errors when agent references an unknown skill', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      ...VALID_AGENT,
      name: 'skilled-agent',
      skills: ['nonexistent-skill'],
    });

    const result = await validateProjects(tmpDir, {
      knownSkills: new Set(['ticktick', 'gmail']),
    });
    expect(result.errors.some((e) => e.includes('unknown skill "nonexistent-skill"'))).toBe(true);
  });

  it('does not error when all skills match known skills', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      ...VALID_AGENT,
      name: 'skilled-agent',
      skills: ['ticktick', 'gmail'],
    });

    const result = await validateProjects(tmpDir, {
      knownSkills: new Set(['ticktick', 'gmail']),
    });
    expect(result.errors).toEqual([]);
  });

  it('skips skill validation when knownSkills is not provided', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'skilled-agent',
      skills: ['any-skill-name'],
    });

    const result = await validateProjects(tmpDir);
    expect(result.errors).toEqual([]);
  });
});
