import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dump as yamlDump } from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ProjectRegistry } from '../project-registry/project-registry.ts';

let tmpDir: string;
let registry: ProjectRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-registry-'));
  registry = new ProjectRegistry();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(relPath: string, contextMd = 'Project context'): void {
  const dir = join(tmpDir, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), contextMd);
}

function mkAgent(relPath: string, agent: Record<string, unknown>): void {
  const agentsDir = join(tmpDir, relPath, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${agent.name}.yaml`), yamlDump(agent));
}

function mkSchedule(relPath: string, schedule: Record<string, unknown>): void {
  const schedulesDir = join(tmpDir, relPath, 'schedules');
  mkdirSync(schedulesDir, { recursive: true });
  writeFileSync(join(schedulesDir, `${schedule.name}.yaml`), yamlDump(schedule));
}

async function setupThreeLevels(): Promise<void> {
  writeFileSync(join(tmpDir, 'context.md'), 'Global instructions');
  mkProject('uni', 'University context');
  mkProject('uni/calculus', 'Calculus context');

  mkAgent('.', {
    name: 'default-agent',
    displayName: 'Default Agent',
    description: 'Global default',
  });
  mkAgent('uni', {
    name: 'study-helper',
    displayName: 'Study Helper',
    description: 'Helps study',
  });
  mkAgent('uni/calculus', {
    name: 'math-tutor',
    displayName: 'Math Tutor',
    description: 'Tutors math',
  });

  mkSchedule('.', {
    name: 'global-digest',
    cron: '0 9 * * *',
    template: 'digest',
  });
  mkSchedule('uni', {
    name: 'study-reminder',
    cron: '0 8 * * 1-5',
    template: 'reminder',
  });

  await registry.load(tmpDir);
}

describe('ProjectRegistry', () => {
  it('resolves context chain from root to leaf', async () => {
    await setupThreeLevels();

    const resolved = registry.resolveProjectContext('uni/calculus');

    expect(resolved.contextChain).toEqual([
      'Global instructions',
      'University context',
      'Calculus context',
    ]);
  });

  it('inherits agents from parent levels', async () => {
    await setupThreeLevels();

    const resolved = registry.resolveProjectContext('uni/calculus');

    expect(resolved.agents.size).toBe(3);
    expect(resolved.agents.has('default-agent')).toBe(true);
    expect(resolved.agents.has('study-helper')).toBe(true);
    expect(resolved.agents.has('math-tutor')).toBe(true);
  });

  it('deeper agent overrides same-name parent agent', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('work', 'Work');

    mkAgent('.', {
      name: 'assistant',
      displayName: 'Global Assistant',
      description: 'Global version',
      model: 'haiku',
    });
    mkAgent('work', {
      name: 'assistant',
      displayName: 'Work Assistant',
      description: 'Work-specific version',
      model: 'opus',
    });

    await registry.load(tmpDir);
    const resolved = registry.resolveProjectContext('work');

    expect(resolved.agents.size).toBe(1);
    const agent = resolved.agents.get('assistant')!;
    expect(agent.displayName).toBe('Work Assistant');
    expect(agent.model).toBe('opus');
  });

  it('lists all projects excluding _global', async () => {
    await setupThreeLevels();

    const projects = registry.listProjects();
    const ids = projects.map((p) => p.id);

    expect(ids).toContain('uni');
    expect(ids).toContain('uni/calculus');
    expect(ids).not.toContain('_global');
  });

  it('getProject returns a single node', async () => {
    await setupThreeLevels();

    const uni = registry.getProject('uni');
    expect(uni).toBeDefined();
    expect(uni!.name).toBe('uni');

    expect(registry.getProject('nonexistent')).toBeUndefined();
  });

  it('getProjectChildren returns direct children', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('uni', 'Uni');
    mkProject('uni/calculus', 'Calc');
    mkProject('uni/physics', 'Physics');
    mkProject('work', 'Work');

    await registry.load(tmpDir);

    const children = registry.getProjectChildren('uni');
    const childIds = children.map((c) => c.id);

    expect(childIds).toContain('uni/calculus');
    expect(childIds).toContain('uni/physics');
    expect(childIds).not.toContain('work');
  });

  it('schedules accumulate from all levels', async () => {
    await setupThreeLevels();

    const resolved = registry.resolveProjectContext('uni/calculus');

    expect(resolved.schedules).toHaveLength(2);
    const names = resolved.schedules.map((s) => s.name);
    expect(names).toContain('global-digest');
    expect(names).toContain('study-reminder');
  });

  it('getGlobal returns the _global node', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Root');
    await registry.load(tmpDir);

    const global = registry.getGlobal();
    expect(global.id).toBe('_global');
    expect(global.contextMd).toBe('Root');
  });

  it('getGlobal throws if load was not called', () => {
    expect(() => registry.getGlobal()).toThrow('load()');
  });
});
