import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleYaml } from '@raven/shared';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import { createScheduleEngine, type TaskStoreLike } from '../scheduler/schedule-engine.ts';
import { createScheduleFireLog } from '../scheduler/schedule-fire-log.ts';
import { checkScheduleHealth } from '../services/system/self-test.ts';

const initialSchema = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../migrations/001-initial-schema.sql',
);
const MINUTE_MS = 60_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recentScheduleCron(nowMs: number): string {
  const minute = (new Date(nowMs).getUTCMinutes() + 58) % 60;
  return `${String(minute)} * * * *`;
}

function schedule(cron: string, ref: string, version: number): ScheduleYaml {
  return {
    name: 'reloadable-job',
    cron,
    timezone: 'UTC',
    enabled: true,
    params: { version },
    run: { kind: 'job', ref },
  };
}

function taskStore(): TaskStoreLike {
  return {
    createTask: () => ({ id: `scheduled-${Math.random()}` }) as never,
    updateTask: () => ({ id: 'scheduled' }) as never,
  };
}

describe('schedule reload health generations', () => {
  let root: string | undefined;
  let db: Database.Database | undefined;
  let engine: ReturnType<typeof createScheduleEngine> | undefined;
  const releaseHeld: Array<() => void> = [];

  afterEach(async () => {
    for (const release of releaseHeld.splice(0)) release();
    try {
      await engine?.stop();
    } finally {
      db?.close();
      db = undefined;
      engine = undefined;
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  function setup(definition: ScheduleYaml, now: () => number) {
    root = mkdtempSync(join('/tmp', 'raven-schedule-health-'));
    db = new Database(join(root, 'schedule.db'));
    db.exec(readFileSync(initialSchema, 'utf8'));
    const jobs = createJobRegistry();
    engine = createScheduleEngine({
      schedules: [definition],
      jobRegistry: jobs,
      taskStore: taskStore(),
      timezone: 'UTC',
      scheduleFireLog: createScheduleFireLog(db),
      now,
    });
    return { jobs, database: db };
  }

  it('ignores an old completion after material reload and accepts current generation fire', async () => {
    const realNow = Date.now();
    let nowMs = realNow - 10 * MINUTE_MS;
    const cron = recentScheduleCron(realNow);
    const old = schedule(cron, 'old-job', 1);
    const oldStarted = deferred<boolean>();
    const oldResult = deferred<{ summary: string }>();
    releaseHeld.push(() => oldResult.resolve({ summary: 'old generation completed' }));
    const { jobs, database } = setup(old, () => nowMs);
    jobs.register('old-job', async () => {
      oldStarted.resolve(true);
      return oldResult.promise;
    });
    jobs.register('new-job', async () => ({ summary: 'new generation completed' }));
    engine!.start();
    const oldActivation = engine!.getHealth()[0].activationId;
    expect(oldActivation).not.toBeNull();
    const oldFire = engine!.runNow(old.name);
    await oldStarted.promise;

    // A materially changed definition receives a new activation identity. The
    // old invocation remains in flight but is no longer current health state.
    engine!.reload([schedule(cron, 'new-job', 2)]);
    const newActivation = engine!.getHealth()[0].activationId;
    expect(newActivation).not.toBe(oldActivation);
    nowMs = realNow;
    expect(checkScheduleHealth(database, engine!.getHealth(), nowMs)).toEqual([
      'Schedule "reloadable-job" has not fired for its latest expected run',
    ]);

    oldResult.resolve({ summary: 'old generation completed' });
    await oldFire;
    expect(
      database
        .prepare('SELECT activation_id, detail FROM schedule_fires ORDER BY rowid DESC LIMIT 1')
        .get(),
    ).toMatchObject({ activation_id: oldActivation, detail: 'old generation completed' });
    expect(checkScheduleHealth(database, engine!.getHealth(), nowMs)).toEqual([
      'Schedule "reloadable-job" has not fired for its latest expected run',
    ]);

    await engine!.runNow(old.name);
    expect(
      database
        .prepare('SELECT activation_id, detail FROM schedule_fires ORDER BY rowid DESC LIMIT 1')
        .get(),
    ).toMatchObject({ activation_id: newActivation, detail: 'new generation completed' });
    expect(checkScheduleHealth(database, engine!.getHealth(), nowMs)).toEqual([]);
  });

  it('preserves activation identity and a healthy fire log across unchanged reload', async () => {
    const realNow = Date.now();
    let nowMs = realNow - 10 * MINUTE_MS;
    const definition = schedule(recentScheduleCron(realNow), 'stable-job', 1);
    const { jobs, database } = setup(definition, () => nowMs);
    jobs.register('stable-job', async () => ({ summary: 'stable generation completed' }));
    engine!.start();
    const before = engine!.getHealth()[0];
    await engine!.runNow(definition.name);
    nowMs = realNow;
    expect(checkScheduleHealth(database, engine!.getHealth(), nowMs)).toEqual([]);

    engine!.reload([{ ...definition, params: { version: 1 } }]);
    const after = engine!.getHealth()[0];
    expect(after.activationId).toBe(before.activationId);
    expect(after.activatedAt).toBe(before.activatedAt);
    expect(checkScheduleHealth(database, engine!.getHealth(), nowMs)).toEqual([]);
  });
});
