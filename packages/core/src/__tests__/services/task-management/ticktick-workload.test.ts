import { describe, expect, it, vi } from 'vitest';
import {
  collectTickTickWorkload,
  type TickTickActionRequest,
  type TickTickActionResult,
} from '../../../services/task-management/ticktick-workload.ts';

function response(result: unknown): TickTickActionResult {
  return { success: true, result: JSON.stringify(result) };
}

function projects(result: unknown[]): TickTickActionResult {
  return response({ projects: result, complete: true, nextCursor: null });
}

function tasks(result: unknown[]): TickTickActionResult {
  return response({ tasks: result, complete: true, nextCursor: null });
}

describe('collectTickTickWorkload', () => {
  it('constructs coverage from separate official queries and preserves task identity', async () => {
    const request = vi.fn(async (query: TickTickActionRequest) => {
      if (query.actionName === 'ticktick:list-projects') {
        return projects([{ id: 'p1', name: 'Work' }]);
      }
      if (query.actionName === 'ticktick:get-project-with-undone-tasks') {
        return tasks([
          {
            id: 't1',
            title: 'Undated priority',
            priority: 5,
            timeZone: 'Europe/Kyiv',
            isAllDay: true,
            repeatFlag: 'RRULE:FREQ=WEEKLY',
            recurrence: 'weekly',
            link: 'https://ticktick.com/task/t1',
          },
        ]);
      }
      if (query.details.includes('no due date')) {
        return tasks([{ id: 't1', projectId: 'p1', title: 'Undated priority', priority: 5 }]);
      }
      return tasks([]);
    });

    const snapshot = await collectTickTickWorkload({
      request,
      signal: new AbortController().signal,
      now: new Date('2026-09-05T22:30:00.000Z'),
      timeZone: 'Europe/Kyiv',
    });

    expect(snapshot.coverage.status).toBe('observed');
    expect(snapshot.coverage.observedScopes).toEqual([
      'projects',
      'project:p1',
      'dated-window',
      'inbox',
      'undated',
      'overdue',
    ]);
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({
        id: 't1',
        projectId: 'p1',
        sourceScopes: ['project:p1', 'undated'],
        timeZone: 'Europe/Kyiv',
        isAllDay: true,
        repeatFlag: 'RRULE:FREQ=WEEKLY',
        recurrence: 'weekly',
        link: 'https://ticktick.com/task/t1',
      }),
    ]);
    expect(request.mock.calls.map(([query]) => query.actionName)).toEqual([
      'ticktick:list-projects',
      'ticktick:get-project-with-undone-tasks',
      'ticktick:list-undone-tasks-by-date',
      'ticktick:filter-tasks',
      'ticktick:filter-tasks',
      'ticktick:filter-tasks',
    ]);
    expect(request.mock.calls[2][0].details).toContain('2026-09-06');
  });

  it('marks a failed scope partial without discarding successful records', async () => {
    const request = vi.fn(async (query: TickTickActionRequest) => {
      if (query.actionName === 'ticktick:list-projects') {
        return projects([{ id: 'p1', name: 'Work' }]);
      }
      if (query.details.includes('Inbox')) return { success: false, error: 'Inbox unavailable' };
      if (query.actionName === 'ticktick:get-project-with-undone-tasks') {
        return tasks([{ id: 't1', title: 'Keep identity' }]);
      }
      return tasks([]);
    });

    const snapshot = await collectTickTickWorkload({
      request,
      signal: new AbortController().signal,
      timeZone: 'UTC',
    });

    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.failedScopes).toEqual([
      { scope: 'inbox', error: 'Inbox unavailable' },
    ]);
    expect(snapshot.tasks[0]).toMatchObject({ id: 't1', projectId: 'p1' });
  });

  it('bounds discovery and records conflicting task identities as partial evidence', async () => {
    const projects = Array.from({ length: 101 }, (_, index) => ({
      id: `p${String(index)}`,
      name: `Project ${String(index)}`,
    }));
    const request = vi.fn(async (query: TickTickActionRequest) => {
      if (query.actionName === 'ticktick:list-projects') {
        return response({ projects, complete: true, nextCursor: null });
      }
      if (query.details.includes('Inbox')) {
        return tasks([{ id: 'same', title: 'One', priority: 1 }]);
      }
      if (query.details.includes('no due date')) {
        return tasks([{ id: 'same', title: 'One', priority: 5 }]);
      }
      return tasks([]);
    });

    const snapshot = await collectTickTickWorkload({
      request,
      signal: new AbortController().signal,
      timeZone: 'UTC',
    });

    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.failedScopes.map((failure) => failure.scope)).toEqual([
      'projects',
      'undated',
    ]);
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'ticktick:get-project-with-undone-tasks' }),
    );
  });

  it('rejects bare arrays and any reported pagination or truncation', async () => {
    const responses: TickTickActionResult[] = [
      response([]),
      response({ projects: [], complete: true, hasMore: true }),
      response({ projects: [], complete: true, truncated: true }),
      {
        success: true,
        result: 'Partial results follow: {"projects":[],"complete":true}',
      },
    ];
    for (const first of responses) {
      const request = vi.fn(async (query: TickTickActionRequest) =>
        query.actionName === 'ticktick:list-projects' ? first : tasks([]),
      );
      const snapshot = await collectTickTickWorkload({
        request,
        signal: new AbortController().signal,
        timeZone: 'UTC',
      });
      expect(snapshot.coverage.status).toBe('partial');
      expect(snapshot.coverage.failedScopes[0]?.scope).toBe('projects');
    }
  });

  it('keeps the dated window at 14 owner-local calendar days across DST', async () => {
    const request = vi.fn(async (query: TickTickActionRequest) =>
      query.actionName === 'ticktick:list-projects' ? projects([]) : tasks([]),
    );
    await collectTickTickWorkload({
      request,
      signal: new AbortController().signal,
      timeZone: 'Europe/Kyiv',
      now: new Date('2026-03-28T21:30:00.000Z'),
    });
    const dated = request.mock.calls
      .map(([query]) => query)
      .find((query) => query.actionName === 'ticktick:list-undone-tasks-by-date');
    expect(dated?.details).toContain('2026-03-28 through 2026-04-10');
  });

  it('rejects duplicate project IDs before dispatching project queries', async () => {
    const request = vi.fn(async (query: TickTickActionRequest) =>
      query.actionName === 'ticktick:list-projects'
        ? projects([
            { id: 'same', name: 'One' },
            { id: 'same', name: 'Two' },
          ])
        : tasks([]),
    );
    const snapshot = await collectTickTickWorkload({
      request,
      signal: new AbortController().signal,
      timeZone: 'UTC',
    });
    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.failedScopes[0]?.error).toContain('duplicate IDs');
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'ticktick:get-project-with-undone-tasks' }),
    );
  });

  it('stops issuing queries after cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort(new Error('stopped'));
      return projects([]);
    });

    await expect(
      collectTickTickWorkload({ request, signal: controller.signal, timeZone: 'UTC' }),
    ).rejects.toThrow('stopped');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
