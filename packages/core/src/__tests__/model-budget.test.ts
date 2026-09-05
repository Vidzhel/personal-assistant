import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelBudget } from '../agent-manager/model-budget.ts';

const initialMigration = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../migrations/001-initial-schema.sql',
);

describe('model budget ledger', () => {
  const resources: Array<{ dir: string; db: Database.Database }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.db.close();
      rmSync(resource.dir, { recursive: true, force: true });
    }
  });

  function open() {
    const dir = mkdtempSync(join(tmpdir(), 'raven-budget-'));
    const db = new Database(join(dir, 'budget.db'));
    db.exec(readFileSync(initialMigration, 'utf8'));
    resources.push({ dir, db });
    return db;
  }

  function openSecondConnection(first: Database.Database): Database.Database {
    const db = new Database(first.name);
    resources.push({ dir: dirname(first.name), db });
    return db;
  }

  it('reserves with headroom and settles known cost idempotently', () => {
    const db = open();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'UTC',
      now: () => Date.UTC(2026, 0, 2, 12),
    });
    const lease = budget.reserve({ taskId: 't1', model: 'claude' });
    expect(lease?.maxBudgetUsd).toBe(5);
    expect(budget.getSummary()).toMatchObject({ reservedUsd: 5, remainingUsd: 5 });
    budget.settle(lease!.id, { costUsd: 1.25 });
    budget.settle(lease!.id, { costUsd: 9 });
    expect(budget.getSummary()).toMatchObject({
      knownUsd: 1.25,
      reservedUsd: 0,
      remainingUsd: 8.75,
    });
  });

  it('uses unknown reservation cost and releases pre-start work', () => {
    const db = open();
    let now = Date.UTC(2026, 0, 2, 12);
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 3,
      timeZone: 'UTC',
      now: () => now,
    });
    const unknown = budget.reserve({ taskId: 't1', model: 'claude' })!;
    budget.settle(unknown.id, { reason: 'cancelled after dispatch' });
    const released = budget.reserve({ taskId: 't2', model: 'claude' })!;
    budget.releaseBeforeStart(released.id);
    expect(budget.getSummary()).toMatchObject({
      unknownUsd: 2.5,
      reservedUsd: 0,
      remainingUsd: 7.5,
    });
    now += 24 * 60 * 60 * 1000;
    expect(budget.getSummary()).toMatchObject({ day: '2026-01-03', knownUsd: 0, unknownUsd: 0 });
  });

  it('recovers reserved rows as unknown without moving their admission day', () => {
    const db = open();
    let now = Date.UTC(2026, 0, 2, 23, 59);
    const first = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'UTC',
      now: () => now,
    });
    const lease = first.reserve({ taskId: 't1', model: 'claude' })!;
    now += 2 * 60 * 60 * 1000;
    const second = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'UTC',
      now: () => now,
    });
    second.recoverInterrupted();
    expect(second.getSummary()).toMatchObject({ day: '2026-01-03', unknownUsd: 0 });
    expect(
      db
        .prepare('SELECT status, bucket_day FROM model_budget_leases WHERE id = ?')
        .get(lease.id) as { status: string; bucket_day: string },
    ).toEqual({ status: 'unknown', bucket_day: '2026-01-02' });
  });

  it('rejects exhausted and invalid configuration', () => {
    const db = open();
    const budget = createModelBudget({ db, dailyLimitUsd: 0, maxConcurrent: 1, timeZone: 'UTC' });
    expect(budget.reserve({ taskId: 't1', model: 'claude' })).toBeUndefined();
    expect(() =>
      createModelBudget({ db, dailyLimitUsd: -1, maxConcurrent: 1, timeZone: 'UTC' }),
    ).toThrow();
    expect(() =>
      createModelBudget({ db, dailyLimitUsd: 1, maxConcurrent: 0, timeZone: 'UTC' }),
    ).toThrow();
    expect(() =>
      createModelBudget({ db, dailyLimitUsd: 1, maxConcurrent: 1, timeZone: 'Not/AZone' }),
    ).toThrow();
  });

  it('coordinates reservations across two SQLite connections with bounded totals', () => {
    const first = open();
    const second = openSecondConnection(first);
    const options = {
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'UTC',
      now: () => Date.UTC(2026, 0, 2, 12),
    };
    const firstBudget = createModelBudget({ db: first, ...options });
    const secondBudget = createModelBudget({ db: second, ...options });
    const firstLease = firstBudget.reserve({ taskId: 'connection-a', model: 'claude' })!;
    const secondLease = secondBudget.reserve({ taskId: 'connection-b', model: 'claude' })!;
    expect(firstLease.maxBudgetUsd).toBe(5);
    expect(secondLease.maxBudgetUsd).toBe(2.5);
    const row = first
      .prepare(
        'SELECT SUM(reservation_micro_usd) AS total FROM model_budget_leases WHERE bucket_day = ?',
      )
      .get('2026-01-02') as { total: number };
    expect(row.total).toBe(7_500_000);
    expect(secondBudget.getSummary().reservedUsd).toBe(7.5);
  });

  it('records an actual overshoot and then rejects further admission', () => {
    const db = open();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 2,
      maxConcurrent: 1,
      timeZone: 'UTC',
      now: () => Date.UTC(2026, 0, 2, 12),
    });
    const lease = budget.reserve({ taskId: 'overshoot', model: 'claude' })!;
    expect(lease.maxBudgetUsd).toBe(1);
    budget.settle(lease.id, { costUsd: 3, reason: 'nested agents exceeded estimate' });
    expect(budget.getSummary()).toMatchObject({ knownUsd: 3, remainingUsd: 0 });
    expect(budget.reserve({ taskId: 'after-overshoot', model: 'claude' })).toBeUndefined();
    expect(
      db
        .prepare('SELECT actual_micro_usd, status FROM model_budget_leases WHERE id = ?')
        .get(lease.id) as {
        actual_micro_usd: number;
        status: string;
      },
    ).toEqual({ actual_micro_usd: 3_000_000, status: 'known' });
  });

  it('never refunds known or unknown terminal rows on repeated terminal operations', () => {
    const db = open();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 3,
      timeZone: 'UTC',
      now: () => Date.UTC(2026, 0, 2, 12),
    });
    const known = budget.reserve({ taskId: 'known', model: 'claude' })!;
    budget.settle(known.id, { costUsd: 1 });
    budget.settle(known.id, { costUsd: 0 });
    budget.releaseBeforeStart(known.id);
    const unknown = budget.reserve({ taskId: 'unknown', model: 'claude' })!;
    budget.settle(unknown.id);
    budget.settle(unknown.id, { costUsd: 0 });
    budget.releaseBeforeStart(unknown.id);
    const beforeRecovery = budget.getSummary();
    budget.recoverInterrupted();
    expect(budget.getSummary()).toEqual(beforeRecovery);
    expect(beforeRecovery).toMatchObject({ knownUsd: 1, unknownUsd: 2.5 });
  });

  it('distinguishes an explicit zero cost from missing and invalid costs', () => {
    const db = open();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 3,
      timeZone: 'UTC',
      now: () => Date.UTC(2026, 0, 2, 12),
    });
    const zero = budget.reserve({ taskId: 'zero', model: 'claude' })!;
    budget.settle(zero.id, { costUsd: 0 });
    const invalid = budget.reserve({ taskId: 'invalid', model: 'claude' })!;
    expect(() => budget.settle(invalid.id, { costUsd: Number.NaN })).toThrow();
    expect(budget.getSummary().reservedUsd).toBe(invalid.maxBudgetUsd);
    const missing = budget.reserve({ taskId: 'missing', model: 'claude' })!;
    budget.settle(missing.id, { reason: 'provider omitted usage' });
    expect(budget.getSummary()).toMatchObject({ knownUsd: 0, unknownUsd: missing.maxBudgetUsd });
  });

  it('uses local calendar rollover and charges a prior-day lease to its admission day', () => {
    const db = open();
    let now = Date.UTC(2026, 0, 3, 4, 59); // Jan 2 23:59 in New York.
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'America/New_York',
      now: () => now,
    });
    const lease = budget.reserve({ taskId: 'local-day', model: 'claude' })!;
    expect(budget.getSummary().day).toBe('2026-01-02');
    now = Date.UTC(2026, 0, 3, 5, 1);
    expect(budget.getSummary()).toMatchObject({ day: '2026-01-03', knownUsd: 0 });
    budget.settle(lease.id, { costUsd: 0.5 });
    expect(budget.getSummary()).toMatchObject({ day: '2026-01-03', knownUsd: 0 });
    expect(
      db
        .prepare(
          'SELECT bucket_day, time_zone, actual_micro_usd FROM model_budget_leases WHERE id = ?',
        )
        .get(lease.id),
    ).toEqual({
      bucket_day: '2026-01-02',
      time_zone: 'America/New_York',
      actual_micro_usd: 500_000,
    });
  });

  it('keeps the same local date across the New York DST spring transition', () => {
    let now = Date.UTC(2026, 2, 8, 6, 59); // 01:59 EST.
    const db = open();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'America/New_York',
      now: () => now,
    });
    expect(budget.getSummary().day).toBe('2026-03-08');
    now = Date.UTC(2026, 2, 8, 7, 1); // 03:01 EDT.
    expect(budget.getSummary().day).toBe('2026-03-08');
  });
});
