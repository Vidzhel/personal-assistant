import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { registerSSERoutes } from '../api/sse/stream.ts';
import type { AgentTask, RavenEvent } from '@raven/shared';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    skillName: 'test-skill',
    prompt: 'do something',
    status: 'running',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeAgentMessageEvent(taskId: string, content: string): RavenEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'agent',
    type: 'agent:message',
    payload: { taskId, content, messageType: 'assistant' as const },
  };
}

function makeAgentCompleteEvent(
  taskId: string,
  overrides?: { success?: boolean; errors?: string[]; blocked?: boolean; cancelled?: boolean },
): RavenEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'agent-manager',
    type: 'agent:task:complete',
    payload: {
      taskId,
      result: 'done',
      durationMs: 100,
      success: overrides?.success ?? true,
      errors: overrides?.errors,
      blocked: overrides?.blocked,
      cancelled: overrides?.cancelled,
    },
  };
}

describe('SSE Streaming API', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let executionLogger: ReturnType<typeof createExecutionLogger>;
  let eventBus: EventBus;
  let runningTaskId: string;
  let completedTaskId: string;
  const controllers: AbortController[] = [];

  async function connect(taskId: string) {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`http://127.0.0.1:${port}/api/agent-tasks/${taskId}/stream`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
    });
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-sse-'));
    const projectsDir = join(tmpDir, 'projects');
    mkdirSync(join(projectsDir, 'system'), { recursive: true });
    executionLogger = createExecutionLogger({
      projectsDir,
      projects: () => [{ id: 'meta', fsPath: 'system' }],
    });
    eventBus = new EventBus();

    // Create a running task
    const runningTask = makeTask({ id: 'sse-running-1' });
    runningTaskId = runningTask.id;
    await executionLogger.logTaskStart(runningTask);

    // Create a completed task
    const completedTask = makeTask({ id: 'sse-completed-1' });
    completedTaskId = completedTask.id;
    await executionLogger.logTaskStart(completedTask);
    completedTask.status = 'completed';
    completedTask.result = 'all done';
    completedTask.durationMs = 500;
    completedTask.completedAt = Date.now();
    await executionLogger.logTaskComplete(completedTask);

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    registerSSERoutes(app, { eventBus, executionLogger });
    await app.listen({ port: 0 });
  });

  afterAll(async () => {
    eventBus.removeAllListeners();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await vi.waitFor(() => expect(eventBus.listenerCount()).toBe(0));
  });

  it('returns 404 for nonexistent task ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent-tasks/nonexistent/stream',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Task not found');
    expect(body.code).toBe('NOT_FOUND');
  });

  it('already-completed task immediately sends agent-complete JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-tasks/${completedTaskId}/stream`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.event).toBe('agent-complete');
    expect(body.taskId).toBe(completedTaskId);
    expect(body.status).toBe('completed');
  });

  it('SSE endpoint sets correct headers for running task', async () => {
    const res = await connect(runningTaskId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('forwards agent:message events for correct taskId as SSE agent-output', async () => {
    const res = await connect(runningTaskId);
    eventBus.emit(makeAgentMessageEvent(runningTaskId, 'hello world'));
    eventBus.emit(makeAgentCompleteEvent(runningTaskId));
    const raw = await res.text();
    expect(raw).toContain('event: agent-output');
    expect(raw).toContain('"chunk":"hello world"');
    expect(raw).toContain(`"taskId":"${runningTaskId}"`);
    expect(raw).toContain('"messageType":"assistant"');
  });

  it('does NOT forward agent:message events for a different taskId', async () => {
    const res = await connect(runningTaskId);
    eventBus.emit(makeAgentMessageEvent('other-task-id', 'should not appear'));
    eventBus.emit(makeAgentMessageEvent(runningTaskId, 'delivery barrier'));
    eventBus.emit(makeAgentCompleteEvent(runningTaskId));
    const raw = await res.text();
    expect(raw).toContain('delivery barrier');
    expect(raw).not.toContain('should not appear');
    expect(raw).not.toContain('other-task-id');
  });

  it('agent:task:complete event sends agent-complete and closes stream', async () => {
    const task = makeTask({ id: 'sse-complete-test' });
    await executionLogger.logTaskStart(task);
    const res = await connect(task.id);
    eventBus.emit(makeAgentCompleteEvent(task.id));
    const raw = await res.text();
    expect(raw).toContain('event: agent-complete');
    expect(raw).toContain(`"taskId":"${task.id}"`);
    expect(raw).toContain('"status":"completed"');
  });

  it('failed task sends status "failed" with errors via SSE', async () => {
    const task = makeTask({ id: 'sse-failed-test' });
    await executionLogger.logTaskStart(task);
    const res = await connect(task.id);
    eventBus.emit(makeAgentCompleteEvent(task.id, { success: false, errors: ['timeout'] }));
    const raw = await res.text();
    expect(raw).toContain('event: agent-complete');
    expect(raw).toContain('"status":"failed"');
    expect(raw).toContain('"errors":["timeout"]');
  });

  it.each([
    { label: 'blocked', blocked: true, status: 'blocked', flag: 'blocked' },
    { label: 'cancelled', cancelled: true, status: 'cancelled', flag: 'cancelled' },
  ])('$label task sends a truthful terminal SSE payload', async (outcome) => {
    const task = makeTask({ id: `sse-${outcome.label}-test` });
    await executionLogger.logTaskStart(task);
    const res = await connect(task.id);
    eventBus.emit(
      makeAgentCompleteEvent(task.id, {
        success: false,
        blocked: outcome.blocked,
        cancelled: outcome.cancelled,
      }),
    );
    const raw = await res.text();
    expect(raw).toContain('event: agent-complete');
    expect(raw).toContain(`"status":"${outcome.status}"`);
    expect(raw).toContain(`"${outcome.flag}":true`);
    expect(raw).toContain(`"${outcome.flag === 'blocked' ? 'cancelled' : 'blocked'}":false`);
  });

  it('subscribes before a completion queued immediately after the initial record read', async () => {
    const task = makeTask({ id: 'sse-read-subscribe-boundary' });
    await executionLogger.logTaskStart(task);
    const read = executionLogger.getTaskById.bind(executionLogger);
    const spy = vi.spyOn(executionLogger, 'getTaskById').mockImplementation((id) => {
      const record = read(id);
      if (id === task.id) queueMicrotask(() => eventBus.emit(makeAgentCompleteEvent(id)));
      return record;
    });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-tasks/${task.id}/stream`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(await response.text()).toContain('"status":"completed"');
    } finally {
      spy.mockRestore();
    }
  });

  it('client disconnect cleans up eventBus listeners', async () => {
    const task = makeTask({ id: 'sse-cleanup-test' });
    await executionLogger.logTaskStart(task);
    const listenersBefore = eventBus.listenerCount();
    await connect(task.id);
    expect(eventBus.listenerCount()).toBeGreaterThan(listenersBefore);
    controllers.at(-1)!.abort();
    await vi.waitFor(() => expect(eventBus.listenerCount()).toBe(listenersBefore));
  });
});
