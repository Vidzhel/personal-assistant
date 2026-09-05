import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentTaskCompleteEvent,
  NotificationEvent,
  NotificationDeliverEvent,
} from '@raven/shared';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('e2e: heartbeat silence through the real scheduled model boundary', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    raven = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('records silent checks without chat completion, then notifies only for actionable content', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-heartbeat-'));
    const fixture = createRavenTestFixture(root);
    const schedulesDir = join(fixture.projectsDir, 'schedules');
    mkdirSync(schedulesDir);
    writeFileSync(
      join(schedulesDir, 'heartbeat.yaml'),
      JSON.stringify({
        name: 'heartbeat',
        cron: '0 0 1 1 *',
        timezone: 'UTC',
        enabled: false,
        run: { kind: 'heartbeat', ref: 'heartbeat' },
      }),
    );
    let reply = '**HEARTBEAT_OK**';
    const calls: BackendOptions[] = [];
    raven = await createRaven(
      { ...buildTestConfig(), RAVEN_HEARTBEAT_ACTIVE_HOURS: '00-24' },
      {
        ...fixture,
        skipSuites: true,
        agentBackend: async (options) => {
          calls.push(options);
          options.onAssistantMessage(reply);
          return { result: reply, success: true, errors: [], estimatedCostUsd: 0.03 };
        },
      },
    );
    await raven.start();
    const baseUrl = `http://127.0.0.1:${raven.port}`;
    const notifications: NotificationEvent[] = [];
    const deliveries: NotificationDeliverEvent[] = [];
    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<NotificationEvent>('notification', (event) => notifications.push(event));
    raven.eventBus.on<NotificationDeliverEvent>('notification:deliver', (event) =>
      deliveries.push(event),
    );
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) =>
      completions.push(event),
    );
    const beforeSessions = raven.db.get<{ total: number }>(
      'SELECT count(*) AS total FROM sessions',
    )!.total;

    const silentResponse = await fetch(`${baseUrl}/api/schedules/heartbeat/trigger`, {
      method: 'POST',
    });
    expect(silentResponse.status).toBe(200);
    expect(await silentResponse.json()).toEqual({ triggered: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].maxTurns).toBe(8);
    expect(calls[0].agents).toEqual({});
    expect(notifications).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(completions).toEqual([]);
    expect(
      raven.db.get<{ status: string; detail: string }>(
        'SELECT status, detail FROM schedule_fires WHERE schedule_name = ?',
        'heartbeat',
      ),
    ).toEqual({ status: 'completed', detail: 'HEARTBEAT_OK (swallowed)' });
    expect(raven.db.get<{ total: number }>('SELECT count(*) AS total FROM sessions')!.total).toBe(
      beforeSessions,
    );

    reply = 'A pending approval needs your decision.';
    const alertResponse = await fetch(`${baseUrl}/api/schedules/heartbeat/trigger`, {
      method: 'POST',
    });
    expect(alertResponse.status).toBe(200);
    expect(await alertResponse.json()).toEqual({ triggered: true });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.maxBudgetUsd! > 0 && call.taskId)).toBe(true);
    const budgetResponse = await fetch(`${baseUrl}/api/budget`);
    expect(budgetResponse.status).toBe(200);
    expect(await budgetResponse.json()).toMatchObject({
      knownUsd: 0.06,
      reservedUsd: 0,
      unknownUsd: 0,
      counts: { known: 2, reserved: 0, unknown: 0 },
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        source: 'heartbeat',
        payload: { channel: 'telegram', title: 'Heartbeat', body: reply, topicName: 'System' },
      }),
    ]);
    expect(completions).toEqual([]);
    expect(
      raven.db.all<{ status: string; detail: string }>(
        'SELECT status, detail FROM schedule_fires WHERE schedule_name = ? ORDER BY fired_at',
        'heartbeat',
      ),
    ).toEqual([
      { status: 'completed', detail: 'HEARTBEAT_OK (swallowed)' },
      { status: 'completed', detail: 'notified owner' },
    ]);
  }, 10_000);
});
