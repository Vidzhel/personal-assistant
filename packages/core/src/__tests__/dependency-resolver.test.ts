import { describe, it, expect } from 'vitest';
import type { ExecutionTask, ExecutionTaskStatus, TaskTreeNode } from '@raven/shared';
import {
  validateDag,
  findReadyTasks,
  topologicalSort,
} from '../task-execution/dependency-resolver.ts';

function makeTask(
  id: string,
  blockedBy: string[] = [],
  status: ExecutionTaskStatus = 'todo',
): ExecutionTask {
  const node: TaskTreeNode = {
    id,
    title: `Task ${id}`,
    type: 'agent',
    prompt: `Do ${id}`,
    blockedBy,
  };

  return {
    id,
    parentTaskId: 'tree-1',
    node,
    status,
    artifacts: [],
    retryCount: 0,
  };
}

function tasksFromList(tasks: ExecutionTask[]): Map<string, ExecutionTask> {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe('validateDag', () => {
  it('accepts a valid DAG (a→b→d, a→c→d)', () => {
    const tasks = tasksFromList([
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['b', 'c']),
    ]);
    const errors = validateDag(tasks);
    expect(errors).toEqual([]);
  });

  it('detects cycles (a→b→a)', () => {
    const tasks = tasksFromList([
      makeTask('a', ['b']),
      makeTask('b', ['a']),
    ]);
    const errors = validateDag(tasks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Cycle detected involving tasks/);
    expect(errors[0]).toContain('a');
    expect(errors[0]).toContain('b');
  });

  it('detects missing dependencies', () => {
    const tasks = tasksFromList([
      makeTask('a', ['nonexistent']),
    ]);
    const errors = validateDag(tasks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Task 'a' references missing dependency 'nonexistent'/);
  });

  it('accepts empty task map', () => {
    const errors = validateDag(new Map());
    expect(errors).toEqual([]);
  });

  it('accepts single task with no deps', () => {
    const tasks = tasksFromList([makeTask('solo')]);
    const errors = validateDag(tasks);
    expect(errors).toEqual([]);
  });
});

describe('findReadyTasks', () => {
  it('returns tasks with no dependencies (status: todo)', () => {
    const tasks = tasksFromList([
      makeTask('a'),
      makeTask('b', ['a']),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['a']);
  });

  it('returns tasks whose deps are all completed', () => {
    const tasks = tasksFromList([
      makeTask('a', [], 'completed'),
      makeTask('b', ['a']),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['b']);
  });

  it('returns multiple independent ready tasks', () => {
    const tasks = tasksFromList([
      makeTask('a'),
      makeTask('b'),
      makeTask('c', ['a', 'b']),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(expect.arrayContaining(['a', 'b']));
    expect(ready).toHaveLength(2);
  });

  it('skips tasks already running/completed/failed', () => {
    const tasks = tasksFromList([
      makeTask('a', [], 'in_progress'),
      makeTask('b', [], 'completed'),
      makeTask('c', [], 'failed'),
      makeTask('d', [], 'ready'),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual([]);
  });

  it('treats skipped deps as satisfied', () => {
    const tasks = tasksFromList([
      makeTask('a', [], 'skipped'),
      makeTask('b', ['a']),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['b']);
  });

  it('returns empty when all tasks are done', () => {
    const tasks = tasksFromList([
      makeTask('a', [], 'completed'),
      makeTask('b', ['a'], 'completed'),
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual([]);
  });
});

describe('topologicalSort', () => {
  it('returns correct order (a before b, a before c, b+c before d)', () => {
    const tasks = tasksFromList([
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['b', 'c']),
    ]);
    const order = topologicalSort(tasks);

    expect(order).toHaveLength(4);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('handles parallel-ready tasks (order within same level may vary)', () => {
    const tasks = tasksFromList([
      makeTask('x'),
      makeTask('y'),
      makeTask('z', ['x', 'y']),
    ]);
    const order = topologicalSort(tasks);

    expect(order).toHaveLength(3);
    // x and y must both come before z
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('z'));
    expect(order.indexOf('y')).toBeLessThan(order.indexOf('z'));
  });
});
