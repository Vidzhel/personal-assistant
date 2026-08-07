import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger, generateId } from '@raven/shared';
import type { DatabaseInterface } from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { ExecutionLogger, TaskStats } from '../../agent-manager/execution-logger.ts';
import type {
  PendingApproval,
  PendingApprovals,
} from '../../permission-engine/pending-approvals.ts';
import { SERVICE_DEFINITIONS } from '../registry.ts';

const log = createLogger('self-test');

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const STUCK_TREE_HOURS = HOURS_PER_DAY;
const STALE_APPROVAL_HOURS = 48;
const CANARY_GRACE_HOURS = 1;
const ONE_DAY_MS = HOURS_PER_DAY * MS_PER_HOUR;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.5;
const PERCENT = 100;
const CANARY_SCHEDULE_NAME = 'weekly-canary';
const WRITE_PROBE_FILE = '.self-test-write-probe';

/** Every deterministic health invariant Raven checks about itself, zero
 * model calls. Each function is pure given its inputs so it can be unit
 * tested against a seeded temp DB without booting the whole system. */

interface StuckTreeRow {
  id: string;
  updated_at: string;
}

export function checkStuckTrees(db: Database.Database, nowMs: number): string[] {
  const cutoffIso = new Date(nowMs - STUCK_TREE_HOURS * MS_PER_HOUR).toISOString();
  const rows = db
    .prepare(`SELECT id, updated_at FROM task_trees WHERE status = 'running' AND updated_at < ?`)
    .all(cutoffIso) as StuckTreeRow[];
  return rows.map(
    (r) =>
      `Task tree ${r.id} has been "running" for over ${STUCK_TREE_HOURS}h (since ${r.updated_at})`,
  );
}

/** Mirrors raven.ts's L16 computation (services whose requiresEnv is fully
 * satisfied) — the env-eligible count `loaded` is meaningfully compared
 * against, see api/routes/health.ts. */
export function countEnvEligibleServices(): number {
  return SERVICE_DEFINITIONS.filter((def) => def.requiresEnv.every((v) => process.env[v])).length;
}

export function checkServicesLoaded(loadedCount: number, envEligibleCount: number): string[] {
  if (loadedCount < envEligibleCount) {
    return [
      `Services loaded (${String(loadedCount)}) is below env-eligible (${String(envEligibleCount)}) — one or more services failed to start`,
    ];
  }
  return [];
}

interface ScheduleFireRow {
  schedule_name: string;
  status: string;
  fired_at: string;
}

/** Every schedule's most recent fire, keyed by name. A schedule that has
 * never fired yet has no row and is silently skipped — nothing to check. */
export function checkScheduleFires(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT schedule_name, status, fired_at FROM schedule_fires sf
       WHERE fired_at = (SELECT MAX(fired_at) FROM schedule_fires WHERE schedule_name = sf.schedule_name)`,
    )
    .all() as ScheduleFireRow[];

  return rows
    .filter((r) => r.status !== 'completed' && r.status !== 'fired')
    .map(
      (r) =>
        `Schedule "${r.schedule_name}" last fire ended in status "${r.status}" (${r.fired_at})`,
    );
}

function resolveErrorRateThreshold(): number {
  const raw = process.env.RAVEN_SELFTEST_ERROR_RATE;
  if (!raw) return DEFAULT_ERROR_RATE_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ERROR_RATE_THRESHOLD;
}

export function checkErrorRate(
  stats: TaskStats,
  threshold = resolveErrorRateThreshold(),
): string[] {
  if (stats.total1h === 0) return [];
  const rate = stats.failed1h / stats.total1h;
  if (rate < threshold) return [];
  return [
    `Agent task error rate over the last 24h is ${String(Math.round(rate * PERCENT))}% ` +
      `(${String(stats.failed1h)}/${String(stats.total1h)}), threshold ${String(Math.round(threshold * PERCENT))}%`,
  ];
}

export function checkStaleApprovals(approvals: PendingApproval[], nowMs: number): string[] {
  const cutoff = nowMs - STALE_APPROVAL_HOURS * MS_PER_HOUR;
  return approvals
    .filter((a) => new Date(a.requestedAt).getTime() < cutoff)
    .map(
      (a) => `Pending approval "${a.actionName}" (${a.id}) has been waiting since ${a.requestedAt}`,
    );
}

export function checkDataDirWritable(dataDir: string): string[] {
  const probePath = join(dataDir, WRITE_PROBE_FILE);
  try {
    writeFileSync(probePath, String(Date.now()));
    unlinkSync(probePath);
    return [];
  } catch (err) {
    return [`data/ directory (${dataDir}) is not writable: ${String(err)}`];
  }
}

export function checkDbIntegrity(db: Database.Database): string[] {
  try {
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, string> | undefined;
    const result = row ? Object.values(row)[0] : undefined;
    if (result !== 'ok') {
      return [`Database integrity check (PRAGMA quick_check) failed: ${String(result)}`];
    }
    return [];
  } catch (err) {
    return [`Database integrity check errored: ${String(err)}`];
  }
}

interface CanaryTreeRow {
  id: string;
  status: string;
  created_at: string;
}

/** The weekly canary fires the morning-digest template with
 * scheduleId="weekly-canary" (see template-scheduler.ts), which stamps
 * task_trees.schedule_id — that's the correlation, no separate bookkeeping
 * needed. Only the most recent canary tree matters; a fresh one (younger
 * than CANARY_GRACE_HOURS) is given time to finish before being judged. */
export function checkCanary(db: Database.Database, nowMs: number): string[] {
  const row = db
    .prepare(
      `SELECT id, status, created_at FROM task_trees WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(CANARY_SCHEDULE_NAME) as CanaryTreeRow | undefined;
  if (!row) return [];

  const ageMs = nowMs - new Date(row.created_at).getTime();
  if (ageMs < CANARY_GRACE_HOURS * MS_PER_HOUR) return [];

  if (row.status !== 'completed') {
    return [
      `Weekly canary tree ${row.id} (fired ${row.created_at}) did not reach "completed" — status is "${row.status}"`,
    ];
  }
  return [];
}

