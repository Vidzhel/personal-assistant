import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import type { NotificationDeliverEvent } from '@raven/shared';

/**
 * F1's boot-bricking half: before the fix, a schedule YAML with an invalid
 * cron/timezone already on disk at boot would make schedule-engine.ts's
 * startEntry throw SYNCHRONOUSLY inside resync()'s unguarded loop —
 * scheduleEngine.start() (called directly in createRaven, not deferred to
 * raven.start()) would throw, and createRaven itself would throw, bricking
 * boot entirely. This test seeds exactly that: a poisoned schedule file
 * alongside a healthy one, and proves boot survives and the healthy
 * schedule still fires — the poisoned entry is skipped (logged), not fatal.
 */

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const QUICK_PING_TEMPLATE = [
  'name: quick-ping',
  'displayName: Quick Ping',
  'description: E2E boot-resilience probe template',
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

const POISON_SCHEDULE = [
  'name: poison-cron',
  'cron: "not a cron expression"',
  'timezone: UTC',
  'enabled: true',
  'run:',
  '  kind: template',
  '  ref: quick-ping',
  '',
].join('\n');

const HEALTHY_SCHEDULE = [
  'name: ping-now',
  'cron: "* * * * * *"',
  'timezone: UTC',
  'enabled: true',
  'run:',
  '  kind: template',
  '  ref: quick-ping',
  '',
].join('\n');

describe('e2e: boot survives a pre-existing invalid schedule YAML (F1)', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('boots successfully, skips the poisoned schedule, and still fires the healthy one', async () => {
    const fakeBackend: AgentBackend = async () => ({ result: 'ok', success: true, errors: [] });

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-boot-invalid-schedule-'));
    const projectsDir = join(tmpDir, 'projects');
    const templatesDir = join(projectsDir, 'templates');
    const schedulesDir = join(projectsDir, 'schedules');
    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(schedulesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'quick-ping.yaml'), QUICK_PING_TEMPLATE, 'utf-8');
    writeFileSync(join(schedulesDir, 'poison-cron.yaml'), POISON_SCHEDULE, 'utf-8');
    writeFileSync(join(schedulesDir, 'ping-now.yaml'), HEALTHY_SCHEDULE, 'utf-8');

    // The core assertion: createRaven must not throw even though a
    // syntactically-invalid cron is already on disk at boot.
    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir),
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const notifications: NotificationDeliverEvent[] = [];
    raven.eventBus.on<NotificationDeliverEvent>('notification:deliver', (e) => {
      notifications.push(e);
    });

    // The healthy schedule still fires on its own cron — proof that the
    // poisoned entry, iterated in the same resync() loop, did not abort
    // scheduling for anything after it.
    await waitFor(() => notifications.length >= 1);
    expect(notifications[0].payload.body).toContain('ping fired');
  }, 10000);
});
