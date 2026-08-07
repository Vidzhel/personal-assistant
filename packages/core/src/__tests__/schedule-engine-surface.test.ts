import { describe, it, expect, vi } from 'vitest';
import { createScheduleEngine } from '../scheduler/schedule-engine.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import type { ScheduleYaml } from '@raven/shared';

function defs(): ScheduleYaml[] {
  return [
    {
      name: 'has-job',
      cron: '0 * * * *',
      timezone: 'UTC',
      enabled: true,
      params: {},
      run: { kind: 'job', ref: 'has-job' },
    },
    {
      name: 'no-job',
      cron: '0 * * * *',
      timezone: 'UTC',
      enabled: true,
      params: {},
      run: { kind: 'job', ref: 'missing' },
    },
  ];
}

function fakePrefs() {
  const m = new Map<string, boolean>();
  return {
    getEnabledOverride: (n: string) => m.get(n),
    setEnabledOverride: (n: string, e: boolean) => void m.set(n, e),
  };
}

function makeEngine() {
  const jobRegistry = createJobRegistry();
  const ran: string[] = [];
  jobRegistry.register('has-job', async () => {
    ran.push('has-job');
    return { summary: 'ok' };
  });
  const taskStore = {
    createTask: vi.fn(() => ({ id: 't' })),
    updateTask: vi.fn(() => ({ id: 't' })),
  };
  const engine = createScheduleEngine({
    schedules: defs(),
    jobRegistry,
    taskStore: taskStore as any,
    timezone: 'UTC',
    schedulePrefs: fakePrefs(),
  });
  return { engine, ran };
}

describe('schedule engine surface', () => {
  it('lists schedules with registered flag (skips unregistered job)', () => {
    const { engine } = makeEngine();
    engine.start();
    const list = engine.list();
    const hasJob = list.find((s) => s.name === 'has-job')!;
    const noJob = list.find((s) => s.name === 'no-job')!;
    expect(hasJob.registered).toBe(true);
    expect(hasJob.enabled).toBe(true);
    expect(hasJob.nextRun).not.toBeNull();
    expect(noJob.registered).toBe(false);
    expect(noJob.nextRun).toBeNull();
    engine.stop();
  });

  it('getActiveCount counts only running crons', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);
    engine.stop();
  });

  it('setEnabled(false) stops the cron; setEnabled(true) restarts it', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);
    engine.setEnabled('has-job', false);
    expect(engine.getActiveCount()).toBe(0);
    expect(engine.list().find((s) => s.name === 'has-job')!.enabled).toBe(false);
    engine.setEnabled('has-job', true);
    expect(engine.getActiveCount()).toBe(1);
    engine.stop();
  });

  it('runNow invokes the handler immediately', async () => {
    const { engine, ran } = makeEngine();
    engine.start();
    await engine.runNow('has-job');
    expect(ran).toContain('has-job');
    engine.stop();
  });

  it('start() is idempotent (no orphaned crons on double start)', () => {
    const { engine } = makeEngine();
    engine.start();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);
    engine.stop();
  });

  it('reload() picks up a newly added schedule without recreating the engine', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);

    // reload() never touches jobRegistry/taskStore/schedulePrefs/
    // scheduleFireLog (only deps.schedules) — reusing the "has-job" ref
    // that makeEngine() already registered is enough to prove a brand new
    // schedule definition gets picked up live.
    engine.reload([
      ...defs(),
      {
        name: 'brand-new',
        cron: '0 * * * *',
        timezone: 'UTC',
        enabled: true,
        params: {},
        run: { kind: 'job', ref: 'has-job' },
      },
    ]);

    const list = engine.list();
    expect(list.find((s) => s.name === 'brand-new')).toBeDefined();
    expect(engine.getActiveCount()).toBe(2);
    engine.stop();
  });

  it('reload() drops a schedule that is no longer in the new list', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);

    engine.reload([]);

    expect(engine.list()).toHaveLength(0);
    expect(engine.getActiveCount()).toBe(0);
    engine.stop();
  });

  it('reload() preserves enabled-overrides made via schedulePrefs', () => {
    const { engine } = makeEngine();
    engine.start();
    engine.setEnabled('has-job', false);
    expect(engine.getActiveCount()).toBe(0);

    engine.reload(defs());

    // The override was set on the shared schedulePrefs fake, which reload()
    // never touches — the schedule stays disabled across the resync.
    expect(engine.list().find((s) => s.name === 'has-job')!.enabled).toBe(false);
    expect(engine.getActiveCount()).toBe(0);
    engine.stop();
  });
});
