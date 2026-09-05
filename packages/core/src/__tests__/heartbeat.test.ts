import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { EventBus } from '../event-bus/event-bus.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { AgentResolver } from '../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { NotificationEvent } from '@raven/shared';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';

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
  function logger(hasActivity: boolean) {
    return {
      queryTasks: vi.fn(() => (hasActivity ? [{}] : [])),
    } as unknown as ExecutionLogger;
  }

  it('is false with no recorded activity', () => {
    const executionLogger = logger(false);
    expect(hadRecentAgentActivity(executionLogger, Date.now() - MS_PER_HOUR)).toBe(false);
    expect(executionLogger.queryTasks).toHaveBeenCalledWith({
      createdSinceMs: expect.any(Number),
      limit: 1,
      offset: 0,
    });
  });

  it('is true when a task was created within the window', () => {
    expect(hadRecentAgentActivity(logger(true), Date.now() - MS_PER_HOUR)).toBe(true);
  });

  it('is false when the only task predates the window', () => {
    expect(hadRecentAgentActivity(logger(false), Date.now() - MS_PER_HOUR)).toBe(false);
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

function makeDeps(overrides: { db?: Database.Database; executionLogger?: ExecutionLogger } = {}) {
  return {
    db: overrides.db ?? makeFakeDb(false),
    executionLogger: (overrides.executionLogger ??
      ({ queryTasks: vi.fn(() => []) } as unknown as ExecutionLogger)) as ExecutionLogger,
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
    const deps = makeDeps({
      db: makeFakeDb(true),
      executionLogger: { queryTasks: vi.fn(() => [{}]) } as unknown as ExecutionLogger,
    });
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
  it('rejects failed resolution without library fallback or notification and can fire again', async () => {
    const base = makeDeps();
    const notifications = vi.fn();
    base.eventBus.on('notification', notifications);
    const getDefaultAgent = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('broken agent');
      })
      .mockReturnValue({ id: 'raven', name: 'raven' });
    const resolveAgentCapabilities = vi
      .fn()
      .mockReturnValue({ mcpServers: {}, agentDefinitions: {}, plugins: [] });
    const collectMcpServers = vi.fn();
    const heartbeat = createHeartbeat({
      ...base,
      namedAgentStore: { getDefaultAgent } as unknown as NamedAgentStore,
      agentResolver: { resolveAgentCapabilities },
      capabilityLibrary: { collectMcpServers } as unknown as CapabilityLibrary,
    });
    await expect(heartbeat.fireHeartbeat()).rejects.toThrow('broken agent');
    expect(heartbeat.isRunning()).toBe(false);
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(collectMcpServers).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'ok',
      result: 'HEARTBEAT_OK',
      success: true,
      durationMs: 1,
    });
    await expect(heartbeat.fireHeartbeat()).resolves.toEqual({
      summary: 'HEARTBEAT_OK (swallowed)',
    });
    expect(vi.mocked(runAgentTask).mock.calls[0][0].agentDefinitions).toEqual({});
  });

  it.each(['store', 'resolver'])(
    'rejects partially configured %s dependency',
    async (configured) => {
      const heartbeat = createHeartbeat({
        ...makeDeps(),
        namedAgentStore: configured === 'store' ? ({} as NamedAgentStore) : undefined,
        agentResolver: configured === 'resolver' ? ({} as AgentResolver) : undefined,
      });
      await expect(heartbeat.fireHeartbeat()).rejects.toThrow('requires both');
      expect(heartbeat.isRunning()).toBe(false);
      expect(runAgentTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    { success: false, result: 'partial output', errors: ['failed query'] },
    { success: true, result: '   ' },
  ])('rejects failed/empty backend response without notifying', async (response) => {
    const deps = makeDeps();
    const notifications = vi.fn();
    deps.eventBus.on('notification', notifications);
    vi.mocked(runAgentTask).mockResolvedValue({ taskId: 'bad', durationMs: 1, ...response });
    const heartbeat = createHeartbeat(deps);
    await expect(heartbeat.fireHeartbeat()).rejects.toThrow(/failed query|empty response/);
    expect(heartbeat.isRunning()).toBe(false);
    expect(notifications).not.toHaveBeenCalled();
  });
});
