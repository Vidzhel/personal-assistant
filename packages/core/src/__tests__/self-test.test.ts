import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/database.ts';
import {
  checkStuckTrees,
  checkFailedTrees,
  checkServicesLoaded,
  checkScheduleFires,
  checkErrorRate,
  checkStaleApprovals,
  checkDataDirWritable,
  checkDbIntegrity,
  checkCanary,
  countEnvEligibleServices,
  runSelfTestJob,
  runSelfTestChecks,
  getSelfTestStatus,
  type SelfTestJobDeps,
} from '../services/system/self-test.ts';
import type { DatabaseInterface, TaskTree } from '@raven/shared';
import type { PendingApproval } from '../permission-engine/pending-approvals.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

const MS_PER_HOUR = 3_600_000;

function makeDbInterface(db: Database.Database): DatabaseInterface {
  return {
    run: (sql: string, ...params: unknown[]) => {
      db.prepare(sql).run(...params);
    },
    get: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  };
}

function makeTree(opts: {
  id: string;
  status: TaskTree['status'];
  updatedAt: string;
  scheduleId?: string;
  plan?: string;
}): TaskTree {
  return {
    id: opts.id,
    status: opts.status,
    tasks: new Map(),
    scheduleId: opts.scheduleId,
    plan: opts.plan,
    createdAt: opts.updatedAt,
    updatedAt: opts.updatedAt,
  };
}

function treeEngine(trees: TaskTree[]) {
  return { queryTrees: () => trees };
}

