import { describe, it, expect } from 'vitest';
import { statusToColumn, buildBoard } from '@/components/board/board-model';
import type { RavenTaskRecord, TaskTreeRecord } from '@/lib/api-client';

function task(over: Partial<RavenTaskRecord> = {}): RavenTaskRecord {
  return {
    id: 't1',
    title: 'Task',
    status: 'todo',
    source: 'manual',
    artifacts: [],
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...over,
  } as RavenTaskRecord;
}
function tree(over: Partial<TaskTreeRecord> = {}): TaskTreeRecord {
  return {
    id: 'tree1',
    status: 'running',
    taskCount: 5,
    completedCount: 3,
    createdAt: '2026-06-13T00:00:00.000Z',
    ...over,
  } as TaskTreeRecord;
}

describe('statusToColumn', () => {
  it('maps statuses to the approved columns', () => {
    expect(statusToColumn('todo')).toBe('todo');
    expect(statusToColumn('pending_approval')).toBe('todo');
    expect(statusToColumn('waiting-approval')).toBe('todo');
    expect(statusToColumn('in_progress')).toBe('in_progress');
    expect(statusToColumn('running')).toBe('in_progress');
    expect(statusToColumn('validating')).toBe('in_progress');
    expect(statusToColumn('completed')).toBe('done');
    expect(statusToColumn('cancelled')).toBe('done');
    expect(statusToColumn('blocked')).toBe('blocked');
    expect(statusToColumn('failed')).toBe('blocked');
  });
  it('returns null for archived (excluded)', () => {
    expect(statusToColumn('archived')).toBeNull();
  });
  it('returns null for unknown statuses', () => {
    expect(statusToColumn('weird')).toBeNull();
  });
});

describe('buildBoard', () => {
  it('places tasks and plans into columns with source/kind', () => {
    const board = buildBoard(
      [
        task({ id: 'a', status: 'todo', source: 'manual' }),
        task({ id: 'b', status: 'in_progress', source: 'scheduled' }),
      ],
      [tree({ id: 'p', status: 'running' })],
    );
    const todo = board.todo.map((c) => c.id);
    const inProg = board.in_progress;
    expect(todo).toContain('a');
    expect(inProg.find((c) => c.id === 'b')?.source).toBe('scheduled');
    const plan = inProg.find((c) => c.id === 'p');
    expect(plan?.kind).toBe('plan');
    expect(plan?.source).toBe('plan');
    expect(plan?.progress).toEqual({ completed: 3, total: 5 });
  });

  it('excludes archived tasks', () => {
    const board = buildBoard([task({ id: 'x', status: 'archived' })], []);
    const all = [...board.todo, ...board.in_progress, ...board.done, ...board.blocked];
    expect(all.find((c) => c.id === 'x')).toBeUndefined();
  });

  it('marks manual tasks draggable and others not', () => {
    const board = buildBoard(
      [task({ id: 'm', source: 'manual' }), task({ id: 's', source: 'scheduled' })],
      [],
    );
    expect(board.todo.find((c) => c.id === 'm')?.draggable).toBe(true);
    expect(board.todo.find((c) => c.id === 's')?.draggable).toBe(false);
  });

  it('trims Done to recent items when a cutoff is given', () => {
    const old = task({ id: 'old', status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' });
    const recent = task({
      id: 'recent',
      status: 'completed',
      updatedAt: '2026-06-13T00:00:00.000Z',
    });
    const board = buildBoard([old, recent], [], {
      doneSinceMs: Date.parse('2026-06-12T00:00:00.000Z'),
    });
    const doneIds = board.done.map((c) => c.id);
    expect(doneIds).toContain('recent');
    expect(doneIds).not.toContain('old');
  });
});
