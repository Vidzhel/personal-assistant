import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { closeDatabase, initDatabase } from '../db/database.ts';
import {
  checkScheduleHealth,
  runSelfTestChecks,
  type SelfTestDeps,
} from '../services/system/self-test.ts';
import type { ScheduleHealth } from '../scheduler/schedule-engine.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function health(overrides: Partial<ScheduleHealth> = {}): ScheduleHealth {
  return {
    name: 'hourly-check',
    cron: '* * * * *',
    timezone: 'UTC',
    kind: 'job',
    ref: 'hourly-check',
    enabled: true,
    registered: true,
    nextRun: '2026-01-01T12:11:00.000Z',
    active: true,
    activatedAt: Date.parse('2026-01-01T12:00:00.000Z'),
    activationId: 'activation-1',
    inFlightSince: null,
    ...overrides,
  };
}

function recordFire(
  db: Database.Database,
  scheduleName: string,
  firedAt: string,
  status: string,
  activationId = 'activation-1',
): void {
  db.prepare(
    `INSERT INTO schedule_fires
       (id, schedule_name, fired_at, activation_id, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(`${scheduleName}-${firedAt}-${status}`, scheduleName, firedAt, activationId, status);
}

describe('self-test schedule health', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-self-test-schedule-health-'));
    db = initDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an enabled active schedule that missed its latest expected run', () => {
    const now = Date.parse('2026-01-01T12:06:30.000Z');

    expect(checkScheduleHealth(db, [health()], now)).toEqual([
      'Schedule "hourly-check" has not fired for its latest expected run',
    ]);
  });

  it('accepts a terminal fire after activation and reports a current failed fire', () => {
    const now = Date.parse('2026-01-01T12:06:30.000Z');
    recordFire(db, 'hourly-check', '2026-01-01T12:06:00.000Z', 'completed');
    expect(checkScheduleHealth(db, [health()], now)).toEqual([]);

    recordFire(db, 'hourly-check', '2026-01-01T12:06:20.000Z', 'failed');
    expect(checkScheduleHealth(db, [health()], now)).toEqual([
      'Schedule "hourly-check" last fire ended in status "failed"',
    ]);
  });

  it('does not judge a window that predates activation or a historical failure row', () => {
    const activatedAt = Date.parse('2026-01-01T12:05:30.000Z');
    const schedule = health({ cron: '0 * * * *', activatedAt });
    const now = Date.parse('2026-01-01T12:10:30.000Z');
    recordFire(db, 'hourly-check', '2026-01-01T12:05:00.000Z', 'failed', 'activation-old');
    expect(checkScheduleHealth(db, [schedule], now)).toEqual([]);

    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-01-01T13:01:30.000Z'))).toEqual([
      'Schedule "hourly-check" has not fired for its latest expected run',
    ]);
  });

  it('reports a current manual failure during activation grace', () => {
    const activatedAt = Date.parse('2026-01-01T12:06:00.000Z');
    recordFire(db, 'hourly-check', '2026-01-01T12:06:10.000Z', 'failed');

    expect(
      checkScheduleHealth(db, [health({ activatedAt })], Date.parse('2026-01-01T12:06:30.000Z')),
    ).toEqual(['Schedule "hourly-check" last fire ended in status "failed"']);
  });

  it('ignores disabled and removed historical rows in the integrated self test', () => {
    recordFire(db, 'disabled-old', '2026-01-01T12:06:00.000Z', 'failed');
    recordFire(db, 'removed-old', '2026-01-01T12:06:00.000Z', 'blocked');

    const deps = {
      db,
      executionEngine: { queryTrees: () => [] },
      executionLogger: {
        getTaskStats: () => ({
          total1h: 0,
          succeeded1h: 0,
          failed1h: 0,
          avgDurationMs: null,
          lastTaskAt: null,
        }),
      } as unknown as SelfTestDeps['executionLogger'],
      pendingApprovals: { query: () => [] } as unknown as SelfTestDeps['pendingApprovals'],
      serviceRunner: { getRunningCount: () => Number.MAX_SAFE_INTEGER },
      dataDir: dir,
      scheduleEngine: {
        list: () => [{ name: 'disabled-old', enabled: false }],
        getHealth: () => [],
      },
    } satisfies SelfTestDeps;

    expect(
      runSelfTestChecks(deps, Date.parse('2026-01-01T12:06:30.000Z')).violations,
    ).not.toContain(expect.stringContaining('disabled-old'));
    expect(
      runSelfTestChecks(deps, Date.parse('2026-01-01T12:06:30.000Z')).violations,
    ).not.toContain(expect.stringContaining('removed-old'));
  });

  it('reports registration failures, exempts recent work, and reports stuck work', () => {
    const now = Date.parse('2026-01-01T12:06:30.000Z');
    expect(checkScheduleHealth(db, [health({ registered: false })], now)).toEqual([
      'Schedule "hourly-check" is enabled but has no active registered schedule',
    ]);
    expect(checkScheduleHealth(db, [health({ inFlightSince: now - MINUTE_MS })], now)).toEqual([]);
    expect(checkScheduleHealth(db, [health({ inFlightSince: now - HOUR_MS - 1 })], now)).toEqual([
      'Schedule "hourly-check" has an invocation stuck for over 1h',
    ]);
  });

  it('excludes disabled entries even if their snapshot still has an activation', () => {
    recordFire(db, 'hourly-check', '2026-01-01T12:06:00.000Z', 'failed');
    expect(
      checkScheduleHealth(db, [health({ enabled: false })], Date.parse('2026-01-01T12:10:00Z')),
    ).toEqual([]);
  });

  it('gives a current retry time to finish before repeating its prior failure', () => {
    const now = Date.parse('2026-01-01T12:10:00Z');
    recordFire(db, 'hourly-check', '2026-01-01T12:06:00.000Z', 'failed');
    expect(checkScheduleHealth(db, [health({ inFlightSince: now - MINUTE_MS })], now)).toEqual([]);
    expect(checkScheduleHealth(db, [health()], now)).toEqual([
      'Schedule "hourly-check" last fire ended in status "failed"',
    ]);
  });

  it('allows completion grace at a due boundary and reports an older successful fire afterward', () => {
    const schedule = health({ cron: '0 * * * *', activatedAt: Date.parse('2026-01-01T11:00:00Z') });
    recordFire(db, 'hourly-check', '2026-01-01T12:00:10.000Z', 'completed');
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-01-01T13:00:59Z'))).toEqual([]);
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-01-01T13:01:01Z'))).toEqual([
      'Schedule "hourly-check" has not fired for its latest expected run',
    ]);
  });

  it('uses Croner schedule timezone through the DST fall-back hour', () => {
    const now = Date.parse('2026-11-01T07:00:30.000Z');
    const dstSchedule = health({
      name: 'new-york-dst',
      cron: '30 1 * * *',
      timezone: 'America/New_York',
      activatedAt: Date.parse('2026-10-31T00:00:00.000Z'),
    });
    // Croner runs an overlap once at the first occurrence (05:30Z), matching
    // nextRuns(). Health must not expect a second fire at 06:30Z.
    recordFire(db, 'new-york-dst', '2026-10-31T05:30:00.000Z', 'completed');
    expect(checkScheduleHealth(db, [dstSchedule], now)).toEqual([
      'Schedule "new-york-dst" has not fired for its latest expected run',
    ]);
    recordFire(db, 'new-york-dst', '2026-11-01T05:30:00.000Z', 'completed');

    expect(checkScheduleHealth(db, [dstSchedule], now)).toEqual([]);
  });

  it('matches the installed Croner spring-gap dispatch time', () => {
    const schedule = health({
      name: 'spring-gap',
      cron: '30 2 * * *',
      timezone: 'America/New_York',
      activatedAt: Date.parse('2026-03-06T00:00:00Z'),
    });
    // Installed Croner 10.0.1 nextRuns/previousRuns both move this missing
    // 02:30 occurrence to 03:30 local (07:30Z); health must match dispatch.
    recordFire(db, 'spring-gap', '2026-03-07T07:30:00.000Z', 'completed');
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-03-08T07:30:30Z'))).toEqual([]);
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-03-08T07:31:30Z'))).toEqual([
      'Schedule "spring-gap" has not fired for its latest expected run',
    ]);
    recordFire(db, 'spring-gap', '2026-03-08T07:30:00.000Z', 'completed');
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-03-08T07:31:30Z'))).toEqual([]);
    expect(checkScheduleHealth(db, [schedule], Date.parse('2026-03-09T07:00:00Z'))).toEqual([
      'Schedule "spring-gap" has not fired for its latest expected run',
    ]);
  });
});
