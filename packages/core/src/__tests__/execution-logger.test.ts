import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { AgentTask, RavenEvent } from '@raven/shared';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    skillName: 'test-skill',
    prompt: 'do something',
    status: 'running',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('ExecutionLogger', () => {
  let tmpDir: string;
  let logger: ReturnType<typeof createExecutionLogger>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-exlog-'));
    initDatabase(join(tmpDir, 'test.db'));
    logger = createExecutionLogger({ db: getDb() });
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logTaskStart inserts a row', () => {
    const task = makeTask({ id: 'start-1', actionName: 'test:action' });
    logger.logTaskStart(task);

    const record = logger.getTaskById('start-1');
    expect(record).toBeDefined();
    expect(record!.skillName).toBe('test-skill');
    expect(record!.actionName).toBe('test:action');
    expect(record!.status).toBe('running');
    expect(record!.createdAt).toBeDefined();
  });

  it('logTaskComplete updates the row', () => {
    const task = makeTask({ id: 'complete-1' });
    logger.logTaskStart(task);

    task.status = 'completed';
    task.result = 'done';
    task.durationMs = 150;
    task.completedAt = Date.now();
    logger.logTaskComplete(task);

    const record = logger.getTaskById('complete-1');
    expect(record!.status).toBe('completed');
    expect(record!.result).toBe('done');
    expect(record!.durationMs).toBe(150);
    expect(record!.completedAt).toBeDefined();
    expect(record!.blocked).toBe(false);
  });

  it('logTaskComplete sets blocked flag', () => {
    const task = makeTask({ id: 'blocked-1' });
    logger.logTaskStart(task);

    task.status = 'blocked';
    task.completedAt = Date.now();
    logger.logTaskComplete(task);

    const record = logger.getTaskById('blocked-1');
    expect(record!.status).toBe('blocked');
    expect(record!.blocked).toBe(true);
  });

  it('logTaskComplete stores errors as JSON', () => {
    const task = makeTask({ id: 'error-1' });
    logger.logTaskStart(task);

    task.status = 'failed';
    task.errors = ['error one', 'error two'];
    task.completedAt = Date.now();
    logger.logTaskComplete(task);

    const record = logger.getTaskById('error-1');
    expect(record!.errors).toEqual(['error one', 'error two']);
  });

  it('queryTasks returns records ordered by created_at DESC', () => {
    const tasks = logger.queryTasks({});
    expect(tasks.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(tasks[i].createdAt).getTime(),
      );
    }
  });

  it('queryTasks filters by skillName', () => {
    const task = makeTask({ id: 'filter-skill', skillName: 'unique-skill' });
    logger.logTaskStart(task);

    const results = logger.queryTasks({ skillName: 'unique-skill' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('filter-skill');
  });

  it('queryTasks filters by status', () => {
    const results = logger.queryTasks({ status: 'completed' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.status).toBe('completed');
    }
  });

  it('queryTasks respects limit and offset', () => {
    const all = logger.queryTasks({});
    const page = logger.queryTasks({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
    expect(page[0].id).toBe(all[1].id);
  });

  it('getTaskById returns undefined for nonexistent', () => {
    expect(logger.getTaskById('nonexistent')).toBeUndefined();
  });

  it('getTaskStats computes stats for recent tasks', () => {
    const stats = logger.getTaskStats(3_600_000);
    expect(stats.total1h).toBeGreaterThanOrEqual(1);
    expect(stats.succeeded1h).toBeGreaterThanOrEqual(1);
    expect(stats.failed1h).toBeGreaterThanOrEqual(1);
    expect(typeof stats.avgDurationMs).toBe('number');
    expect(stats.lastTaskAt).toBeDefined();
  });

  it('getTaskStats returns zeros for no matching tasks', () => {
    const stats = logger.getTaskStats(0); // sinceMs=0 means cutoff=now, nothing matches
    expect(stats.total1h).toBe(0);
    expect(stats.avgDurationMs).toBeNull();
    expect(stats.lastTaskAt).toBeNull();
  });

  it('timestamps are ISO 8601 strings', () => {
    const record = logger.getTaskById('complete-1');
    expect(record!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record!.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('Health alert event emission', () => {
  it('system:health:alert fires on task failure', () => {
    const eventBus = new EventBus();
    const received: RavenEvent[] = [];
    eventBus.on('system:health:alert', (e) => received.push(e));

    // Simulate what agent-manager does on failure
    eventBus.emit({
      id: 'test-alert-1',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'system:health:alert',
      payload: {
        severity: 'error' as const,
        source: 'agent-manager',
        message: 'Task test-1 failed: something broke',
        taskId: 'test-1',
      },
    });

    expect(received).toHaveLength(1);
    expect((received[0] as any).payload.severity).toBe('error');
    expect((received[0] as any).payload.taskId).toBe('test-1');
  });
});
