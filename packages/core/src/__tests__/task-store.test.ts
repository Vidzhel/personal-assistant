import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskStore } from '../task-manager/task-store.ts';
import type { TaskCreateInput, RavenTask } from '@raven/shared';
import { parse, stringify } from 'yaml';
import { createTaskStoreFixture } from './fixtures/task-store.ts';

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

function boardFiles(tmpDir: string, project = 'system'): string[] {
  const path = join(tmpDir, 'projects', project, 'tasks', 'board');
  try {
    return readdirSync(path)
      .filter((name) => name.endsWith('.yaml'))
      .sort();
  } catch {
    return [];
  }
}

describe('TaskStore', () => {
  let tmpDir: string;
  let store: TaskStore;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-taskstore-'));
    eventBus = makeMockEventBus();
    store = createTaskStoreFixture(join(tmpDir, 'projects'), eventBus);
  });

  afterAll(() => {
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

    it('stamps completedAt when created completed', () => {
      const task = store.createTask(makeInput({ title: 'Already done', status: 'completed' }));
      expect(task.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    it('is idempotent for repeated artifacts and timestamps', () => {
      const created = store.createTask(makeInput({ title: 'Repeat completion' }));
      const first = store.completeTask(created.id, ['same.txt']);
      const second = store.completeTask(created.id, ['same.txt']);
      expect(second.artifacts).toEqual(['same.txt']);
      expect(second.completedAt).toBe(first.completedAt);
      expect(second.updatedAt).toBe(first.updatedAt);
    });

    it('clears completedAt when reopened', () => {
      const created = store.createTask(makeInput({ title: 'Reopen me' }));
      store.completeTask(created.id);
      const reopened = store.updateTask(created.id, { status: 'todo' });
      expect(reopened.completedAt).toBeUndefined();
    });
  });

  describe('subtasks', () => {
    it('creates parent-child relationship and queries subtasks', () => {
      const parent = store.createTask(makeInput({ title: 'Parent', projectId: 'proj-inherit' }));
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
          projectId: 'proj-inherit',
        }),
      );

      const subtasks = store.getSubtasks(parent.id);
      expect(subtasks).toHaveLength(2);
      expect(subtasks[0].title).toBe('Child 1');
      expect(subtasks[1].title).toBe('Child 2');
    });

    it('rejects a parent-child relationship across projects', () => {
      const parent = store.createTask(makeInput({ title: 'Project parent' }));
      expect(() =>
        store.createTask(
          makeInput({ title: 'Foreign child', parentTaskId: parent.id, projectId: 'proj-inherit' }),
        ),
      ).toThrow(/same project/);
    });

    it('rejects an unknown parent without writing or emitting', () => {
      const beforeFiles = boardFiles(tmpDir);
      const beforeEvents = eventBus.events.length;
      expect(() => store.createTask(makeInput({ parentTaskId: 'missing-parent' }))).toThrow(
        'Unknown parent task',
      );
      expect(boardFiles(tmpDir)).toEqual(beforeFiles);
      expect(eventBus.events.length).toBe(beforeEvents);
    });

    it('rejects a cross-project parent without writing or emitting', () => {
      const parent = store.createTask(makeInput({ title: 'Foreign parent' }));
      const beforeFiles = boardFiles(tmpDir, 'proj-inherit');
      const beforeEvents = eventBus.events.length;
      expect(() =>
        store.createTask(makeInput({ parentTaskId: parent.id, projectId: 'proj-inherit' })),
      ).toThrow('same project');
      expect(boardFiles(tmpDir, 'proj-inherit')).toEqual(beforeFiles);
      expect(eventBus.events.length).toBe(beforeEvents);
    });

    it('rejects a parent cycle without changing bytes', () => {
      const parent = store.createTask(makeInput({ title: 'Cycle parent', projectId: 'proj-1' }));
      const child = store.createTask(
        makeInput({ title: 'Cycle child', projectId: 'proj-1', parentTaskId: parent.id }),
      );
      const path = join(tmpDir, 'projects', 'proj-1', 'tasks', 'board', `${parent.id}.yaml`);
      const before = readFileSync(path, 'utf8');
      expect(() => store.updateTask(parent.id, { parentTaskId: child.id })).toThrow('cycle');
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('rejects moving a parent while its child remains behind', () => {
      const parent = store.createTask(makeInput({ title: 'Move parent', projectId: 'proj-1' }));
      store.createTask(
        makeInput({ title: 'Move child', projectId: 'proj-1', parentTaskId: parent.id }),
      );
      const source = join(tmpDir, 'projects', 'proj-1', 'tasks', 'board', `${parent.id}.yaml`);
      const before = readFileSync(source, 'utf8');
      expect(() => store.updateTask(parent.id, { projectId: 'proj-2' })).toThrow('child remains');
      expect(readFileSync(source, 'utf8')).toBe(before);
      expect(boardFiles(tmpDir, 'proj-2')).not.toContain(`${parent.id}.yaml`);
    });

    it('moves a task across projects and reopens it from a new store', () => {
      const task = store.createTask(makeInput({ title: 'Transfer', projectId: 'proj-1' }));
      const source = join(tmpDir, 'projects', 'proj-1', 'tasks', 'board', `${task.id}.yaml`);
      const destination = join(tmpDir, 'projects', 'proj-2', 'tasks', 'board', `${task.id}.yaml`);
      const moved = store.updateTask(task.id, { projectId: 'proj-2' });
      expect(moved.projectId).toBe('proj-2');
      expect(readFileSync(destination, 'utf8')).toContain('projectId: proj-2');
      expect(() => readFileSync(source, 'utf8')).toThrow();
      expect(
        createTaskStoreFixture(join(tmpDir, 'projects'), eventBus).getTask(task.id)?.projectId,
      ).toBe('proj-2');
    });
  });

  describe('queryTasks', () => {
    it('excludes archived by default', () => {
      const task = store.createTask(makeInput({ title: 'To archive' }));
      store.completeTask(task.id);
      // Force archive by updating the authoritative file.
      const path = join(tmpDir, 'projects', 'system', 'tasks', 'board', `${task.id}.yaml`);
      const record = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      record.status = 'archived';
      writeFileSync(path, stringify(record));

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
      // Backdate completedAt in the authoritative file.
      const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const path = join(tmpDir, 'projects', 'system', 'tasks', 'board', `${task.id}.yaml`);
      const record = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      record.completedAt = pastDate;
      writeFileSync(path, stringify(record));

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
