import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
 * tree stuck in "running" for >24h directly in the DB -> trigger the real
 * `self-test` schedule via `POST /api/schedules/:id/trigger` (the same
 * route the dashboard's schedule "run now" button hits, same as
 * e2e-memory-loop.test.ts) -> the job emits one batched `notification`
 * event and persists a violation -> `/api/health` reflects it.
 */
describe('e2e: self-test detects a stuck task tree', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('seeded stuck tree -> self-test job -> notification + health violation', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-self-test-'));

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir, { schedule: 'self-test' }),
      agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
      skipSuites: true,
    });
    await raven.start();

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // ── Seed a task tree stuck "running" for >24h ───────────────────
    const stuckAt = new Date(Date.now() - 25 * MS_PER_HOUR).toISOString();
    raven.db.run(
      `INSERT INTO task_trees (id, project_id, schedule_id, status, plan, created_at, updated_at)
       VALUES (?, NULL, NULL, 'running', NULL, ?, ?)`,
      'e2e-stuck-tree',
      stuckAt,
      stuckAt,
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
