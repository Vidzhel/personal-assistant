import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dump as yamlDump } from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { validateProjects } from '../project-registry/project-validator.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-validator-'));
});

afterEach(() => {
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
  it('returns no errors for valid structure', async () => {
    mkProject('', 'Global context');
    mkProject('work', 'Work project');
    mkAgent('', VALID_AGENT);
    mkAgent('work', { ...VALID_AGENT, name: 'work-agent' });
    mkSchedule('', VALID_SCHEDULE);

    const errors = await validateProjects(tmpDir);
    expect(errors).toEqual([]);
  });

  it('reports invalid agent YAML', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');

    // Write invalid agent YAML (missing required fields)
    const agentsDir = join(tmpDir, 'work', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'bad.yaml'), yamlDump({ name: 'BAD NAME!!' }));

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('Invalid agent YAML'))).toBe(true);
  });

  it('reports invalid schedule YAML', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');

    // Write invalid schedule YAML (missing required fields)
    const schedulesDir = join(tmpDir, 'work', 'schedules');
    mkdirSync(schedulesDir, { recursive: true });
    writeFileSync(join(schedulesDir, 'bad.yaml'), yamlDump({ name: 'bad' }));

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('Invalid schedule YAML'))).toBe(true);
  });

  it('reports bash.access: full outside global/system', async () => {
    mkProject('', 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      ...VALID_AGENT,
      name: 'full-bash-agent',
      bash: { access: 'full' },
    });

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('bash.access: full not allowed'))).toBe(true);
  });

  it('allows bash.access: full in global agents', async () => {
    mkProject('', 'Global');
    mkAgent('', {
      ...VALID_AGENT,
      name: 'global-full',
      bash: { access: 'full' },
    });

    const errors = await validateProjects(tmpDir);
    expect(errors).toEqual([]);
  });

  it('allows bash.access: full in system agents', async () => {
    mkProject('', 'Global');
    mkProject('system', 'System');
    mkAgent('system', {
      ...VALID_AGENT,
      name: 'sys-full',
      bash: { access: 'full' },
    });

    const errors = await validateProjects(tmpDir);
    expect(errors).toEqual([]);
  });

  it('reports projects nested too deep (>3 levels)', async () => {
    mkProject('', 'Global');
    mkProject('a', 'Level 1');
    mkProject('a/b', 'Level 2');
    mkProject('a/b/c', 'Level 3');
    mkProject('a/b/c/d', 'Level 4 - too deep');

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('nested too deep'))).toBe(true);
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

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('Duplicate agent name'))).toBe(true);
  });

  it('passes for valid template', async () => {
    mkProject('', 'Global');
    mkTemplate('', VALID_TEMPLATE);

    const errors = await validateProjects(tmpDir);
    expect(errors).toEqual([]);
  });

  it('reports invalid template YAML', async () => {
    mkProject('', 'Global');
    const templatesDir = join(tmpDir, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // Missing required fields (no tasks, no displayName)
    writeFileSync(join(templatesDir, 'bad.yaml'), yamlDump({ name: 'bad' }));

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('Invalid template YAML'))).toBe(true);
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

    const errors = await validateProjects(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('circular dependency'))).toBe(true);
  });
});
