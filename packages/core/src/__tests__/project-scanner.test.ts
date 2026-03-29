import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dump as yamlDump } from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { scanProjects } from '../project-registry/project-scanner.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-scanner-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(relPath: string, contextMd = 'Project context'): string {
  const dir = join(tmpDir, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), contextMd);
  return dir;
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

describe('scanProjects', () => {
  it('scans flat project structure', async () => {
    // Global context
    writeFileSync(join(tmpDir, 'context.md'), 'Global context');
    mkProject('work', 'Work project');

    const index = await scanProjects(tmpDir);

    expect(index.projects.size).toBe(2);
    expect(index.projects.get('_global')).toBeDefined();
    expect(index.projects.get('work')).toBeDefined();
    expect(index.projects.get('work')!.contextMd).toBe('Work project');
    expect(index.rootProjects).toEqual(['work']);
  });

  it('scans nested sub-projects', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('uni', 'University');
    mkProject('uni/calculus', 'Calculus');
    mkProject('uni/physics', 'Physics');

    const index = await scanProjects(tmpDir);

    expect(index.projects.size).toBe(4);

    const uni = index.projects.get('uni')!;
    expect(uni.parentId).toBe('_global');
    expect(uni.children).toContain('uni/calculus');
    expect(uni.children).toContain('uni/physics');

    const calc = index.projects.get('uni/calculus')!;
    expect(calc.parentId).toBe('uni');
    expect(calc.contextMd).toBe('Calculus');

    const phys = index.projects.get('uni/physics')!;
    expect(phys.parentId).toBe('uni');

    expect(index.rootProjects).toEqual(['uni']);
  });

  it('loads agent YAML files', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('work', 'Work');
    mkAgent('work', {
      name: 'code-helper',
      displayName: 'Code Helper',
      description: 'Helps with code',
    });

    const index = await scanProjects(tmpDir);
    const work = index.projects.get('work')!;

    expect(work.agents).toHaveLength(1);
    expect(work.agents[0].name).toBe('code-helper');
    expect(work.agents[0].displayName).toBe('Code Helper');
  });

  it('loads schedule YAML files', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('work', 'Work');
    mkSchedule('work', {
      name: 'daily-digest',
      cron: '0 9 * * *',
      template: 'digest',
    });

    const index = await scanProjects(tmpDir);
    const work = index.projects.get('work')!;

    expect(work.schedules).toHaveLength(1);
    expect(work.schedules[0].name).toBe('daily-digest');
    expect(work.schedules[0].cron).toBe('0 9 * * *');
  });

  it('identifies system/ as meta-project', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('system', 'System project');

    const index = await scanProjects(tmpDir);
    const system = index.projects.get('system')!;

    expect(system.isMeta).toBe(true);
  });

  it('skips directories without context.md', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('real-project', 'Real');
    // Create a dir without context.md
    mkdirSync(join(tmpDir, 'not-a-project'), { recursive: true });

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('real-project')).toBe(true);
    expect(index.projects.has('not-a-project')).toBe(false);
  });

  it('sets correct parent-child relationships', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('uni', 'Uni');
    mkProject('uni/calculus', 'Calc');
    mkProject('uni/calculus/homework', 'HW');

    const index = await scanProjects(tmpDir);

    const global = index.projects.get('_global')!;
    expect(global.parentId).toBeNull();
    expect(global.children).toContain('uni');

    const uni = index.projects.get('uni')!;
    expect(uni.parentId).toBe('_global');
    expect(uni.children).toContain('uni/calculus');

    const calc = index.projects.get('uni/calculus')!;
    expect(calc.parentId).toBe('uni');
    expect(calc.children).toContain('uni/calculus/homework');

    const hw = index.projects.get('uni/calculus/homework')!;
    expect(hw.parentId).toBe('uni/calculus');
    expect(hw.children).toHaveLength(0);
  });

  it('handles empty projects directory gracefully', async () => {
    // No context.md at root, no subdirs
    const index = await scanProjects(tmpDir);

    // _global still created but with empty contextMd
    expect(index.projects.size).toBe(1);
    const global = index.projects.get('_global')!;
    expect(global.contextMd).toBe('');
    expect(index.rootProjects).toEqual([]);
  });

  it('skips invalid YAML files gracefully', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('work', 'Work');
    const agentsDir = join(tmpDir, 'work', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'bad.yaml'), 'this: is: invalid: yaml: [');

    const index = await scanProjects(tmpDir);
    const work = index.projects.get('work')!;
    expect(work.agents).toHaveLength(0);
  });

  it('skips dot-prefixed directories', async () => {
    writeFileSync(join(tmpDir, 'context.md'), 'Global');
    mkProject('.hidden', 'Hidden');

    const index = await scanProjects(tmpDir);
    expect(index.projects.has('.hidden')).toBe(false);
  });
});
