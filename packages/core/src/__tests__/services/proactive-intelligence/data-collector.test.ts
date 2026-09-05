import type * as RavenShared from '@raven/shared';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof RavenShared>();
  return {
    ...actual,
    generateId: vi.fn(() => 'test-uuid'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

import { buildSnapshot } from '../../../services/proactive-intelligence/data-collector.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { ExecutionLogger } from '../../../agent-manager/execution-logger.ts';

function createMockDb(queryResults: Record<string, any[]>): DatabaseInterface {
  return {
    all: vi.fn((sql: string) => {
      for (const [key, value] of Object.entries(queryResults)) {
        if (sql.includes(key)) return value;
      }
      return [];
    }),
    get: vi.fn(() => undefined),
    run: vi.fn(),
  } as any;
}

function createMockExecutionLogger(
  tasks: Array<{ skillName: string; status: string }> = [],
): ExecutionLogger {
  return {
    queryTasks: vi.fn((opts) =>
      opts.status ? tasks.filter((task) => task.status === opts.status) : tasks,
    ),
  } as unknown as ExecutionLogger;
}

describe('data-collector buildSnapshot', () => {
  it('returns snapshot with empty-data messages when DB has no data', () => {
    const db = createMockDb({});
    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('No events in the last 7 days');
    expect(snapshot).toContain('No agent tasks in the last 7 days');
    expect(snapshot).toContain('No audit entries in the last 7 days');
    expect(snapshot).toContain('No sessions in the last 30 days');
    expect(snapshot).toContain('No knowledge activity in the last 7 days');
    expect(snapshot).toContain('No conversation activity in the last 7 days');
    expect(snapshot).toContain('No prior insights in the last 7 days');
  });

  it('includes event data when events exist', () => {
    const db = createMockDb({
      'FROM events WHERE timestamp': [
        { type: 'user:chat:message', count: 5 },
        { type: 'agent:task:complete', count: 3 },
      ],
    });

    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('Events (7d):');
    expect(snapshot).toContain('user:chat:message: 5');
    expect(snapshot).toContain('agent:task:complete: 3');
  });

  it('includes knowledge activity section when knowledge events exist', () => {
    const db = createMockDb({
      "LIKE 'knowledge:%'": [
        { type: 'knowledge:ingestion:complete', count: 2 },
        { type: 'knowledge:retrieval', count: 8 },
      ],
    });

    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('Knowledge Activity (7d):');
    expect(snapshot).toContain('knowledge:ingestion:complete: 2');
    expect(snapshot).toContain('knowledge:retrieval: 8');
  });

  it('includes conversation snapshot with task topics and volume', () => {
    const db = createMockDb({
      'SUM(turn_count)': [
        { project_id: 'proj-1', total_turns: 15 },
        { project_id: 'proj-2', total_turns: 3 },
      ],
    });

    const snapshot = buildSnapshot(
      db,
      createMockExecutionLogger([
        ...Array.from({ length: 4 }, () => ({ skillName: 'ticktick', status: 'completed' })),
        ...Array.from({ length: 2 }, () => ({ skillName: 'gmail', status: 'completed' })),
      ]),
    );

    expect(snapshot).toContain('Task Topics (7d):');
    expect(snapshot).toContain('ticktick: 4 completed tasks');
    expect(snapshot).toContain('Conversation Volume (7d):');
    expect(snapshot).toContain('proj-1: 15 turns');
  });

  it('includes agent task data', () => {
    const db = createMockDb({});

    const snapshot = buildSnapshot(
      db,
      createMockExecutionLogger([
        ...Array.from({ length: 10 }, () => ({ skillName: 'ticktick', status: 'completed' })),
        { skillName: 'gmail', status: 'failed' },
      ]),
    );

    expect(snapshot).toContain('Agent Tasks (7d):');
    expect(snapshot).toContain('ticktick [completed]: 10');
  });

  it('requests every task record when building aggregates', () => {
    const logger = createMockExecutionLogger(
      Array.from({ length: 60 }, () => ({ skillName: 'ticktick', status: 'completed' })),
    );

    const snapshot = buildSnapshot(createMockDb({}), logger);

    expect(snapshot).toContain('ticktick [completed]: 60');
    expect(logger.queryTasks).toHaveBeenCalledWith({
      createdSinceMs: expect.any(Number),
      limit: null,
      offset: 0,
    });
  });

  it('includes session data with days-ago calculation', () => {
    const db = createMockDb({
      'FROM sessions WHERE last_active_at': [
        { project_id: 'proj-1', session_count: 5, last_active: Date.now() - 2 * 86400000 },
      ],
    });

    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('Sessions (30d):');
    expect(snapshot).toContain('proj-1: 5 sessions');
  });

  it('includes insight history to help agent avoid duplicates', () => {
    const db = createMockDb({
      'FROM insights WHERE created_at': [{ pattern_key: 'meeting-overload', count: 3 }],
    });

    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('Recent Insights (7d, avoid duplicating):');
    expect(snapshot).toContain('meeting-overload: 3 occurrences');
  });

  it('truncates snapshot when content exceeds token limit', () => {
    // Create a very large result set
    const bigData = Array.from({ length: 500 }, (_, i) => ({
      type: `event:type:with-a-very-long-name-for-padding-${i}`,
      count: i,
    }));

    const db = createMockDb({
      'FROM events WHERE timestamp': bigData,
    });

    const snapshot = buildSnapshot(db, createMockExecutionLogger());

    expect(snapshot).toContain('[...truncated]');
  });
});
