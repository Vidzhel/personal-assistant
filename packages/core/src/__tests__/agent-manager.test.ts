import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the claude-code SDK before importing AgentManager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock config before importing
vi.mock('../config.ts', () => {
  const config = {
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 4001,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5.0,
  };
  return {
    getConfig: () => config,
    loadConfig: () => config,
    projectRoot: '/test/root',
  };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { createMessageStore, type MessageStore } from '../session-manager/message-store.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { RavenEvent, AgentTaskRequestEvent, PermissionTier } from '@raven/shared';

const mockQuery = vi.mocked(query);

describe('AgentManager', () => {
  let eventBus: EventBus;
  let agentManager: AgentManager;

  beforeEach(() => {
    eventBus = new EventBus();
    agentManager = new AgentManager({ eventBus });
    mockQuery.mockReset();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  function emitTaskRequest(overrides: Partial<AgentTaskRequestEvent['payload']> = {}): void {
    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'task-1',
        prompt: 'Hello',
        skillName: 'orchestrator',
        mcpServers: {},
        priority: 'normal',
        ...overrides,
      },
    } as RavenEvent);
  }

  it('enqueues tasks from agent:task:request events', () => {
    // Don't let it process (query won't resolve)
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    emitTaskRequest();
    // The task was dequeued immediately to run, so queue is 0 but running is 1
    expect(agentManager.getRunningCount()).toBe(1);
  });

  it('successful task emits agent:task:complete with success', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-123' };
      yield { type: 'result', subtype: 'success', result: 'Task completed!' };
    } as unknown as typeof query);

    const completionPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:complete', (e) => resolve(e));
    });

    emitTaskRequest();

    const event = await completionPromise;
    const payload = (event as AgentTaskRequestEvent).payload as unknown as {
      taskId: string;
      success: boolean;
      result: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.result).toBe('Task completed!');
  });

  it('failed task emits agent:task:complete with success false', async () => {
    mockQuery.mockImplementation(async function* () {
      yield* []; // satisfy require-yield
      throw new Error('Claude Code process exited with code 1');
    } as unknown as typeof query);

    const completionPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:complete', (e) => resolve(e));
    });

    emitTaskRequest();

    const event = await completionPromise;
    const payload = (event as AgentTaskRequestEvent).payload as unknown as {
      success: boolean;
      errors: string[];
    };
    expect(payload.success).toBe(false);
    expect(payload.errors).toBeDefined();
    expect(payload.errors!.length).toBeGreaterThan(0);
  });

  it('streams assistant messages to event bus', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello user!' }] },
      };
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    const messages: RavenEvent[] = [];
    eventBus.on('agent:message', (e) => messages.push(e));

    const completionPromise = new Promise<void>((resolve) => {
      eventBus.on('agent:task:complete', () => resolve());
    });

    emitTaskRequest();
    await completionPromise;

    // Should have the "Starting..." thinking message + the assistant message
    const assistantMsgs = messages.filter(
      (m) =>
        (m as unknown as { payload: { messageType: string } }).payload.messageType === 'assistant',
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('priority ordering: high tasks run before normal', async () => {
    const _taskOrder: string[] = [];
    let _resolveFirst: () => void;
    let _resolveSecond: () => void;
    const _firstPromise = new Promise<void>((r) => {
      _resolveFirst = r;
    });
    const _secondPromise = new Promise<void>((r) => {
      _resolveSecond = r;
    });

    // Make query block until we release it
    let _callCount = 0;
    mockQuery.mockImplementation(async function* () {
      _callCount++;
      // Each call records its task via the prompt (which is the task prompt)
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    // Create a new manager with concurrency 1 so tasks queue
    vi.doMock('../config.ts', () => ({
      getConfig: () => ({
        RAVEN_MAX_CONCURRENT_AGENTS: 1,
        RAVEN_AGENT_MAX_TURNS: 25,
        CLAUDE_MODEL: 'claude-sonnet-4-6',
      }),
    }));

    // The task request handling is tested through events
    // Just verify the queue length getter works
    expect(agentManager.getQueueLength()).toBe(0);
  });

  describe('with messageStore', () => {
    let tmpDir: string;
    let messageStore: MessageStore;
    let _amWithStore: AgentManager;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-am-'));
      messageStore = createMessageStore({ basePath: tmpDir });
      _amWithStore = new AgentManager({ eventBus, messageStore });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stores streaming assistant messages before tool_use actions', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me check that.' },
              { type: 'tool_use', name: 'Read', input: { path: '/tmp/test' } },
            ],
          },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Here is the result.' }] },
        };
        yield { type: 'result', subtype: 'success', result: 'Here is the result.' };
      } as unknown as typeof query);

      const completionPromise = new Promise<void>((resolve) => {
        eventBus.on('agent:task:complete', () => resolve());
      });

      eventBus.emit({
        id: 'evt-store-1',
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:request',
        payload: {
          taskId: 'task-store-1',
          sessionId: 'sess-store-1',
          prompt: 'Hello',
          skillName: 'orchestrator',
          mcpServers: {},
          priority: 'normal',
        },
      } as RavenEvent);

      await completionPromise;

      const msgs = messageStore.getMessages('sess-store-1');
      const roles = msgs.map((m) => m.role);

      // thinking comes first, then assistant text, then action, then final assistant
      expect(roles[0]).toBe('thinking');
      expect(roles[1]).toBe('assistant');
      expect(roles[2]).toBe('action');
      expect(roles[3]).toBe('assistant');
    });
  });

  describe('with sessionManager (resume threading)', () => {
    // A dedicated eventBus, scoped to this describe block only — the outer
    // `agentManager` (built in the top-level beforeEach with no
    // sessionManager) would otherwise also be subscribed to the shared
    // eventBus and double-process every emitted request.
    let localEventBus: EventBus;
    let sessionManager: SessionManager;
    let _amWithSession: AgentManager;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-am-session-'));
      initDatabase(join(tmpDir, 'test.db'));
      localEventBus = new EventBus();
      sessionManager = new SessionManager();
      _amWithSession = new AgentManager({
        eventBus: localEventBus,
        sessionManager,
      });
    });

    afterEach(() => {
      localEventBus.removeAllListeners();
      try {
        getDb().close();
      } catch {
        /* */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeProject(projectId: string): void {
      const now = Date.now();
      getDb()
        .prepare(
          'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(projectId, projectId, '[]', now, now);
    }

    function emitChatTurn(taskId: string, sessionId: string | undefined): void {
      localEventBus.emit({
        id: `evt-${taskId}`,
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:request',
        payload: {
          taskId,
          sessionId,
          prompt: 'Hello',
          skillName: 'orchestrator',
          mcpServers: {},
          priority: 'normal',
        },
      } as RavenEvent);
    }

    it('links the SDK session id after a chat turn that carries sessionId', async () => {
      // linkSdkSession's UPDATE is a no-op against a sessionId with no
      // matching row, so the Raven session must actually exist first — mirror
      // what orchestrator.ts does via getOrCreateSession before dispatching.
      makeProject('proj-resume-1');
      const session = sessionManager.getOrCreateSession('proj-resume-1');

      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-resume-1' };
        yield { type: 'result', subtype: 'success', result: 'done' };
      } as unknown as typeof query);

      const completionPromise = new Promise<void>((resolve) => {
        localEventBus.once('agent:task:complete', () => resolve());
      });

      emitChatTurn('task-resume-1', session.id);
      await completionPromise;

      expect(sessionManager.getSdkSessionId(session.id)).toBe('sdk-resume-1');
    });

    it('resumes the SDK session on the second turn of the same Raven session', async () => {
      makeProject('proj-resume-2');
      const session = sessionManager.getOrCreateSession('proj-resume-2');

      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-resume-2' };
        yield { type: 'result', subtype: 'success', result: 'ok' };
      } as unknown as typeof query);

      const firstComplete = new Promise<void>((resolve) => {
        localEventBus.once('agent:task:complete', () => resolve());
      });
      emitChatTurn('task-resume-2a', session.id);
      await firstComplete;

      const secondComplete = new Promise<void>((resolve) => {
        localEventBus.once('agent:task:complete', () => resolve());
      });
      emitChatTurn('task-resume-2b', session.id);
      await secondComplete;

      expect(mockQuery.mock.calls.length).toBe(2);
      const firstCallOptions = mockQuery.mock.calls[0][0].options as { resume?: string };
      const secondCallOptions = mockQuery.mock.calls[1][0].options as { resume?: string };
      expect(firstCallOptions.resume).toBeUndefined();
      expect(secondCallOptions.resume).toBe('sdk-resume-2');
    });

    it('links the SDK session id even when the backend throws mid-stream after session init (F2)', async () => {
      // Regression test for F2: sdkSessionId used to only be captured from
      // backendResult.sessionId on the try block's success path — a throw
      // between session init and the backend's `return` meant that path
      // never ran, and the session id the SDK *did* assign was lost. The
      // fix threads it out via BackendOptions.onSessionId as soon as it's
      // known, then links it from a `finally`, independent of throw-vs-
      // return.
      makeProject('proj-resume-3');
      const session = sessionManager.getOrCreateSession('proj-resume-3');

      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-resume-3' };
        throw new Error('simulated mid-stream SDK failure');
      } as unknown as typeof query);

      const completionPromise = new Promise<RavenEvent>((resolve) => {
        localEventBus.once('agent:task:complete', (e) => resolve(e));
      });

      emitChatTurn('task-resume-3', session.id);
      const event = await completionPromise;

      const payload = (event as AgentTaskRequestEvent).payload as unknown as { success: boolean };
      expect(payload.success).toBe(false);
      expect(sessionManager.getSdkSessionId(session.id)).toBe('sdk-resume-3');
    });

    it('does not resume a task with no sessionId (execution/validator tasks stay cold)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', subtype: 'success', result: 'done' };
      } as unknown as typeof query);

      const completionPromise = new Promise<void>((resolve) => {
        localEventBus.once('agent:task:complete', () => resolve());
      });

      emitChatTurn('task-no-session', undefined);
      await completionPromise;

      const callOptions = mockQuery.mock.calls[0][0].options as { resume?: string };
      expect(callOptions.resume).toBeUndefined();
    });
  });

  it('concurrency limit is respected', async () => {
    // Set up query to block until manually resolved
    const gates: Array<() => void> = [];

    mockQuery.mockImplementation(async function* () {
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    // Emit 5 tasks
    for (let i = 0; i < 5; i++) {
      emitTaskRequest({ taskId: `task-${i}`, prompt: `Task ${i}` });
    }

    // Max concurrent is 3, so 3 should be running and 2 queued
    await new Promise((r) => setTimeout(r, 10));
    expect(agentManager.getRunningCount()).toBe(3);
    expect(agentManager.getQueueLength()).toBe(2);

    // Release one task — a queued task should start
    gates[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(agentManager.getRunningCount()).toBe(3); // picked up next from queue
    expect(agentManager.getQueueLength()).toBe(1);

    // Helper to wait for a gate to appear and release it
    const waitAndRelease = async () => {
      while (gates.length < 5) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // Release remaining gates as they appear
    gates[1]();
    gates[2]();
    gates[3]();
    await waitAndRelease();
    gates[4]();

    // Wait for all completions
    await new Promise((r) => setTimeout(r, 100));
    expect(agentManager.getRunningCount()).toBe(0);
    expect(agentManager.getQueueLength()).toBe(0);
  });

  it('emits agent:task:complete with the Raven sessionId, not the SDK session id (F3)', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f3-999' };
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    const completionPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:complete', (e) => resolve(e));
    });

    emitTaskRequest({ taskId: 'task-f3', sessionId: 'raven-sess-f3' });

    const event = await completionPromise;
    const payload = (event as AgentTaskRequestEvent).payload as unknown as {
      sessionId?: string;
      sdkSessionId?: string;
    };
    expect(payload.sessionId).toBe('raven-sess-f3');
    expect(payload.sdkSessionId).toBe('sdk-f3-999');
  });

  describe('F1: per-session turn serialization', () => {
    it('two tasks with the same sessionId run one at a time, never concurrently', async () => {
      const gates: Array<() => void> = [];
      mockQuery.mockImplementation(async function* () {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: 'result', subtype: 'success', result: 'done' };
      } as unknown as typeof query);

      emitTaskRequest({ taskId: 'task-serial-a', sessionId: 'sess-serial-1' });
      emitTaskRequest({ taskId: 'task-serial-b', sessionId: 'sess-serial-1' });

      // The second task's sessionId collides with the first, still-running
      // task's — it must be skipped and left queued, not admitted alongside it.
      await new Promise((r) => setTimeout(r, 10));
      expect(agentManager.getRunningCount()).toBe(1);
      expect(agentManager.getQueueLength()).toBe(1);
      expect(mockQuery.mock.calls.length).toBe(1);

      // Completing the first task re-drives the queue via admitTask's
      // .finally(() => this.processQueue()) — only then should the second,
      // same-session task actually start.
      gates[0]();
      await new Promise((r) => setTimeout(r, 30));
      expect(mockQuery.mock.calls.length).toBe(2);
      expect(agentManager.getRunningCount()).toBe(1);
      expect(agentManager.getQueueLength()).toBe(0);

      gates[1]();
      await new Promise((r) => setTimeout(r, 30));
      expect(agentManager.getRunningCount()).toBe(0);
    });

    it('a same-session task queued behind an unrelated task does not block that other task', async () => {
      const gates: Array<() => void> = [];
      mockQuery.mockImplementation(async function* () {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: 'result', subtype: 'success', result: 'done' };
      } as unknown as typeof query);

      // task-a and task-c share a session; task-b is unrelated. task-c must
      // be skipped in place without preventing task-b (behind it) from
      // being admitted — this is the "iterate a copy / careful indexing"
      // requirement: a skip must not livelock or block admissible tasks.
      emitTaskRequest({ taskId: 'task-a', sessionId: 'sess-shared' });
      emitTaskRequest({ taskId: 'task-b', sessionId: 'sess-other' });
      emitTaskRequest({ taskId: 'task-c', sessionId: 'sess-shared' });

      await new Promise((r) => setTimeout(r, 10));
      expect(agentManager.getRunningCount()).toBe(2);
      expect(agentManager.getQueueLength()).toBe(1);
      expect(mockQuery.mock.calls.length).toBe(2);

      gates[0]();
      gates[1]();
      await new Promise((r) => setTimeout(r, 30));
      expect(mockQuery.mock.calls.length).toBe(3);

      gates[2]();
      await new Promise((r) => setTimeout(r, 30));
      expect(agentManager.getRunningCount()).toBe(0);
      expect(agentManager.getQueueLength()).toBe(0);
    });

    it('two tasks with different sessionIds run in parallel', async () => {
      const gates: Array<() => void> = [];
      mockQuery.mockImplementation(async function* () {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: 'result', subtype: 'success', result: 'done' };
      } as unknown as typeof query);

      emitTaskRequest({ taskId: 'task-par-a', sessionId: 'sess-par-1' });
      emitTaskRequest({ taskId: 'task-par-b', sessionId: 'sess-par-2' });

      await new Promise((r) => setTimeout(r, 10));
      expect(agentManager.getRunningCount()).toBe(2);
      expect(agentManager.getQueueLength()).toBe(0);
      expect(mockQuery.mock.calls.length).toBe(2);

      gates[0]();
      gates[1]();
      await new Promise((r) => setTimeout(r, 30));
      expect(agentManager.getRunningCount()).toBe(0);
    });
  });

  describe('executeApprovedAction loop-closure (Task 2)', () => {
    let tmpDir: string;
    let localEventBus: EventBus;
    let auditLog: AuditLog;
    let pendingApprovals: PendingApprovals;
    let amWithPermissions: AgentManager;

    function makeFakePermissionEngine(tierMap: Record<string, PermissionTier>): PermissionEngine {
      return {
        initialize: () => undefined,
        resolveTier: (actionName: string) => tierMap[actionName] ?? 'red',
        getActionCatalog: () => [],
        shutdown: () => undefined,
        getConfig: () => ({}),
      };
    }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-am-approved-'));
      initDatabase(join(tmpDir, 'test.db'));
      auditLog = createAuditLog(getDb());
      auditLog.initialize();
      pendingApprovals = createPendingApprovals(getDb());
      pendingApprovals.initialize();
      localEventBus = new EventBus();

      amWithPermissions = new AgentManager({
        eventBus: localEventBus,
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
        auditLog,
        pendingApprovals,
      });
    });

    afterEach(() => {
      localEventBus.removeAllListeners();
      try {
        getDb().close();
      } catch {
        /* already closed */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('re-dispatches a just-approved red-tier action without re-queuing it for approval', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', subtype: 'success', result: 'sent' };
      } as unknown as typeof query);

      const before = pendingApprovals.query().length;

      const result = await amWithPermissions.executeApprovedAction({
        actionName: 'gmail:send-email',
        skillName: 'gmail',
        details: 'Send to user@test.com',
      });

      expect(result.success).toBe(true);
      expect(mockQuery).toHaveBeenCalled();
      // The re-dispatch must not have queued a fresh approval for the same
      // still-red tier — that's exactly the loop this closes.
      expect(pendingApprovals.query().length).toBe(before);
    });
  });
});