describe('self-test invariants (pure functions)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-self-test-'));
    db = initDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('checkStuckTrees', () => {
    it('flags a tree stuck running for over 24h', () => {
      const now = Date.now();
      const trees = Array.from({ length: 60 }, (_, index) =>
        makeTree({
          id: index === 0 ? 'stuck-1' : `fresh-${String(index)}`,
          status: 'running',
          updatedAt: new Date(now - (index === 0 ? 25 : 1) * MS_PER_HOUR).toISOString(),
        }),
      );

      const violations = checkStuckTrees(treeEngine(trees), now);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('stuck-1');
    });

    it('does not flag a recently-updated running tree', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'fresh-1',
          status: 'running',
          updatedAt: new Date(now - MS_PER_HOUR).toISOString(),
        }),
      ];

      expect(checkStuckTrees(treeEngine(trees), now)).toEqual([]);
    });

    it('does not flag a completed tree regardless of age', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'done-1',
          status: 'completed',
          updatedAt: new Date(now - 48 * MS_PER_HOUR).toISOString(),
        }),
      ];

      expect(checkStuckTrees(treeEngine(trees), now)).toEqual([]);
    });
  });

  describe('checkFailedTrees', () => {
    it('flags a tree that failed within the last 24h, naming it', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'failed-1',
          status: 'failed',
          updatedAt: new Date(now - MS_PER_HOUR).toISOString(),
          plan: 'Run system maintenance',
        }),
      ];

      const violations = checkFailedTrees(treeEngine(trees), now);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('Run system maintenance');
      expect(violations[0]).toContain('failed-1');
    });

    it('ignores a failed tree older than 24h', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'failed-old',
          status: 'failed',
          updatedAt: new Date(now - 25 * MS_PER_HOUR).toISOString(),
        }),
      ];

      expect(checkFailedTrees(treeEngine(trees), now)).toEqual([]);
    });

    it('ignores a running or completed tree', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'running-1',
          status: 'running',
          updatedAt: new Date(now).toISOString(),
        }),
        makeTree({
          id: 'completed-1',
          status: 'completed',
          updatedAt: new Date(now).toISOString(),
        }),
      ];

      expect(checkFailedTrees(treeEngine(trees), now)).toEqual([]);
    });
  });

  describe('checkServicesLoaded', () => {
    it('flags when loaded is below env-eligible', () => {
      expect(checkServicesLoaded(1, 3)).toHaveLength(1);
    });

    it('passes when loaded matches env-eligible', () => {
      expect(checkServicesLoaded(3, 3)).toEqual([]);
    });
  });

  describe('checkScheduleFires', () => {
    it('flags a schedule whose most recent fire was blocked', () => {
      db.prepare(
        `INSERT INTO schedule_fires (id, schedule_name, fired_at, status) VALUES (?, ?, ?, ?)`,
      ).run('f1', 'task-archival', new Date(Date.now() - MS_PER_HOUR).toISOString(), 'blocked');

      const violations = checkScheduleFires(db);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('task-archival');
    });

    it('ignores a schedule whose most recent fire completed, even with an older blocked fire', () => {
      db.prepare(
        `INSERT INTO schedule_fires (id, schedule_name, fired_at, status) VALUES (?, ?, ?, ?)`,
      ).run('f1', 'task-archival', new Date(Date.now() - 2 * MS_PER_HOUR).toISOString(), 'blocked');
      db.prepare(
        `INSERT INTO schedule_fires (id, schedule_name, fired_at, status) VALUES (?, ?, ?, ?)`,
      ).run('f2', 'task-archival', new Date(Date.now() - MS_PER_HOUR).toISOString(), 'completed');

      expect(checkScheduleFires(db)).toEqual([]);
    });

    it('passes a template-kind schedule whose last status is "fired"', () => {
      db.prepare(
        `INSERT INTO schedule_fires (id, schedule_name, fired_at, status) VALUES (?, ?, ?, ?)`,
      ).run('f1', 'morning-digest', new Date().toISOString(), 'fired');

      expect(checkScheduleFires(db)).toEqual([]);
    });
  });

  describe('checkErrorRate', () => {
    it('flags when the failure rate meets the threshold', () => {
      const violations = checkErrorRate(
        { total1h: 10, succeeded1h: 4, failed1h: 6, avgDurationMs: null, lastTaskAt: null },
        0.5,
      );
      expect(violations).toHaveLength(1);
    });

    it('passes when the failure rate is below the threshold', () => {
      const violations = checkErrorRate(
        { total1h: 10, succeeded1h: 9, failed1h: 1, avgDurationMs: null, lastTaskAt: null },
        0.5,
      );
      expect(violations).toEqual([]);
    });

    it('passes trivially when there were no tasks at all', () => {
      const violations = checkErrorRate(
        { total1h: 0, succeeded1h: 0, failed1h: 0, avgDurationMs: null, lastTaskAt: null },
        0.5,
      );
      expect(violations).toEqual([]);
    });
  });

  describe('checkStaleApprovals', () => {
    function approval(overrides: Partial<PendingApproval>): PendingApproval {
      return {
        id: 'a1',
        actionName: 'gmail.send',
        skillName: 'gmail',
        requestedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('flags an approval older than 48h', () => {
      const old = approval({ requestedAt: new Date(Date.now() - 50 * MS_PER_HOUR).toISOString() });
      expect(checkStaleApprovals([old], Date.now())).toHaveLength(1);
    });

    it('does not flag a recent approval', () => {
      const fresh = approval({ requestedAt: new Date(Date.now() - MS_PER_HOUR).toISOString() });
      expect(checkStaleApprovals([fresh], Date.now())).toEqual([]);
    });
  });

  describe('checkDataDirWritable', () => {
    it('passes for a writable directory', () => {
      expect(checkDataDirWritable(dir)).toEqual([]);
    });

    it('flags an unwritable (nonexistent) directory', () => {
      const violations = checkDataDirWritable(join(dir, 'does', 'not', 'exist'));
      expect(violations).toHaveLength(1);
    });
  });

  describe('checkDbIntegrity', () => {
    it('passes on a freshly-migrated database', () => {
      expect(checkDbIntegrity(db)).toEqual([]);
    });
  });

  describe('checkCanary', () => {
    const HOURS_PER_DAY = 24;
    const CANARY_STALE_DAYS = 8;

    it('flags the most recent canary tree if it is not completed and past the grace period', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'canary-1',
          status: 'running',
          updatedAt: new Date(now - 2 * MS_PER_HOUR).toISOString(),
          scheduleId: 'weekly-canary',
        }),
      ];

      expect(checkCanary(treeEngine(trees), now, true)).toHaveLength(1);
    });

    it('does not flag a completed canary tree', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'canary-2',
          status: 'completed',
          updatedAt: new Date(now - 2 * MS_PER_HOUR).toISOString(),
          scheduleId: 'weekly-canary',
        }),
      ];

      expect(checkCanary(treeEngine(trees), now, true)).toEqual([]);
    });

    it('gives a freshly-fired canary tree grace before judging it', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'canary-3',
          status: 'running',
          updatedAt: new Date(now).toISOString(),
          scheduleId: 'weekly-canary',
        }),
      ];

      expect(checkCanary(treeEngine(trees), now, true)).toEqual([]);
    });

    it('flags absence when the canary schedule is enabled', () => {
      const engine = treeEngine([]);
      expect(checkCanary(engine, Date.now(), true)).toHaveLength(1);
      expect(checkCanary(engine, Date.now(), true)[0]).toContain('never fired');
    });

    it('does not flag absence when the canary schedule is disabled', () => {
      expect(checkCanary(treeEngine([]), Date.now(), false)).toEqual([]);
    });

    it('flags a canary tree older than 8 days while the schedule is enabled', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'canary-stale',
          status: 'completed',
          updatedAt: new Date(
            now - (CANARY_STALE_DAYS + 1) * HOURS_PER_DAY * MS_PER_HOUR,
          ).toISOString(),
          scheduleId: 'weekly-canary',
        }),
      ];

      const violations = checkCanary(treeEngine(trees), now, true);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('canary-stale');
    });

    it('does not flag a stale canary tree when the schedule is disabled', () => {
      const now = Date.now();
      const trees = [
        makeTree({
          id: 'canary-stale-disabled',
          status: 'completed',
          updatedAt: new Date(
            now - (CANARY_STALE_DAYS + 1) * HOURS_PER_DAY * MS_PER_HOUR,
          ).toISOString(),
          scheduleId: 'weekly-canary',
        }),
      ];

      expect(checkCanary(treeEngine(trees), now, false)).toEqual([]);
    });
  });
});

