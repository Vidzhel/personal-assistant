import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import type { NotificationEvent } from '@raven/shared';

/**
 * The plan's headline E2E: POST /api/scaffold/schedule with a near-term
 * cron, against a running Raven instance that is NEVER restarted, and the
 * schedule fires anyway. This is the literal proof that scaffoldAndActivate
 * closes the "five painted doors" gap — a scaffolded schedule used to sit
 * inert on disk until the next boot; Task 1 makes it live immediately by
 * resyncing the same croner-backed ScheduleEngine instance in place.
 *
 * The template it targets (quick-ping.yaml) is seeded on disk BEFORE boot
 * (templates are loaded once at startup; nothing in Task 1 makes template
 * *files* hot outside of scaffoldAndActivate's own create_template path —
 * only the SCHEDULE here is created after boot). Its only task is
 * `notify`-type, which task-execution-engine.ts's executeNotifyTask handles
 * synchronously by entering ordinary notification admission — no agent
 * dispatch, no fake-backend plumbing, nothing else to make deterministic.
 *
 * Croner (the cron engine schedule-engine.ts uses) accepts an optional
 * leading seconds field; `* * * * * *` fires every second, which is what
 * makes a sub-2s deterministic poll (no sleep-guessing) below possible.
 */

interface ScheduleFireRow {
  schedule_name: string;
  status: string;
  detail: string;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const QUICK_PING_TEMPLATE = [
  'name: quick-ping',
  'displayName: Quick Ping',
  'description: E2E hot-reload probe template',
  'plan:',
  '  approval: auto',
  '  parallel: true',
  'tasks:',
  '  - id: ping',
  '    type: notify',
  '    title: Ping',
  '    channel: telegram',
  '    message: "ping fired"',
  '',
].join('\n');

describe('e2e: POST /api/scaffold/schedule goes live without a restart', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('a schedule scaffolded after boot fires on its own cron, no restart', async () => {
    const fakeBackend: AgentBackend = async () => ({ result: 'ok', success: true, errors: [] });

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-scaffold-schedule-'));
    const projectsDir = join(tmpDir, 'projects');
    const templatesDir = join(projectsDir, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'quick-ping.yaml'), QUICK_PING_TEMPLATE, 'utf-8');

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir),
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const notifications: NotificationEvent[] = [];
    raven.eventBus.on<NotificationEvent>('notification', (e) => {
      notifications.push(e);
    });

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // No schedule named "ping-now" exists yet — it is created entirely
    // after boot, over the network, exactly as the owner's chat-driven
    // create_schedule MCP tool would (same scaffoldAndActivate path).
    const scaffoldRes = await fetch(`${baseUrl}/api/scaffold/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: '',
        schedule: {
          name: 'ping-now',
          cron: '* * * * * *',
          timezone: 'UTC',
          enabled: true,
          run: { kind: 'template', ref: 'quick-ping' },
        },
      }),
    });
    expect(scaffoldRes.status).toBe(201);
    const scaffolded = (await scaffoldRes.json()) as { live: boolean; path: string };
    expect(scaffolded.live).toBe(true);

    // Deterministic wait on the real observable signals — the notification
    // the notify task emits, and the durable schedule_fires row the engine
    // writes per fire (migration 032) — never a blind sleep.
    await waitFor(() => notifications.length >= 1);

    expect(notifications[0].payload.channel).toBe('telegram');
    expect(notifications[0].payload.body).toContain('ping fired');
    expect(notifications[0].payload.destination).toEqual({ kind: 'global', topic: 'general' });

    const fireRow = raven.db.get<ScheduleFireRow>(
      'SELECT schedule_name, status, detail FROM schedule_fires WHERE schedule_name = ? ORDER BY fired_at DESC LIMIT 1',
      'ping-now',
    );
    expect(fireRow?.status).toBe('fired');
    expect(fireRow?.detail).toBeTruthy();
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/task-trees/${fireRow!.detail}`);
      return response.ok && ((await response.json()) as { status: string }).status === 'completed';
    });
    const treeResponse = await fetch(`${baseUrl}/api/task-trees/${fireRow!.detail}`);
    expect(treeResponse.status).toBe(200);
    expect(await treeResponse.json()).toMatchObject({
      status: 'completed',
      tasks: [expect.objectContaining({ type: 'notify', status: 'completed' })],
    });
  }, 10000);
});
