import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { StoredMessage } from '../session-manager/message-store.ts';
import type { AgentTaskCompleteEvent } from '@raven/shared';

// Real projects/ tree, copied per-test into a tmp dir (see projectsDir
// override below) so POST /api/projects scaffolding a real directory never
// touches the checked-out repo.
const REAL_PROJECTS_DIR = resolve(import.meta.dirname!, '..', '..', '..', '..', 'projects');

/**
 * E2E chat round-trip over the real composition root: createRaven -> start
 * -> POST /api/projects/:id/chat (the same HTTP endpoint the web client's
 * useChat hook drives its WebSocket "chat:send" through — both paths just
 * emit `user:chat:message`, see api/ws/handler.ts) -> reply observed on the
 * event bus and in the message store -> a SECOND turn on the same session
 * proves SDK session `resume` actually threads through
 * orchestrator -> agent-manager -> agent-session -> the backend seam.
 *
 * No mocked SDK: a real fake `AgentBackend` is injected via
 * createRaven's `agentBackend` override (the same seam boot-smoke.test.ts
 * uses), so this exercises the exact wiring production takes minus the
 * actual `claude` subprocess.
 */

function buildTestConfig(): AppConfig {
  return {
    ANTHROPIC_API_KEY: '',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 0,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'ravenpassword',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
    RAVEN_HEARTBEAT_ACTIVE_HOURS: '08-22',
  };
}

/** Polls until `predicate` is true or `timeoutMs` elapses. The fake backend
 * below resolves synchronously-ish (no real subprocess/network), so this
 * should never actually wait long — it exists to avoid a hard race between
 * the HTTP response (which returns before the async chat pipeline runs)
 * and the event-bus/message-store side effects it triggers. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('e2e: chat round-trip over the real composition root', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('turn 1 runs cold, turn 2 resumes the SDK session the fake backend minted', async () => {
    // Records BackendOptions per call so we can assert exactly what the
    // backend seam receives — the fields the plan calls out: resume,
    // systemPrompt, prompt.
    const calls: BackendOptions[] = [];
    const fakeBackend: AgentBackend = async (opts) => {
      calls.push(opts);
      const turn = calls.length;
      const sessionId = 'sdk-1'; // SDK continues the same id across resumes
      opts.onSessionId?.(sessionId);
      const replyText = `Reply to turn ${String(turn)}`;
      opts.onAssistantMessage(replyText);
      return { sessionId, result: replyText, success: true, errors: [] };
    };

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-chat-'));
    const dbPath = join(tmpDir, 'test.db');
    const projectsDir = join(tmpDir, 'projects');
    cpSync(REAL_PROJECTS_DIR, projectsDir, { recursive: true });

    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      projectsDir,
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (e) => {
      completions.push(e);
    });

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // Mirror the web client's init flow (useChat.ts): create a project,
    // then get-or-create its active session, before sending any message.
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Chat Round-Trip Project' }),
    });
    expect(projectRes.status).toBe(200);
    const project = (await projectRes.json()) as { id: string };

    const sessionRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { id: string; status: string };
    expect(session.id).toBeDefined();
    expect(session.status).toBe('idle');

    // Session list (ported from the deleted e2e.test.ts's "session
    // creation and message history" case).
    const sessionListRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`);
    expect(sessionListRes.status).toBe(200);
    const sessionList = (await sessionListRes.json()) as unknown[];
    expect(sessionList.length).toBeGreaterThanOrEqual(1);

    // ── Turn 1 ──────────────────────────────────────────────────────
    const chatRes1 = await fetch(`${baseUrl}/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello Raven, turn one', sessionId: session.id }),
    });
    expect(chatRes1.status).toBe(200);
    expect(await chatRes1.json()).toEqual({ status: 'queued' });

    await waitFor(() => completions.length >= 1);

    expect(calls.length).toBe(1);
    // Turn 1 must run cold: no prior sdk_session_id exists for this Raven
    // session yet.
    expect(calls[0].resume).toBeUndefined();
    expect(calls[0].prompt).toContain('Hello Raven, turn one');
    expect(typeof calls[0].systemPrompt).toBe('string');
    expect(calls[0].systemPrompt.length).toBeGreaterThan(0);

    expect(completions[0].payload.success).toBe(true);
    expect(completions[0].payload.sessionId).toBe(session.id);
    expect(completions[0].payload.sdkSessionId).toBe('sdk-1');

    // Reply reached the message store.
    const messagesAfterTurn1Res = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`);
    expect(messagesAfterTurn1Res.status).toBe(200);
    const messagesAfterTurn1 = (await messagesAfterTurn1Res.json()) as StoredMessage[];
    expect(
      messagesAfterTurn1.some((m) => m.role === 'assistant' && m.content === 'Reply to turn 1'),
    ).toBe(true);

    // Message ordering (ported from the deleted e2e.test.ts's "message
    // ordering" case): the "thinking" message agent-manager appends
    // before dispatching to the backend must land before the assistant
    // reply the backend produces.
    const thinkingIdx = messagesAfterTurn1.findIndex((m) => m.role === 'thinking');
    const assistantIdx = messagesAfterTurn1.findIndex((m) => m.role === 'assistant');
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(assistantIdx);

    // ── Turn 2 (same project/session) ──────────────────────────────
    const chatRes2 = await fetch(`${baseUrl}/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello Raven, turn two', sessionId: session.id }),
    });
    expect(chatRes2.status).toBe(200);
    expect(await chatRes2.json()).toEqual({ status: 'queued' });

    await waitFor(() => completions.length >= 2);

    expect(calls.length).toBe(2);
    // Turn 2 must resume the SDK session id the fake backend returned on
    // turn 1 — this is the whole point of the round-trip.
    expect(calls[1].resume).toBe('sdk-1');
    expect(calls[1].prompt).toContain('Hello Raven, turn two');

    const messagesAfterTurn2Res = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`);
    const messagesAfterTurn2 = (await messagesAfterTurn2Res.json()) as StoredMessage[];
    expect(messagesAfterTurn2.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(
      messagesAfterTurn2.some((m) => m.role === 'assistant' && m.content === 'Reply to turn 2'),
    ).toBe(true);

    // Clean stop — no dangling handles (vitest hangs otherwise; that IS
    // part of the assertion, same as boot-smoke.test.ts).
    await raven.stop();
    raven = undefined;
  }, 10000);
});
