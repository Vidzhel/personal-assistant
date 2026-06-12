import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase } from '../db/database.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';

function makeDbInterface(db: ReturnType<typeof initDatabase>): {
  run: (sql: string, ...params: unknown[]) => void;
  get: <T>(sql: string, ...params: unknown[]) => T | undefined;
  all: <T>(sql: string, ...params: unknown[]) => T[];
} {
  return {
    run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
    get: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  };
}

function makeMockEventBus(): { emit: () => void; on: () => void; off: () => void } {
  return {
    emit: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
}

describe('task_trees schedule_id stamping', () => {
  let dir: string;
  let engine: TaskExecutionEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-tree-sched-'));
    const rawDb = initDatabase(join(dir, 'test.db'));
    const db = makeDbInterface(rawDb);
    engine = new TaskExecutionEngine({ db, eventBus: makeMockEventBus() });
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
