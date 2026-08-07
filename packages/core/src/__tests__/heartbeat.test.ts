import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { NotificationEvent } from '@raven/shared';

// runAgentTask is mocked at the module level — same convention
// memory-consolidation.test.ts and session-retrospective's own suite use
// for the same function (heartbeat.ts calls it directly, not via the event
// bus — see heartbeat.ts's own comment on why).
vi.mock('../agent-manager/agent-session.ts', () => ({
  runAgentTask: vi.fn(),
}));

const { runAgentTask } = await import('../agent-manager/agent-session.ts');
const { createHeartbeat, isWithinActiveHours, hadRecentAgentActivity } =
  await import('../services/system/heartbeat.ts');

const MS_PER_HOUR = 3_600_000;

function utcTimestamp(hour: number): number {
  return new Date(Date.UTC(2026, 0, 1, hour, 0, 0)).getTime();
}

describe('isWithinActiveHours', () => {
  it('is active inside the default 08-22 window', () => {
    expect(isWithinActiveHours(utcTimestamp(10), '08-22', 'UTC')).toBe(true);
  });

  it('is inactive before the window opens', () => {
    expect(isWithinActiveHours(utcTimestamp(7), '08-22', 'UTC')).toBe(false);
  });

  it('is inactive at the window close (end is exclusive)', () => {
    expect(isWithinActiveHours(utcTimestamp(22), '08-22', 'UTC')).toBe(false);
  });

  it('is active at the window open (start is inclusive)', () => {
    expect(isWithinActiveHours(utcTimestamp(8), '08-22', 'UTC')).toBe(true);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isWithinActiveHours(utcTimestamp(23), '22-06', 'UTC')).toBe(true);
    expect(isWithinActiveHours(utcTimestamp(3), '22-06', 'UTC')).toBe(true);
    expect(isWithinActiveHours(utcTimestamp(10), '22-06', 'UTC')).toBe(false);
  });

  it('fails open (active) on a malformed value rather than silently muting the heartbeat', () => {
    expect(isWithinActiveHours(utcTimestamp(3), 'garbage', 'UTC')).toBe(true);
  });
});

describe('hadRecentAgentActivity', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-heartbeat-busy-'));
    db = initDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertTask(id: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO agent_tasks (id, skill_name, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, 'chat', 'hi', 'completed', 'normal', createdAt);
  }

  it('is false with no agent_tasks at all', () => {
    expect(hadRecentAgentActivity(db, Date.now() - MS_PER_HOUR)).toBe(false);
  });

  it('is true when a task was created within the window', () => {
    const now = Date.now();
    insertTask('t1', now);
    expect(hadRecentAgentActivity(db, now - MS_PER_HOUR)).toBe(true);
  });

  it('is false when the only task predates the window', () => {
    const now = Date.now();
    insertTask('t1', now - 2 * MS_PER_HOUR);
    expect(hadRecentAgentActivity(db, now - MS_PER_HOUR)).toBe(false);
  });
});

// A fake db satisfying only the two queries heartbeat.ts issues directly:
// the busy-deferral check (hadRecentAgentActivity) and the target
// project's system_access lookup (resolveTargetSystemAccessInstructions).
// `busy` controls both — for the busy-deferral tests this is irrelevant
// since a busy result never reaches the second query; the swallow/notify
// tests always run with busy:false so dispatch is reached.
function makeFakeDb(busy: boolean): Database.Database {
  return {
    prepare: () => ({
      get: () => (busy ? { hit: 1 } : undefined),
    }),
  } as unknown as Database.Database;
}

function makeSessionManager() {
  return {
    getOrCreateSession: vi.fn(() => ({
      id: 'sess-1',
      projectId: 'meta',
      status: 'idle' as const,
      createdAt: 0,
      lastActiveAt: 0,
      turnCount: 0,
    })),
    getSdkSessionId: vi.fn(() => undefined),
    linkSdkSession: vi.fn(),
    updateStatus: vi.fn(),
    incrementTurnCount: vi.fn(),
  } as any;
}

// Always-active window regardless of the real local hour the suite runs in
// — the isWithinActiveHours describe block above already covers the
// boundary math with fixed timestamps; these tests are about the
// skip/swallow/notify orchestration, not re-deriving the active-hours math.
const ALWAYS_ACTIVE_HOURS = '00-24';

function makeDeps(overrides: { db?: Database.Database } = {}) {
  return {
    db: overrides.db ?? makeFakeDb(false),
    eventBus: new EventBus(),
    sessionManager: makeSessionManager(),
    config: {
      RAVEN_HEARTBEAT_ACTIVE_HOURS: ALWAYS_ACTIVE_HOURS,
      RAVEN_TIMEZONE: 'UTC',
      CLAUDE_MODEL: 'claude-sonnet-5',
    } as any,
  };
}

