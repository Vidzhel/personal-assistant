import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';

function makeMockEventBus(): { emit: () => void; on: () => void; off: () => void } {
  return {
    emit: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
}

describe('task_trees schedule_id stamping', () => {
  let dir: string;
  let projectsDir: string;
  const projects = [{ id: 'meta', fsPath: 'system' }];
  let engine: TaskExecutionEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-tree-sched-'));
    projectsDir = join(dir, 'projects');
    mkdirSync(join(projectsDir, 'system'), { recursive: true });
    engine = new TaskExecutionEngine({
      projectsDir,
      projects: () => projects,
      eventBus: makeMockEventBus(),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists scheduleId on createTree and reads it back', () => {
    const tree = engine.createTree({
      id: 'tree-1',
      scheduleId: 'morning-digest',
      plan: 'p',
      tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
    });
    expect(tree.scheduleId).toBe('morning-digest');

    const reloaded = engine.getTree('tree-1');
    expect(reloaded?.scheduleId).toBe('morning-digest');
  });

  it('leaves scheduleId undefined when not provided', () => {
    const tree = engine.createTree({
      id: 'tree-2',
      tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
    });
    expect(tree.scheduleId).toBeUndefined();
  });
});
