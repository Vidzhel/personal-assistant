import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentTaskCompleteEvent, AgentMessageEvent } from '@raven/shared';
import { createMessageStore } from '../session-manager/message-store.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import type { BackendOptions, BackendResult } from '../agent-manager/agent-backend.ts';

let root: string | undefined;
let raven: RavenInstance | undefined;
afterEach(async () => {
  await raven?.stop();
  raven = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function boot(
  backend: (opts: BackendOptions) => Promise<BackendResult>,
): Promise<RavenInstance> {
  root = mkdtempSync(join(tmpdir(), 'raven-agent-shutdown-'));
  raven = await createRaven(
    { ...buildTestConfig(), RAVEN_MAX_CONCURRENT_AGENTS: 1 },
    {
      ...createRavenTestFixture(root, { gmailActions: true }),
      agentBackend: backend,
      skipSuites: true,
    },
  );
  return raven;
}

function request(app: RavenInstance, taskId: string, sessionId?: string): void {
  app.eventBus.emit({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'test',
    type: 'agent:task:request',
    payload: {
      taskId,
      sessionId,
      projectId: 'meta',
      skillName: 'orchestrator',
      prompt: taskId,
      mcpServers: {},
      priority: 'normal',
    },
  });
}

describe('agent shutdown', () => {
  it('cancels queued and uncooperative running work before closing stores, suppressing late callbacks', async () => {
    let options: BackendOptions | undefined;
    let resolveBackend!: (result: BackendResult) => void;
    const backend = vi.fn((opts: BackendOptions) => {
      options = opts;
      return new Promise<BackendResult>((resolve) => {
        resolveBackend = resolve;
      });
    });
    const app = await boot(backend);
    const completions: AgentTaskCompleteEvent[] = [];
    const messages: AgentMessageEvent[] = [];
    app.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) =>
      completions.push(event),
    );
    app.eventBus.on<AgentMessageEvent>('agent:message', (event) => messages.push(event));
    const session = new SessionManager().getOrCreateSession('meta');
    request(app, 'running', session.id);
    request(app, 'queued', session.id);
    await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(1));
    options!.onSessionId?.('initial-sdk-session');
    const stopping = app.stop();
    expect(options?.signal?.aborted).toBe(true);
    await stopping;
    expect(completions.map((e) => [e.payload.taskId, e.payload.cancelled]).sort()).toEqual([
      ['queued', true],
      ['running', true],
    ]);
    const messageCount = messages.length;
    const transcriptPath = join(root!, 'data/sessions', session.id, 'transcript.jsonl');
    const transcriptBefore = readFileSync(transcriptPath, 'utf8');
    options!.onAssistantMessage('Late text');
    options!.onToolUse?.('Read', 'late file');
    options!.onRawMessage?.('late raw message');
    options!.onToolResult?.({ toolUseId: 'late-tool', output: 'Late output', isError: false });
    options!.onStderr('late stderr');
    options!.onSessionId?.('late-sdk-session');
    resolveBackend({ result: 'Late success', success: true, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toHaveLength(messageCount);
    expect(readFileSync(transcriptPath, 'utf8')).toBe(transcriptBefore);
    expect(completions).toHaveLength(2);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(() => request(app, 'after-stop')).not.toThrow();
    expect(backend).toHaveBeenCalledTimes(1);
    await app.stop();
  });

  it('streams Raven session IDs and retains the SDK ID separately for resume', async () => {
    const app = await boot(async (opts) => {
      opts.onSessionId?.('sdk-session');
      opts.onAssistantMessage('Hello');
      opts.onToolUse?.('Read', 'file');
      return { sessionId: 'sdk-session', result: 'Hello', success: true, errors: [] };
    });
    await app.start();
    const base = `http://127.0.0.1:${app.port}`;
    const project = (await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Stream identity' }),
      })
    ).json()) as { id: string };
    const messages: AgentMessageEvent[] = [];
    app.eventBus.on<AgentMessageEvent>('agent:message', (event) => messages.push(event));
    const done = new Promise<AgentTaskCompleteEvent>((resolve) =>
      app.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve),
    );
    (await (
      await fetch(`${base}/api/projects/${project.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      })
    ).json()) as { sessionId: string };
    const completion = await done;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(
      messages.every((event) => event.payload.sessionId === completion.payload.sessionId),
    ).toBe(true);
    expect(completion.payload.sessionId).toBeTruthy();
    expect(completion.payload.sessionId).not.toBe('sdk-session');
    expect(completion.payload.sdkSessionId).toBe('sdk-session');
  });
  it('tracks approved actions and settles their HTTP request before shutdown closes the database', async () => {
    let started!: () => void;
    const backendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await boot(async (opts) => {
      started();
      return new Promise<BackendResult>((resolve) => {
        opts.signal!.addEventListener(
          'abort',
          () => resolve({ result: '', success: false, errors: ['cancelled'] }),
          { once: true },
        );
      });
    });
    await app.start();
    const base = `http://127.0.0.1:${app.port}`;
    const done = new Promise<AgentTaskCompleteEvent>((resolve) =>
      app.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve),
    );
    app.eventBus.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'approval-fixture',
        prompt: 'Send fake mail',
        skillName: 'gmail',
        actionName: 'gmail:send-email',
        mcpServers: {},
        priority: 'normal',
      },
    });
    expect((await done).payload.blocked).toBe(true);
    const pending = (await (await fetch(`${base}/api/approvals/pending`)).json()) as Array<{
      id: string;
    }>;
    const approved = fetch(`${base}/api/approvals/${pending[0].id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'approved' }),
    });
    await backendStarted;
    const active = (await (await fetch(`${base}/api/agent-tasks/active`)).json()) as {
      running: Array<{ taskId: string }>;
    };
    expect(active.running).toHaveLength(1);
    const terminal: AgentTaskCompleteEvent[] = [];
    app.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => terminal.push(event));
    const stop = app.stop();
    expect((await approved).status).toBe(200);
    await stop;
    expect(terminal).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ taskId: active.running[0].taskId, cancelled: true }),
      }),
    ]);
  });
  it('reports cancellation acceptance then a single terminal cancelled state', async () => {
    const app = await boot(
      async (opts) =>
        new Promise<BackendResult>((resolve) => {
          opts.signal!.addEventListener(
            'abort',
            () => resolve({ result: 'Success after abort', success: true, errors: [] }),
            { once: true },
          );
        }),
    );
    await app.start();
    const done = new Promise<AgentTaskCompleteEvent>((resolve) =>
      app.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve),
    );
    request(app, 'cancel-me');
    const url = `http://127.0.0.1:${app.port}/api/agent-tasks/cancel-me/cancel`;
    const response = await fetch(url, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'accepted', taskId: 'cancel-me' });
    expect((await done).payload).toMatchObject({
      success: false,
      cancelled: true,
      errors: ['cancelled'],
    });
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
    const persisted = await fetch(`http://127.0.0.1:${app.port}/api/agent-tasks/cancel-me`);
    expect(await persisted.json()).toMatchObject({ status: 'cancelled' });
    expect(app.db.get("SELECT name FROM sqlite_master WHERE name = 'agent_tasks'")).toBeUndefined();
  });
  it('cancels direct retrospective work without late summaries or memory candidates', async () => {
    let started!: () => void;
    let finish!: (result: BackendResult) => void;
    const backendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await boot(async () => {
      started();
      return new Promise<BackendResult>((resolve) => {
        finish = resolve;
      });
    });
    const session = new SessionManager().getOrCreateSession('meta');
    createMessageStore({ basePath: join(root!, 'data/sessions') }).appendMessage(session.id, {
      role: 'user',
      content: 'Remember this preference',
    });
    await app.start();
    const pending = fetch(`http://127.0.0.1:${app.port}/api/sessions/${session.id}/retrospective`, {
      method: 'POST',
    });
    await backendStarted;
    await app.stop();
    expect((await pending).status).toBe(500);
    finish({
      success: true,
      errors: [],
      result: JSON.stringify({
        summary: 'Late summary',
        memoryCandidates: [{ title: 'Late preference', content: 'Never persist this' }],
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(join(root!, 'projects/agents/raven/memory/candidates'))).toBe(false);
  });
  it('retains the prior session summary when retrospective model execution fails', async () => {
    const app = await boot(async () => ({
      success: false,
      errors: ['fake failure'],
      result: 'Do not store this failed result',
    }));
    const sessions = new SessionManager();
    const session = sessions.getOrCreateSession('meta');
    sessions.updateSummary(session.id, 'Existing summary');
    await app.start();
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/sessions/${session.id}/retrospective`,
      { method: 'POST' },
    );
    expect(response.status).toBe(500);
    expect(
      app.db.get<{ summary: string }>('SELECT summary FROM sessions WHERE id = ?', session.id)
        ?.summary,
    ).toBe('Existing summary');
  });
});
