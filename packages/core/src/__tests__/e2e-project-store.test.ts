import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { AgentTaskCompleteEvent, UserChatMessageEvent } from '@raven/shared';

/**
 * E2E coverage of Phase 3 Task 1's invariant — "a project EXISTS iff a
 * registry node (directory under projects/) exists" — over the real
 * composition root, starting with only a no-skills default agent and no
 * pre-existing ordinary projects, so both creation surfaces scaffold files:
 *
 *  1. POST /api/projects (web/API surface) → scaffolds a directory,
 *     reloads the registry, and links the DB cache row by fs_path — then
 *     chat against that project still works.
 *  2. orchestrator.ensureProject (Telegram/chat surface) → the same, driven
 *     by a `user:chat:message` event carrying a topic name instead of an
 *     HTTP call.
 */

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function buildFakeBackend(): { backend: AgentBackend; calls: BackendOptions[] } {
  const calls: BackendOptions[] = [];
  const backend: AgentBackend = async (opts) => {
    calls.push(opts);
    opts.onSessionId?.(`sdk-${String(calls.length)}`);
    const replyText = `Reply ${String(calls.length)}`;
    opts.onAssistantMessage(replyText);
    return {
      sessionId: `sdk-${String(calls.length)}`,
      result: replyText,
      success: true,
      errors: [],
    };
  };
  return { backend, calls };
}

describe('e2e: filesystem-first project store', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('POST /api/projects scaffolds a directory, links the cache row, and chat works', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-project-store-'));
    const projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const { backend: fakeBackend } = buildFakeBackend();

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir),
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (e) => {
      completions.push(e);
    });

    const baseUrl = `http://localhost:${String(raven.port)}`;

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Marketing Team' }),
    });
    expect(createRes.status).toBe(200);
    const project = (await createRes.json()) as { id: string; fsPath?: string };
    expect(project.fsPath).toBe('marketing-team');
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);

    // Directory + registry node exist on disk.
    expect(existsSync(join(projectsDir, 'marketing-team', 'context.md'))).toBe(true);

    // DB cache row is linked by fs_path.
    const cacheRow = raven.db.get<{ fs_path: string | null }>(
      'SELECT fs_path FROM projects WHERE id = ?',
      project.id,
    );
    expect(cacheRow?.fs_path).toBe('marketing-team');

    // Chat against the newly-scaffolded project still works end to end.
    const sessionRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { id: string };

    const chatRes = await fetch(`${baseUrl}/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello from Marketing', sessionId: session.id }),
    });
    expect(chatRes.status).toBe(200);

    await waitFor(() => completions.length >= 1);
    expect(completions[0].payload.success).toBe(true);
  }, 10000);

  it('ensureProject scaffolds a directory for a Telegram topic before chat runs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-project-store-tg-'));
    const projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const { backend: fakeBackend } = buildFakeBackend();

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir),
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (e) => {
      completions.push(e);
    });

    raven.eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'telegram',
      type: 'user:chat:message',
      payload: {
        projectId: 'telegram-general',
        message: 'Hello from the General topic',
        topicId: 42,
        topicName: 'General',
      },
    } satisfies UserChatMessageEvent);

    await waitFor(() => completions.length >= 1);
    expect(completions[0].payload.success).toBe(true);

    // ensureProject scaffolded a real directory named after the topic, not
    // the numeric topic id or the raw telegram-* project id.
    expect(existsSync(join(projectsDir, 'general', 'context.md'))).toBe(true);

    const cacheRow = raven.db.get<{ fs_path: string | null; name: string }>(
      'SELECT fs_path, name FROM projects WHERE id = ?',
      'telegram-general',
    );
    expect(cacheRow?.fs_path).toBe('general');
    expect(cacheRow?.name).toBe('General');
  }, 10000);
});