export interface SelfTestDeps {
  db: Database.Database;
  executionLogger: ExecutionLogger;
  pendingApprovals: PendingApprovals;
  serviceRunner: { getRunningCount(): number };
  dataDir: string;
}

export interface SelfTestResult {
  ok: boolean;
  violations: string[];
}

/** Runs every invariant and aggregates the violations. Zero model calls —
 * every check is a DB read, a numeric comparison, or a disk probe. */
export function runSelfTestChecks(deps: SelfTestDeps, nowMs = Date.now()): SelfTestResult {
  const violations = [
    ...checkStuckTrees(deps.db, nowMs),
    ...checkServicesLoaded(deps.serviceRunner.getRunningCount(), countEnvEligibleServices()),
    ...checkScheduleFires(deps.db),
    ...checkErrorRate(deps.executionLogger.getTaskStats(ONE_DAY_MS)),
    ...checkStaleApprovals(deps.pendingApprovals.query(), nowMs),
    ...checkDataDirWritable(deps.dataDir),
    ...checkDbIntegrity(deps.db),
    ...checkCanary(deps.db, nowMs),
  ];
  return { ok: violations.length === 0, violations };
}

function persistResult(db: Database.Database, result: SelfTestResult): void {
  db.prepare(
    `INSERT INTO self_test_results (id, ran_at, ok, violations_json) VALUES (?, ?, ?, ?)`,
  ).run(
    generateId(),
    new Date().toISOString(),
    result.ok ? 1 : 0,
    JSON.stringify(result.violations),
  );
}

function notifyViolations(eventBus: EventBus, result: SelfTestResult): void {
  if (result.ok) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'self-test',
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: `Self-test found ${String(result.violations.length)} issue(s)`,
      body: result.violations.map((v) => `- ${v}`).join('\n'),
      topicName: 'Raven System',
    },
  });
}

export interface SelfTestJobDeps extends SelfTestDeps {
  eventBus: EventBus;
}

/** Scheduled job handler (registered as 'self-test' in core-jobs.ts). One
 * batched notification for the whole run — never one per violation. */
export async function runSelfTestJob(deps: SelfTestJobDeps): Promise<{ summary: string }> {
  const result = runSelfTestChecks(deps);
  persistResult(deps.db, result);
  notifyViolations(deps.eventBus, result);

  const summary = result.ok
    ? 'Self-test passed'
    : `Self-test found ${String(result.violations.length)} violation(s)`;
  log.info(summary);
  return { summary };
}

interface SelfTestResultRow {
  ran_at: string;
  ok: number;
  violations_json: string;
}

export interface SelfTestStatus {
  lastRun: string | null;
  ok: boolean;
  violations: string[];
}

/** Read side for /api/health — the most recent persisted run, degrading to
 * an "ok, never run" status rather than throwing when the table is empty. */
export function getSelfTestStatus(db: DatabaseInterface): SelfTestStatus {
  const row = db.get<SelfTestResultRow>(
    'SELECT ran_at, ok, violations_json FROM self_test_results ORDER BY ran_at DESC LIMIT 1',
  );
  if (!row) return { lastRun: null, ok: true, violations: [] };

  let violations: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.violations_json);
    if (Array.isArray(parsed)) violations = parsed as string[];
  } catch (err) {
    log.warn(`Failed to parse persisted self-test violations: ${String(err)}`);
  }

  return { lastRun: row.ran_at, ok: row.ok === 1, violations };
}
