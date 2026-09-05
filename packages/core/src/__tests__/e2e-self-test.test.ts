import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { stringify } from 'yaml';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { NotificationEvent } from '@raven/shared';

const MS_PER_HOUR = 3_600_000;

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * E2E over the real composition root: createRaven -> start -> seed a task
 * tree stuck in "running" for >24h directly in project YAML -> trigger the real
 * `self-test` schedule via `POST /api/schedules/:id/trigger` (the same
 * route the dashboard's schedule "run now" button hits, same as
 * e2e-memory-loop.test.ts) -> the job emits one batched `notification`
 * event and persists a violation -> `/api/health` reflects it.
 */
describe('e2e: self-test detects a stuck task tree', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('reports missed ordinary fires, observes its own running fire, and clears repaired or disabled schedules', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-schedule-health-'));
    const fixture = createRavenTestFixture(tmpDir, { schedule: 'self-test' });
    const now = Date.now();
    // A daily cron three minutes ago is overdue without racing ambient timers.
    const due = new Date(now - 3 * 60_000);
    const cron = `${due.getUTCMinutes()} ${due.getUTCHours()} * * *`;
    for (const [name, ref] of [
      ['self-test', 'self-test'],
      ['ordinary', 'task-archival'],
    ]) {
      writeFileSync(
        join(fixture.projectsDir, 'schedules', `${name}.yaml`),
        stringify({
          name,
          cron,
          timezone: 'UTC',
          enabled: true,
          run: { kind: 'job', ref },
        }),
      );
    }
    // Age activation only. Real Croner and HTTP timers still use the real clock.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 10 * 60_000);
    try {
      raven = await createRaven(buildTestConfig(), {
        ...fixture,
        agentBackend: async () => {
          throw new Error('Self-test must not call a model');
        },
        skipSuites: true,
      });
    } finally {
      clock.mockRestore();
    }
    await raven.start();
    const baseUrl = `http://127.0.0.1:${raven.port}`;
    const run = async (name: string) => {
      const response = await fetch(`${baseUrl}/api/schedules/${name}/trigger`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ triggered: true });
    };
    const scheduleViolations = async (): Promise<string[]> => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);
      const health = (await response.json()) as { selfTest: { violations: string[] } };
      return health.selfTest.violations.filter((issue) => issue.startsWith('Schedule '));
    };

    await run('self-test');
    const missing = await scheduleViolations();
    expect(missing.some((issue) => issue.includes('ordinary'))).toBe(true);
    expect(missing.some((issue) => issue.includes('Schedule "self-test"'))).toBe(false);

    await run('ordinary');
    await run('self-test');
    expect(await scheduleViolations()).toEqual([]);

    raven.db.run(
      'INSERT INTO schedule_fires (id, schedule_name, fired_at, status, detail) VALUES (?, ?, ?, ?, ?)',
      'disabled-failure',
      'ordinary',
      new Date(Date.now() + 1).toISOString(),
      'blocked',
      'test failure',
    );
    const disabled = await fetch(`${baseUrl}/api/schedules/ordinary`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await run('self-test');
    expect(await scheduleViolations()).toEqual([]);
  }, 15_000);

  it('seeded stuck tree -> self-test job -> notification + health violation', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-self-test-'));

    const fixture = createRavenTestFixture(tmpDir, { schedule: 'self-test' });
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
      skipSuites: true,
    });
    await raven.start();

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // ── Seed a task tree stuck "running" for >24h ───────────────────
    const stuckAt = new Date(Date.now() - 25 * MS_PER_HOUR).toISOString();
    const directory = join(fixture.projectsDir, 'system', 'tasks', 'trees');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'e2e-stuck-tree.yaml'),
      stringify({
        id: 'e2e-stuck-tree',
        status: 'running',
        createdAt: stuckAt,
        updatedAt: stuckAt,
        tasks: [
          {
            id: 'waiting',
            parentTaskId: 'e2e-stuck-tree',
            node: {
              id: 'waiting',
              type: 'approval',
              title: 'Waiting',
              message: 'Review',
              blockedBy: [],
            },
            status: 'pending_approval',
            artifacts: [],
            retryCount: 0,
          },
        ],
      }),
    );

    // ── Drive the self-test job deterministically ───────────────────
    const notifications: NotificationEvent[] = [];
    raven.eventBus.on<NotificationEvent>('notification', (e) => {
      if (e.source === 'self-test') notifications.push(e);
    });

    const triggerRes = await fetch(`${baseUrl}/api/schedules/self-test/trigger`, {
      method: 'POST',
    });
    expect(triggerRes.status).toBe(200);
    expect(await triggerRes.json()).toEqual({ triggered: true });

    await waitFor(() => notifications.length >= 1);
    expect(notifications[0].payload.channel).toBe('telegram');
    expect(notifications[0].payload.body).toContain('e2e-stuck-tree');

    // ── /api/health surfaces the violation ───────────────────────────
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      selfTest: { ok: boolean; lastRun: string | null; violations: string[] };
    };
    expect(health.selfTest.ok).toBe(false);
    expect(health.selfTest.lastRun).not.toBeNull();
    expect(health.selfTest.violations.some((v) => v.includes('e2e-stuck-tree'))).toBe(true);

    await raven.stop();
    raven = undefined;
  }, 15000);
});
