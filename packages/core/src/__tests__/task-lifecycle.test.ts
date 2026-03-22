import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import { createTaskLifecycle } from '../task-manager/task-lifecycle.ts';

function makeMockEventBus() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    emit: vi.fn((event: any) => {
      const typeHandlers = handlers.get(event.type);
      if (typeHandlers) {
        for (const h of typeHandlers) h(event);
      }
    }),
    on: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    }),
    off: vi.fn((type: string, handler: (event: unknown) => void) => {
      handlers.get(type)?.delete(handler);
    }),
    handlers,
  };
}

describe('TaskLifecycle', () => {
  let tmpDir: string;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-lifecycle-'));
    initDatabase(join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers both agent:task:request and agent:task:complete handlers on start', () => {
    eventBus = makeMockEventBus();
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus,
    });

    const lifecycle = createTaskLifecycle({ eventBus, taskStore });
    lifecycle.start();

    expect(eventBus.on).toHaveBeenCalledWith('agent:task:request', expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith('agent:task:complete', expect.any(Function));

    lifecycle.stop();
    expect(eventBus.off).toHaveBeenCalledWith('agent:task:request', expect.any(Function));
    expect(eventBus.off).toHaveBeenCalledWith('agent:task:complete', expect.any(Function));
  });

  it('auto-completes mapped RavenTask on successful agent completion', () => {
    eventBus = makeMockEventBus();
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus,
    });

    const lifecycle = createTaskLifecycle({ eventBus, taskStore });
    lifecycle.start();

    // Create a task assigned to a specific agent
    const task = taskStore.createTask({
      title: 'Agent work item',
      source: 'agent',
      status: 'in_progress',
      assignedAgentId: 'test-skill',
    });

    // Simulate agent task request — this creates the mapping
    eventBus.emit({
      id: 'req-1',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:request',
      payload: {
        taskId: 'agent-task-1',
        prompt: 'Do work',
        skillName: 'test-skill',
        mcpServers: {},
        priority: 'normal',
      },
    });

    // Simulate agent completion
    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: 'agent-task-1',
        result: 'Done. Created /data/output.txt',
        durationMs: 5000,
        success: true,
      },
    });

    const updated = taskStore.getTask(task.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.artifacts).toContain('/data/output.txt');

    lifecycle.stop();
  });

  it('does not complete tasks when agent fails', () => {
    eventBus = makeMockEventBus();
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus,
    });

    const lifecycle = createTaskLifecycle({ eventBus, taskStore });
    lifecycle.start();

    const task = taskStore.createTask({
      title: 'Failing agent work',
      source: 'agent',
      status: 'in_progress',
      assignedAgentId: 'fail-skill',
    });

    // Map the request
    eventBus.emit({
      id: 'req-2',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:request',
      payload: {
        taskId: 'agent-task-2',
        prompt: 'Do work',
        skillName: 'fail-skill',
        mcpServers: {},
        priority: 'normal',
      },
    });

    eventBus.emit({
      id: 'evt-2',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: 'agent-task-2',
        result: 'Error occurred',
        durationMs: 1000,
        success: false,
      },
    });

    const updated = taskStore.getTask(task.id);
    expect(updated?.status).toBe('in_progress'); // not completed

    lifecycle.stop();
  });

  it('does not complete unrelated tasks when a different agent completes', () => {
    eventBus = makeMockEventBus();
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus,
    });

    const lifecycle = createTaskLifecycle({ eventBus, taskStore });
    lifecycle.start();

    // Create two agent tasks for different skills
    const task1 = taskStore.createTask({
      title: 'Task for skill A',
      source: 'agent',
      status: 'in_progress',
      assignedAgentId: 'skill-a',
    });
    const task2 = taskStore.createTask({
      title: 'Task for skill B',
      source: 'agent',
      status: 'in_progress',
      assignedAgentId: 'skill-b',
    });

    // Only skill-a request is mapped
    eventBus.emit({
      id: 'req-3',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:request',
      payload: {
        taskId: 'agent-task-3',
        prompt: 'Do A',
        skillName: 'skill-a',
        mcpServers: {},
        priority: 'normal',
      },
    });

    // Skill A completes — only task1 should be affected
    eventBus.emit({
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: 'agent-task-3',
        result: 'Done',
        durationMs: 3000,
        success: true,
      },
    });

    expect(taskStore.getTask(task1.id)?.status).toBe('completed');
    expect(taskStore.getTask(task2.id)?.status).toBe('in_progress'); // untouched

    lifecycle.stop();
  });
});
