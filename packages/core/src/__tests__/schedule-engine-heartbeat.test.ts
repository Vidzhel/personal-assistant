import { describe, it, expect, vi } from 'vitest';
import { runScheduledHeartbeat, createScheduleEngine } from '../scheduler/schedule-engine.ts';
import type { ScheduleYaml } from '@raven/shared';

const heartbeatDef: ScheduleYaml = {
  name: 'heartbeat',
  cron: '0 * * * *',
  timezone: 'UTC',
  enabled: true,
  params: undefined,
  run: { kind: 'heartbeat', ref: 'heartbeat' },
};

describe('runScheduledHeartbeat', () => {
  it('fires the heartbeat and records a completed fire-log entry with its summary', async () => {
    const fireHeartbeat = vi.fn().mockResolvedValue({ summary: 'HEARTBEAT_OK (swallowed)' });
    const scheduleFireLog = { record: vi.fn() };

    await runScheduledHeartbeat(heartbeatDef, { fireHeartbeat, scheduleFireLog });

    expect(fireHeartbeat).toHaveBeenCalledTimes(1);
    expect(scheduleFireLog.record).toHaveBeenCalledWith('heartbeat', 'completed', {
      detail: 'HEARTBEAT_OK (swallowed)',
    });
  });

  it('does not throw when fireHeartbeat rejects, and records a failed fire-log entry', async () => {
    const fireHeartbeat = vi.fn().mockRejectedValue(new Error('boom'));
    const scheduleFireLog = { record: vi.fn() };

    await expect(
      runScheduledHeartbeat(heartbeatDef, { fireHeartbeat, scheduleFireLog }),
    ).resolves.toBeUndefined();
    expect(scheduleFireLog.record).toHaveBeenCalledWith('heartbeat', 'failed', {
      detail: expect.any(String),
    });
  });
});

describe('createScheduleEngine: heartbeat-kind wiring', () => {
  function makeEngineDeps(fireHeartbeat?: () => Promise<{ summary: string }>) {
    return {
      schedules: [heartbeatDef],
      jobRegistry: { has: () => false, get: () => undefined, register: vi.fn(), list: () => [] },
      taskStore: { createTask: vi.fn(), updateTask: vi.fn() },
      timezone: 'UTC',
      ...(fireHeartbeat && { fireHeartbeat }),
    };
  }

  it('registers a heartbeat-kind schedule as registered+enabled when fireHeartbeat is configured', () => {
    const engine = createScheduleEngine(
      makeEngineDeps(vi.fn().mockResolvedValue({ summary: 'ok' })),
    );
    engine.start();
    const info = engine.list().find((s) => s.name === 'heartbeat');
    expect(info?.kind).toBe('heartbeat');
    expect(info?.registered).toBe(true);
    engine.stop();
  });

  it('runNow dispatches to the configured fireHeartbeat handler', async () => {
    const fireHeartbeat = vi.fn().mockResolvedValue({ summary: 'notified owner' });
    const engine = createScheduleEngine(makeEngineDeps(fireHeartbeat));
    engine.start();

    const ran = await engine.runNow('heartbeat');

    expect(ran).toBe(true);
    expect(fireHeartbeat).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it('logs a blocked fire (not a throw) when no fireHeartbeat handler is configured', async () => {
    const scheduleFireLog = { record: vi.fn() };
    const engine = createScheduleEngine({ ...makeEngineDeps(), scheduleFireLog });
    engine.start();

    const ran = await engine.runNow('heartbeat');

    expect(ran).toBe(true);
    expect(scheduleFireLog.record).toHaveBeenCalledWith(
      'heartbeat',
      'blocked',
      expect.objectContaining({ detail: expect.stringContaining('no fireHeartbeat handler') }),
    );
    engine.stop();
  });
});
