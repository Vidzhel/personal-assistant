import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase } from '../db/database.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import type { TaskStore } from '../task-manager/task-store.ts';

function makeMockEventBus(): {
  emit: (event: unknown) => void;
  on: (type: string, handler: (event: unknown) => void) => void;
  off: (type: string, handler: (event: unknown) => void) => void;
} {
  return {
    emit: vi.fn((_event: unknown) => undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('queryTasks scheduleId filter', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-schedfilter-'));
    const db = initDatabase(join(dir, 't.db'));
    const eventBus = makeMockEventBus();
    store = createTaskStore({
      db: {
        run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
        get: <T>(sql: string, ...params: unknown[]) =>
          db.prepare(sql).get(...params) as T | undefined,
        all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
      },
      eventBus,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters tasks by scheduleId', () => {
    store.createTask({
      title: 'from-sched',
      source: 'scheduled',
      scheduleId: 'morning-digest',
      status: 'todo',
    });
    store.createTask({
      title: 'manual',
      source: 'manual',
      status: 'todo',
    });

    const result = store.queryTasks({ scheduleId: 'morning-digest' });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('from-sched');
  });

  it('returns all tasks when scheduleId filter is omitted', () => {
    store.createTask({
      title: 'sched-task',
      scheduleId: 'evening-report',
    });
    store.createTask({
      title: 'no-sched-task',
    });

    const result = store.queryTasks({});
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array when scheduleId matches nothing', () => {
    store.createTask({ title: 'unrelated', scheduleId: 'other-schedule' });

    const result = store.queryTasks({ scheduleId: 'nonexistent-schedule' });
    expect(result).toHaveLength(0);
  });
});
