import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase } from '../db/database.ts';
import {
  checkStuckTrees,
  checkServicesLoaded,
  checkScheduleFires,
  checkErrorRate,
  checkStaleApprovals,
  checkDataDirWritable,
  checkDbIntegrity,
  checkCanary,
  countEnvEligibleServices,
  runSelfTestJob,
  getSelfTestStatus,
  type SelfTestJobDeps,
} from '../services/system/self-test.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { PendingApproval } from '../permission-engine/pending-approvals.ts';

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

function insertTree(
  db: Database.Database,
  opts: {
    id: string;
    status: string;
    updatedAt: string;
    scheduleId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO task_trees (id, project_id, schedule_id, status, plan, created_at, updated_at)
     VALUES (?, NULL, ?, ?, NULL, ?, ?)`,
  ).run(opts.id, opts.scheduleId ?? null, opts.status, opts.updatedAt, opts.updatedAt);
}

describe('self-test invariants (pure functions)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-self-test-'));
    db = initDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('checkStuckTrees', () => {
    it('flags a tree stuck running for over 24h', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'stuck-1',
        status: 'running',
        updatedAt: new Date(now - 25 * MS_PER_HOUR).toISOString(),
      });

      const violations = checkStuckTrees(db, now);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('stuck-1');
    });

    it('does not flag a recently-updated running tree', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'fresh-1',
        status: 'running',
        updatedAt: new Date(now - MS_PER_HOUR).toISOString(),
      });

      expect(checkStuckTrees(db, now)).toEqual([]);
    });

    it('does not flag a completed tree regardless of age', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'done-1',
        status: 'completed',
        updatedAt: new Date(now - 48 * MS_PER_HOUR).toISOString(),
      });

      expect(checkStuckTrees(db, now)).toEqual([]);
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
    it('flags the most recent canary tree if it is not completed and past the grace period', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'canary-1',
        status: 'running',
        updatedAt: new Date(now - 2 * MS_PER_HOUR).toISOString(),
        scheduleId: 'weekly-canary',
      });

      expect(checkCanary(db, now)).toHaveLength(1);
    });

    it('does not flag a completed canary tree', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'canary-2',
        status: 'completed',
        updatedAt: new Date(now - 2 * MS_PER_HOUR).toISOString(),
        scheduleId: 'weekly-canary',
      });

      expect(checkCanary(db, now)).toEqual([]);
    });

    it('gives a freshly-fired canary tree grace before judging it', () => {
      const now = Date.now();
      insertTree(db, {
        id: 'canary-3',
        status: 'running',
        updatedAt: new Date(now).toISOString(),
        scheduleId: 'weekly-canary',
      });

      expect(checkCanary(db, now)).toEqual([]);
    });

    it('does not flag anything when the canary has never fired', () => {
      expect(checkCanary(db, Date.now())).toEqual([]);
    });
  });
});

describe('runSelfTestJob + getSelfTestStatus', () => {
  let dir: string;
  let db: Database.Database;
  let dbInterface: DatabaseInterface;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-self-test-job-'));
    db = initDatabase(join(dir, 'test.db'));
    dbInterface = makeDbInterface(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<SelfTestJobDeps> = {}): SelfTestJobDeps {
    return {
      db,
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

  it('persists a violation and emits one batched notification for a stuck tree', async () => {
    const now = Date.now();
    insertTree(db, {
      id: 'stuck-job-1',
      status: 'running',
      updatedAt: new Date(now - 25 * MS_PER_HOUR).toISOString(),
    });

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
});

describe('getSelfTestStatus', () => {
  it('degrades to an ok/never-run status when nothing has been persisted yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raven-self-test-status-'));
    try {
      const db = initDatabase(join(dir, 'test.db'));
      const status = getSelfTestStatus(makeDbInterface(db));
      expect(status).toEqual({ lastRun: null, ok: true, violations: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