describe('runSelfTestJob + getSelfTestStatus', () => {
  let dir: string;
  let db: Database.Database;
  let dbInterface: DatabaseInterface;
  let trees: TaskTree[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-self-test-job-'));
    db = initDatabase(join(dir, 'test.db'));
    dbInterface = makeDbInterface(db);
    trees = [];
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<SelfTestJobDeps> = {}): SelfTestJobDeps {
    return {
      db,
      executionEngine: treeEngine(trees),
      executionLogger: {
        getTaskStats: vi.fn().mockReturnValue({
          total1h: 0,
          succeeded1h: 0,
          failed1h: 0,
          avgDurationMs: null,
          lastTaskAt: null,
        }),
      } as any,
      pendingApprovals: { query: vi.fn().mockReturnValue([]) } as any,
      // Matches countEnvEligibleServices() so the "healthy" baseline doesn't
      // trip checkServicesLoaded — several real ServiceDefinitions declare
      // requiresEnv: [] and are therefore always "env-eligible".
      serviceRunner: { getRunningCount: () => countEnvEligibleServices() },
      dataDir: dir,
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any,
      ...overrides,
    };
  }

  it('persists an ok result and emits no notification when everything is healthy', async () => {
    const deps = makeDeps();
    const result = await runSelfTestJob(deps);

    expect(result.summary).toBe('Self-test passed');
    expect(deps.eventBus.emit).not.toHaveBeenCalled();

    const status = getSelfTestStatus(dbInterface);
    expect(status.ok).toBe(true);
    expect(status.violations).toEqual([]);
    expect(status.lastRun).not.toBeNull();
  });

  it('uses current definition diagnostics and clears corrected violations', async () => {
    const diagnostics: DefinitionDiagnostic[] = [
      {
        source: 'schedule',
        path: 'projects/system/schedules/broken.yaml',
        code: 'invalid-cron',
        message: 'Schedule expression is invalid',
        severity: 'error',
      },
    ];
    const deps = makeDeps({
      getDefinitionDiagnostics: () => diagnostics,
    });

    expect(runSelfTestChecks(deps).violations).toEqual([
      '[definition] schedule projects/system/schedules/broken.yaml (invalid-cron): Schedule expression is invalid',
    ]);
    await runSelfTestJob(deps);
    diagnostics.length = 0;
    await runSelfTestJob(deps);

    expect(getSelfTestStatus(dbInterface)).toMatchObject({ ok: true, violations: [] });
  });

  it('persists a violation and emits one batched notification for a stuck tree', async () => {
    const now = Date.now();
    trees.push(
      makeTree({
        id: 'stuck-job-1',
        status: 'running',
        updatedAt: new Date(now - 25 * MS_PER_HOUR).toISOString(),
      }),
    );

    const deps = makeDeps();
    const result = await runSelfTestJob(deps);

    expect(result.summary).toContain('violation');
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);
    const emitted = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(emitted.type).toBe('notification');
    expect(emitted.payload.channel).toBe('telegram');
    expect(emitted.payload.body).toContain('stuck-job-1');

    const status = getSelfTestStatus(dbInterface);
    expect(status.ok).toBe(false);
    expect(status.violations.some((v) => v.includes('stuck-job-1'))).toBe(true);
  });

  it('does not re-notify a standing violation on a second run, and dedupes new from standing', async () => {
    const now = Date.now();
    trees.push(
      makeTree({
        id: 'standing-tree',
        status: 'running',
        updatedAt: new Date(now - 25 * MS_PER_HOUR).toISOString(),
      }),
    );

    const deps = makeDeps();
    await runSelfTestJob(deps);
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);

    // Second run: same standing violation, nothing new — no re-notification.
    (deps.eventBus.emit as ReturnType<typeof vi.fn>).mockClear();
    await runSelfTestJob(deps);
    expect(deps.eventBus.emit).not.toHaveBeenCalled();

    // Third run: a genuinely new violation joins the still-standing one —
    // notify, but only call out the new one plus a "still failing" count.
    trees.push(
      makeTree({
        id: 'new-tree',
        status: 'running',
        updatedAt: new Date(now - 26 * MS_PER_HOUR).toISOString(),
      }),
    );
    await runSelfTestJob(deps);
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);
    const emitted = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(emitted.payload.body).toContain('new-tree');
    expect(emitted.payload.body).not.toContain('standing-tree');
    expect(emitted.payload.body).toContain('still failing: 1');
  });
});

describe('getSelfTestStatus', () => {
  it('degrades to an ok/never-run status when nothing has been persisted yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raven-self-test-status-'));
    try {
      const db = initDatabase(join(dir, 'test.db'));
      const status = getSelfTestStatus(makeDbInterface(db));
      expect(status).toEqual({ lastRun: null, ok: true, violations: [] });
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a violation when a failed run has unreadable persisted violations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raven-self-test-status-'));
    try {
      const db = initDatabase(join(dir, 'test.db'));
      db.prepare(
        `INSERT INTO self_test_results (id, ran_at, ok, violations_json) VALUES (?, ?, ?, ?)`,
      ).run('r1', new Date().toISOString(), 0, 'not valid json');

      const status = getSelfTestStatus(makeDbInterface(db));
      expect(status.ok).toBe(false);
      expect(status.violations).toHaveLength(1);
      expect(status.violations[0]).toMatch(/unreadable/i);
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
