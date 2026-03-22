import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import type { TaskStore } from '../task-manager/task-store.ts';
import type { TaskCreateInput, RavenTask } from '@raven/shared';

function makeMockEventBus() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    emit: vi.fn((event: any) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
    events,
  };
}

function makeInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    title: `Test task ${Math.random().toString(36).slice(2, 6)}`,
    ...overrides,
  };
}

describe('TaskStore', () => {
  let tmpDir: string;
  let store: TaskStore;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-taskstore-'));
    const db = initDatabase(join(tmpDir, 'test.db'));
    eventBus = makeMockEventBus();
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

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('creates a task with all required fields', () => {
      const task = store.createTask(makeInput({ title: 'My Task' }));
      expect(task.id).toBeDefined();
      expect(task.title).toBe('My Task');
      expect(task.status).toBe('todo');
      expect(task.source).toBe('manual');
      expect(task.artifacts).toEqual([]);
      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('creates a task with optional fields', () => {
      const task = store.createTask(
        makeInput({
          title: 'Full task',
          description: 'A description',
          prompt: 'Do the thing',
          status: 'in_progress',
          assignedAgentId: 'agent-1',
          projectId: 'proj-1',
          pipelineId: 'pipe-1',
          scheduleId: 'sched-1',
          source: 'agent',
          externalId: 'ext-1',
          artifacts: ['file1.txt'],
        }),
      );

      expect(task.description).toBe('A description');
      expect(task.prompt).toBe('Do the thing');
      expect(task.status).toBe('in_progress');
      expect(task.assignedAgentId).toBe('agent-1');
      expect(task.projectId).toBe('proj-1');
      expect(task.pipelineId).toBe('pipe-1');
      expect(task.scheduleId).toBe('sched-1');
      expect(task.source).toBe('agent');
      expect(task.externalId).toBe('ext-1');
      expect(task.artifacts).toEqual(['file1.txt']);
    });

    it('emits task:created event', () => {
      const before = eventBus.events.length;
      store.createTask(makeInput({ title: 'Event test' }));
      const created = eventBus.events.slice(before).find((e: any) => e.type === 'task:created');
      expect(created).toBeDefined();
      expect(created!.payload.title).toBe('Event test');
    });
  });

  describe('getTask', () => {
    it('returns task by id', () => {
      const created = store.createTask(makeInput({ title: 'Get me' }));
      const found = store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Get me');
    });

    it('returns undefined for nonexistent id', () => {
      expect(store.getTask('nonexistent')).toBeUndefined();
    });
  });

  describe('updateTask', () => {
    it('updates specified fields', () => {
      const created = store.createTask(makeInput({ title: 'Original' }));
      const updated = store.updateTask(created.id, {
        title: 'Updated',
        description: 'New desc',
        status: 'in_progress',
      });
      expect(updated.title).toBe('Updated');
      expect(updated.description).toBe('New desc');
      expect(updated.status).toBe('in_progress');
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
    });

    it('sets nullable fields to null', () => {
      const created = store.createTask(
        makeInput({
          title: 'Nullable',
          assignedAgentId: 'agent-1',
        }),
      );
      const updated = store.updateTask(created.id, { assignedAgentId: null });
      expect(updated.assignedAgentId).toBeUndefined();
    });

    it('throws for nonexistent task', () => {
      expect(() => store.updateTask('nonexistent', { title: 'x' })).toThrow('Task not found');
    });

    it('emits task:updated event with changes list', () => {
      const created = store.createTask(makeInput({ title: 'Update event' }));
      const before = eventBus.events.length;
      store.updateTask(created.id, { title: 'Changed' });
      const updated = eventBus.events.slice(before).find((e: any) => e.type === 'task:updated');
      expect(updated).toBeDefined();
      expect(updated!.payload.changes).toContain('title');
    });
  });

  describe('completeTask', () => {
    it('sets status, completed_at, and merges artifacts', () => {
      const created = store.createTask(
        makeInput({
          title: 'Complete me',
          artifacts: ['existing.txt'],
        }),
      );
      const completed = store.completeTask(created.id, ['new.txt']);
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(completed.artifacts).toEqual(['existing.txt', 'new.txt']);
    });

    it('emits task:completed event', () => {
      const created = store.createTask(makeInput({ title: 'Complete event' }));
      const before = eventBus.events.length;
      store.completeTask(created.id);
      const completed = eventBus.events.slice(before).find((e: any) => e.type === 'task:completed');
      expect(completed).toBeDefined();
    });

    it('throws for nonexistent task', () => {
      expect(() => store.completeTask('nonexistent')).toThrow('Task not found');
    });
  });

  describe('subtasks', () => {
    it('creates parent-child relationship and queries subtasks', () => {
      const parent = store.createTask(makeInput({ title: 'Parent' }));
      store.createTask(
        makeInput({
          title: 'Child 1',
          parentTaskId: parent.id,
          projectId: 'proj-inherit',
        }),
      );
      store.createTask(
        makeInput({
          title: 'Child 2',
          parentTaskId: parent.id,
        }),
      );

      const subtasks = store.getSubtasks(parent.id);
      expect(subtasks).toHaveLength(2);
      expect(subtasks[0].title).toBe('Child 1');
      expect(subtasks[1].title).toBe('Child 2');
    });
  });

  describe('queryTasks', () => {
    it('excludes archived by default', () => {
      const task = store.createTask(makeInput({ title: 'To archive' }));
      store.completeTask(task.id);
      // Force archive by directly updating
      getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);

      const results = store.queryTasks({});
      const found = results.find((t: RavenTask) => t.id === task.id);
      expect(found).toBeUndefined();
    });

    it('includes archived when requested', () => {
      const results = store.queryTasks({ includeArchived: true });
      const archived = results.find((t: RavenTask) => t.status === 'archived');
      expect(archived).toBeDefined();
    });

    it('filters by status', () => {
      store.createTask(makeInput({ title: 'Todo filter', status: 'todo' }));
      const results = store.queryTasks({ status: 'todo' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.status).toBe('todo');
      }
    });

    it('filters by projectId', () => {
      store.createTask(makeInput({ title: 'Project filter', projectId: 'proj-filter' }));
      const results = store.queryTasks({ projectId: 'proj-filter' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.projectId).toBe('proj-filter');
      }
    });

    it('filters by source', () => {
      store.createTask(makeInput({ title: 'Source filter', source: 'template' }));
      const results = store.queryTasks({ source: 'template' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.source).toBe('template');
      }
    });

    it('searches title and description', () => {
      store.createTask(
        makeInput({
          title: 'Unicorn rainbow task',
          description: 'Something unique',
        }),
      );
      const byTitle = store.queryTasks({ search: 'unicorn' });
      expect(byTitle.length).toBeGreaterThanOrEqual(1);

      const byDesc = store.queryTasks({ search: 'unique' });
      expect(byDesc.length).toBeGreaterThanOrEqual(1);
    });

    it('respects limit and offset', () => {
      const all = store.queryTasks({ limit: 100 });
      const page = store.queryTasks({ limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
      expect(page[0].id).toBe(all[1].id);
    });

    it('orders by created_at DESC', () => {
      const results = store.queryTasks({ limit: 100 });
      for (let i = 1; i < results.length; i++) {
        expect(new Date(results[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(results[i].createdAt).getTime(),
        );
      }
    });
  });

  describe('archiveCompletedTasks', () => {
    it('archives tasks completed more than 24h ago', () => {
      const task = store.createTask(makeInput({ title: 'Old completed' }));
      store.completeTask(task.id);
      // Backdate completed_at to 25h ago
      const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      getDb().prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(pastDate, task.id);

      const count = store.archiveCompletedTasks();
      expect(count).toBeGreaterThanOrEqual(1);

      const archived = store.getTask(task.id);
      expect(archived!.status).toBe('archived');
    });

    it('does not archive recently completed tasks', () => {
      const task = store.createTask(makeInput({ title: 'Recent completed' }));
      store.completeTask(task.id);

      store.archiveCompletedTasks();
      const found = store.getTask(task.id);
      expect(found!.status).toBe('completed');
    });
  });

  describe('getTaskCountsByStatus', () => {
    it('returns counts for each status', () => {
      const counts = store.getTaskCountsByStatus();
      expect(typeof counts.todo).toBe('number');
      expect(typeof counts.in_progress).toBe('number');
      expect(typeof counts.completed).toBe('number');
      expect(typeof counts.archived).toBe('number');
    });

    it('filters by projectId', () => {
      store.createTask(makeInput({ title: 'Count proj', projectId: 'count-proj', status: 'todo' }));
      const counts = store.getTaskCountsByStatus('count-proj');
      expect(counts.todo).toBeGreaterThanOrEqual(1);
    });
  });

  describe('source + external_id uniqueness', () => {
    it('prevents duplicate source + external_id combination', () => {
      store.createTask(
        makeInput({
          title: 'TickTick 1',
          source: 'ticktick',
          externalId: 'tt-unique-1',
        }),
      );
      expect(() =>
        store.createTask(
          makeInput({
            title: 'TickTick 1 dup',
            source: 'ticktick',
            externalId: 'tt-unique-1',
          }),
        ),
      ).toThrow();
    });
  });
});
