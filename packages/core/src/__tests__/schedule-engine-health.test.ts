import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import { createScheduleEngine } from '../scheduler/schedule-engine.ts';
import type { ScheduleYaml } from '@raven/shared';

const engines = new Set<ReturnType<typeof createScheduleEngine>>();
const releases = new Set<() => void>();

function schedule(overrides: Partial<ScheduleYaml> = {}): ScheduleYaml {
  return {
    name: 'health-probe',
    cron: '0 0 1 1 *',
    timezone: 'UTC',
    enabled: true,
    params: {},
    run: { kind: 'job', ref: 'health-probe' },
    ...overrides,
  };
}

function makeEngine(
  definition: ScheduleYaml = schedule(),
  now: () => number = () => Date.now(),
): {
  engine: ReturnType<typeof createScheduleEngine>;
  register: (handler: () => Promise<{ summary?: string }>) => void;
} {
  const registry = createJobRegistry();
  const engine = createScheduleEngine({
    schedules: [definition],
    jobRegistry: registry,
    taskStore: {
      createTask: vi.fn(() => ({ id: 'scheduled-task' })),
      updateTask: vi.fn(() => ({ id: 'scheduled-task' })),
    } as never,
    timezone: 'UTC',
    now,
  });
  engines.add(engine);
  return {
    engine,
    register: (handler) => registry.register(definition.run.ref, handler),
  };
}

describe('schedule engine health', () => {
  afterEach(async () => {
    for (const release of releases) release();
    await Promise.all([...engines].map((engine) => engine.stop()));
    releases.clear();
    engines.clear();
  });

  it('reports activation and active state with a deterministic clock', async () => {
    let now = 1_000;
    const { engine, register } = makeEngine(schedule(), () => now);
    register(async () => ({ summary: 'ok' }));

    engine.start();
    expect(engine.getHealth()[0]).toMatchObject({
      name: 'health-probe',
      active: true,
      activatedAt: 1_000,
      inFlightSince: null,
    });

    now = 2_000;
    engine.reload([schedule()]);
    expect(engine.getHealth()[0]?.activatedAt).toBe(1_000);

    await engine.stop();
  });

  it('preserves activation when only object key ordering changes', () => {
    let now = 1_000;
    const original = schedule({
      params: { z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] },
      run: { kind: 'job', ref: 'health-probe' },
    });
    const { engine, register } = makeEngine(original, () => now);
    register(async () => ({ summary: 'ok' }));
    engine.start();
    const activationId = engine.getHealth()[0]?.activationId;

    now = 2_000;
    engine.reload([
      schedule({
        params: { a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } },
        run: { ref: 'health-probe', kind: 'job' },
      }),
    ]);

    expect(engine.getHealth()[0]).toMatchObject({ activatedAt: 1_000, activationId });
  });

  it('resets activation for material changes and enable transitions', async () => {
    let now = 1_000;
    const { engine, register } = makeEngine(schedule(), () => now);
    register(async () => ({ summary: 'ok' }));
    engine.start();

    now = 2_000;
    engine.reload([schedule({ cron: '0 1 1 1 *' })]);
    expect(engine.getHealth()[0]?.activatedAt).toBe(2_000);

    now = 3_000;
    expect(engine.setEnabled('health-probe', false)).toBe(true);
    expect(engine.getHealth()[0]).toMatchObject({ enabled: false, active: false });

    now = 4_000;
    expect(engine.setEnabled('health-probe', true)).toBe(true);
    expect(engine.getHealth()[0]).toMatchObject({
      enabled: true,
      active: true,
      activatedAt: 4_000,
    });

    await engine.stop();
  });

  it('keeps an in-flight manual fire visible before its handler starts and drains it on stop', async () => {
    const now = 1_000;
    let handlerStarted = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.add(release);
    const { engine, register } = makeEngine(schedule(), () => now);
    register(async () => {
      handlerStarted = true;
      await held;
      return { summary: 'ok' };
    });
    engine.start();

    const run = engine.runNow('health-probe');
    expect(handlerStarted).toBe(false);
    expect(engine.getHealth()[0]?.inFlightSince).toBe(1_000);

    let stopped = false;
    const stopping = engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(await engine.runNow('health-probe')).toBe(false);

    release();
    await Promise.all([run, stopping]);
    expect(engine.getHealth()[0]).toMatchObject({ active: false, inFlightSince: null });
  });

  it('keeps the oldest of concurrent invocations visible until each one finishes', async () => {
    let now = 1_000;
    const finish: Array<() => void> = [];
    const { engine, register } = makeEngine(schedule(), () => now);
    register(async () => {
      await new Promise<void>((resolve) => {
        finish.push(resolve);
        releases.add(resolve);
      });
      return { summary: 'done' };
    });
    engine.start();
    const first = engine.runNow('health-probe');
    await Promise.resolve();
    now = 2_000;
    const second = engine.runNow('health-probe');
    await Promise.resolve();
    expect(engine.getHealth()[0]?.inFlightSince).toBe(1_000);
    finish[0]();
    await first;
    expect(engine.getHealth()[0]?.inFlightSince).toBe(2_000);
    finish[1]();
    await second;
    expect(engine.getHealth()[0]?.inFlightSince).toBeNull();
  });

  it('does not expose an old activation as in flight after a changed reload', async () => {
    let now = 1_000;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.add(release);
    const { engine, register } = makeEngine(schedule(), () => now);
    register(async () => {
      await held;
      return { summary: 'ok' };
    });
    engine.start();
    const oldRun = engine.runNow('health-probe');
    const oldActivation = engine.getHealth()[0]?.activationId;
    expect(engine.getHealth()[0]?.inFlightSince).toBe(1_000);

    now = 2_000;
    engine.reload([schedule({ cron: '0 1 1 1 *' })]);
    expect(engine.getHealth()[0]).toMatchObject({ inFlightSince: null, activatedAt: 2_000 });
    expect(engine.getHealth()[0]?.activationId).not.toBe(oldActivation);

    release();
    await oldRun;
    await engine.stop();
  });

  it('does not mutate effective state when persisting an enabled override fails', async () => {
    let persist = true;
    const registry = createJobRegistry();
    registry.register('health-probe', async () => ({ summary: 'ok' }));
    const engine = createScheduleEngine({
      schedules: [schedule()],
      jobRegistry: registry,
      taskStore: {
        createTask: vi.fn(() => ({ id: 'scheduled-task' })),
        updateTask: vi.fn(() => ({ id: 'scheduled-task' })),
      } as never,
      timezone: 'UTC',
      schedulePrefs: {
        getEnabledOverride: () => undefined,
        setEnabledOverride: () => {
          if (persist) throw new Error('preference store unavailable');
        },
      },
    });
    engine.start();

    expect(() => engine.setEnabled('health-probe', false)).toThrow('preference store unavailable');
    expect(engine.getHealth()[0]).toMatchObject({ enabled: true, active: true });

    persist = false;
    await engine.stop();
  });

  it('rejects restart while a previous stop is still draining, then reopens after drain', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.add(release);
    const { engine, register } = makeEngine();
    register(async () => {
      await held;
      return { summary: 'ok' };
    });
    engine.start();
    const run = engine.runNow('health-probe');
    const stopping = engine.stop();
    engine.start();
    expect(engine.getHealth()[0]?.active).toBe(false);

    release();
    await Promise.all([run, stopping]);
    engine.start();
    expect(engine.getHealth()[0]?.active).toBe(true);
    await engine.stop();
  });
});