describe('createHeartbeat', () => {
  beforeEach(() => {
    vi.mocked(runAgentTask).mockReset();
  });

  it('skips outside active hours without dispatching', async () => {
    const deps = makeDeps();
    deps.config.RAVEN_HEARTBEAT_ACTIVE_HOURS = '08-22';
    // Force "now" to a UTC hour outside the window.
    vi.useFakeTimers();
    vi.setSystemTime(utcTimestamp(2));
    try {
      const heartbeat = createHeartbeat(deps);
      const result = await heartbeat.fireHeartbeat();
      expect(result.summary).toContain('outside active hours');
      expect(runAgentTask).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips on busy-deferral (recent agent activity) without dispatching', async () => {
    const deps = makeDeps({ db: makeFakeDb(true) });
    const heartbeat = createHeartbeat(deps);

    const result = await heartbeat.fireHeartbeat();

    expect(result.summary).toContain('busy-deferral');
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('swallows an exact HEARTBEAT_OK reply and emits no notification', async () => {
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: '  HEARTBEAT_OK  ',
      durationMs: 5,
      success: true,
    });
    const deps = makeDeps();
    const notifications: NotificationEvent[] = [];
    deps.eventBus.on<NotificationEvent>('notification', (e) => notifications.push(e));

    const heartbeat = createHeartbeat(deps);
    const result = await heartbeat.fireHeartbeat();

    expect(result.summary).toContain('HEARTBEAT_OK');
    expect(notifications).toHaveLength(0);
  });

  // F5: exact `=== HEARTBEAT_OK` matching was brittle — a model wrapping the
  // sentinel in markdown, trailing punctuation, or different case spuriously
  // notified the owner. These deviant-but-equivalent forms must all swallow.
  it.each(['**HEARTBEAT_OK**', 'HEARTBEAT_OK.', 'heartbeat_ok', '"HEARTBEAT_OK"'])(
    'swallows the deviant HEARTBEAT_OK form %j and emits no notification',
    async (reply) => {
      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: reply,
        durationMs: 5,
        success: true,
      });
      const deps = makeDeps();
      const notifications: NotificationEvent[] = [];
      deps.eventBus.on<NotificationEvent>('notification', (e) => notifications.push(e));

      const heartbeat = createHeartbeat(deps);
      const result = await heartbeat.fireHeartbeat();

      expect(result.summary).toContain('HEARTBEAT_OK');
      expect(notifications).toHaveLength(0);
    },
  );

  it('does not swallow real content that merely starts with HEARTBEAT_OK', async () => {
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: 'HEARTBEAT_OK, nothing else to report',
      durationMs: 5,
      success: true,
    });
    const deps = makeDeps();
    const notifications: NotificationEvent[] = [];
    deps.eventBus.on<NotificationEvent>('notification', (e) => notifications.push(e));

    const heartbeat = createHeartbeat(deps);
    const result = await heartbeat.fireHeartbeat();

    expect(result.summary).toBe('notified owner');
    expect(notifications).toHaveLength(1);
  });

  it('notifies the owner on topicName "System" when the reply is not HEARTBEAT_OK', async () => {
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: 'A pending approval has been waiting 3 days — you should look at this.',
      durationMs: 5,
      success: true,
    });
    const deps = makeDeps();
    const notifications: NotificationEvent[] = [];
    deps.eventBus.on<NotificationEvent>('notification', (e) => notifications.push(e));

    const heartbeat = createHeartbeat(deps);
    const result = await heartbeat.fireHeartbeat();

    expect(result.summary).toBe('notified owner');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload.channel).toBe('telegram');
    expect(notifications[0].payload.topicName).toBe('System');
    expect(notifications[0].payload.body).toContain('pending approval');
  });

  it('dispatches with a capped maxTurns, on a fresh throwaway session', async () => {
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: 'HEARTBEAT_OK',
      durationMs: 5,
      success: true,
    });
    const deps = makeDeps();
    const heartbeat = createHeartbeat(deps);

    await heartbeat.fireHeartbeat();

    expect(runAgentTask).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAgentTask).mock.calls[0][0];
    expect(call.maxTurns).toBe(8);
    // F4: never touches the project's live chat session — getOrCreateSession
    // would return whichever session a real chat turn on this project is
    // currently using, and two concurrent runAgentTask resumes of the same
    // sdkSessionId would corrupt continuity. task.sessionId must instead be
    // a freshly generated id, never fetched from sessionManager.
    expect(deps.sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(typeof call.task.sessionId).toBe('string');
    expect(call.task.sessionId?.length).toBeGreaterThan(0);
    expect(call.sessionManager).toBe(deps.sessionManager);
  });

  it('uses a different throwaway session id on every fire (F4: fresh each time, no cross-fire continuity)', async () => {
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: 'HEARTBEAT_OK',
      durationMs: 5,
      success: true,
    });
    const deps = makeDeps();
    const heartbeat = createHeartbeat(deps);

    await heartbeat.fireHeartbeat();
    await heartbeat.fireHeartbeat();

    expect(runAgentTask).toHaveBeenCalledTimes(2);
    const firstSessionId = vi.mocked(runAgentTask).mock.calls[0][0].task.sessionId;
    const secondSessionId = vi.mocked(runAgentTask).mock.calls[1][0].task.sessionId;
    expect(firstSessionId).not.toBe(secondSessionId);
  });

  it('skips a second concurrent fire while the first is still running', async () => {
    let resolveFirst: (() => void) | undefined;
    vi.mocked(runAgentTask).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = () =>
            resolve({ taskId: 'mock-task', result: 'HEARTBEAT_OK', durationMs: 5, success: true });
        }),
    );
    const deps = makeDeps();
    const heartbeat = createHeartbeat(deps);

    const firstFire = heartbeat.fireHeartbeat();
    // Let the first call's synchronous skip-checks run and reach the
    // in-flight `runAgentTask` call before firing the second.
    await vi.waitFor(() => expect(heartbeat.isRunning()).toBe(true));

    const secondResult = await heartbeat.fireHeartbeat();
    expect(secondResult.summary).toContain('previous heartbeat still running');
    expect(runAgentTask).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await firstFire;
  });
});
