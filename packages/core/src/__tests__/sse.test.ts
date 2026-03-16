import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
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
  overrides?: { success?: boolean; errors?: string[] },
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

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-sse-'));
    initDatabase(join(tmpDir, 'test.db'));
    executionLogger = createExecutionLogger({ db: getDb() });
    eventBus = new EventBus();

    // Create a running task
    const runningTask = makeTask({ id: 'sse-running-1' });
    runningTaskId = runningTask.id;
    executionLogger.logTaskStart(runningTask);

    // Create a completed task
    const completedTask = makeTask({ id: 'sse-completed-1' });
    completedTaskId = completedTask.id;
    executionLogger.logTaskStart(completedTask);
    completedTask.status = 'completed';
    completedTask.result = 'all done';
    completedTask.durationMs = 500;
    completedTask.completedAt = Date.now();
    executionLogger.logTaskComplete(completedTask);

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    registerSSERoutes(app, { eventBus, executionLogger });
    await app.listen({ port: 0 });
  });

  afterAll(async () => {
    eventBus.removeAllListeners();
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
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
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-tasks/${runningTaskId}/stream`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    controller.abort();
  });

  it('forwards agent:message events for correct taskId as SSE agent-output', async () => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const controller = new AbortController();
    const receivedLines: string[] = [];

    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/agent-tasks/${runningTaskId}/stream`, {
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read chunks until we have a complete SSE event (not just the :ok comment)
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event:')) {
          receivedLines.push(buffer);
          break;
        }
      }
    });

    // Give the SSE connection time to establish
    await new Promise((r) => setTimeout(r, 50));

    // Emit agent:message for our task
    eventBus.emit(makeAgentMessageEvent(runningTaskId, 'hello world'));

    // Wait a bit then abort
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    try {
      await fetchPromise;
    } catch {
      /* AbortError expected */
    }

    expect(receivedLines.length).toBeGreaterThan(0);
    const raw = receivedLines[0];
    expect(raw).toContain('event: agent-output');
    expect(raw).toContain('"chunk":"hello world"');
    expect(raw).toContain(`"taskId":"${runningTaskId}"`);
    expect(raw).toContain('"messageType":"assistant"');
  });

  it('does NOT forward agent:message events for a different taskId', async () => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const controller = new AbortController();
    let receivedData = '';

    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/agent-tasks/${runningTaskId}/stream`, {
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      // Read all available chunks
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        receivedData += decoder.decode(value, { stream: true });
      }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Emit for a DIFFERENT task
    eventBus.emit(makeAgentMessageEvent('other-task-id', 'should not appear'));

    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    try {
      await fetchPromise;
    } catch {
      /* AbortError expected */
    }

    // Should only have the initial :ok comment, no agent-output events
    expect(receivedData).not.toContain('agent-output');
  });

  it('agent:task:complete event sends agent-complete and closes stream', async () => {
    // Create a fresh running task for this test
    const task = makeTask({ id: 'sse-complete-test' });
    executionLogger.logTaskStart(task);

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    let receivedData = '';

    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/agent-tasks/${task.id}/stream`).then(
      async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        // Read until the stream ends
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
        }
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Emit complete event
    eventBus.emit(makeAgentCompleteEvent(task.id));

    await fetchPromise;

    expect(receivedData).toContain('event: agent-complete');
    expect(receivedData).toContain(`"taskId":"${task.id}"`);
    expect(receivedData).toContain('"status":"completed"');
  });

  it('failed task sends status "failed" with errors via SSE', async () => {
    const task = makeTask({ id: 'sse-failed-test' });
    executionLogger.logTaskStart(task);

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    let receivedData = '';

    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/agent-tasks/${task.id}/stream`).then(
      async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
        }
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    eventBus.emit(makeAgentCompleteEvent(task.id, { success: false, errors: ['timeout'] }));

    await fetchPromise;

    expect(receivedData).toContain('event: agent-complete');
    expect(receivedData).toContain('"status":"failed"');
    expect(receivedData).toContain('"errors":["timeout"]');
  });

  it('client disconnect cleans up eventBus listeners', async () => {
    // Create a fresh task
    const task = makeTask({ id: 'sse-cleanup-test' });
    executionLogger.logTaskStart(task);

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const listenersBefore = eventBus.listenerCount();

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/agent-tasks/${task.id}/stream`, {
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should have added listeners
    const listenersDuring = eventBus.listenerCount();
    expect(listenersDuring).toBeGreaterThan(listenersBefore);

    // Abort (disconnect)
    controller.abort();

    try {
      await fetchPromise;
    } catch {
      /* AbortError expected */
    }

    // Give cleanup time
    await new Promise((r) => setTimeout(r, 100));

    // Listeners should be back to before
    const listenersAfter = eventBus.listenerCount();
    expect(listenersAfter).toBe(listenersBefore);
  });
});
