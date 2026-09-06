import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger, generateId } from '@raven/shared';
import type { DatabaseInterface, TaskTree } from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { ExecutionLogger, TaskStats } from '../../agent-manager/execution-logger.ts';
import type {
  PendingApproval,
  PendingApprovals,
} from '../../permission-engine/pending-approvals.ts';
import type { ScheduleHealth } from '../../scheduler/schedule-engine.ts';
import { SERVICE_DEFINITIONS } from '../registry.ts';
import { Cron } from 'croner';
import { formatDefinitionDiagnostic } from '../../diagnostics/current-definition-diagnostics.ts';
import type { DefinitionDiagnostic } from '../../diagnostics/definition-diagnostics.ts';

const log = createLogger('self-test');

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const STUCK_TREE_HOURS = HOURS_PER_DAY;
const STALE_APPROVAL_HOURS = 48;
const CANARY_GRACE_HOURS = 1;
const CANARY_STALE_DAYS = 8;
const ONE_DAY_MS = HOURS_PER_DAY * MS_PER_HOUR;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.5;
const PERCENT = 100;
const CANARY_SCHEDULE_NAME = 'weekly-canary';
const WRITE_PROBE_FILE = '.self-test-write-probe';
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_ACTIVATION_GRACE = 5;
const MS_PER_MINUTE = MS_PER_HOUR / MINUTES_PER_HOUR;
const SCHEDULE_ACTIVATION_GRACE_MS = MINUTES_PER_ACTIVATION_GRACE * MS_PER_MINUTE;
const SCHEDULE_COMPLETION_GRACE_MS = MS_PER_MINUTE;
const SCHEDULE_STUCK_IN_FLIGHT_MS = MS_PER_HOUR;

/** Every deterministic health invariant Raven checks about itself, zero
 * model calls. Each function is pure given its inputs so it can be unit
 * tested against a seeded temp DB without booting the whole system. */

export interface ExecutionTreeQuery {
  queryTrees(): TaskTree[];
}

export function checkStuckTrees(engine: ExecutionTreeQuery, nowMs: number): string[] {
  const cutoffMs = nowMs - STUCK_TREE_HOURS * MS_PER_HOUR;
  return engine
    .queryTrees()
    .filter((tree) => tree.status === 'running' && new Date(tree.updatedAt).getTime() < cutoffMs)
    .map(
      (tree) =>
        `Task tree ${tree.id} has been "running" for over ${STUCK_TREE_HOURS}h (since ${tree.updatedAt})`,
    );
}

/** Any task tree that reached "failed" in the last 24h — a plan the
 * execution engine gave up on outright, distinct from checkStuckTrees'
 * "still running past deadline" case. `plan` is the tree's free-text
 * description (see task-execution-engine.ts); trees have no dedicated name
 * field, so it's the closest thing to one and falls back to the id. */
export function checkFailedTrees(engine: ExecutionTreeQuery, nowMs: number): string[] {
  const cutoffMs = nowMs - ONE_DAY_MS;
  return engine
    .queryTrees()
    .filter((tree) => tree.status === 'failed' && new Date(tree.updatedAt).getTime() >= cutoffMs)
    .map((tree) => `Task tree "${tree.plan ?? tree.id}" (${tree.id}) failed at ${tree.updatedAt}`);
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
export function checkScheduleFires(
  db: Database.Database,
  scheduleNames?: ReadonlySet<string>,
): string[] {
  const rows = db
    .prepare(
      `SELECT schedule_name, status, fired_at FROM schedule_fires sf
       WHERE fired_at = (SELECT MAX(fired_at) FROM schedule_fires WHERE schedule_name = sf.schedule_name)`,
    )
    .all() as ScheduleFireRow[];

  return rows
    .filter((r) => scheduleNames === undefined || scheduleNames.has(r.schedule_name))
    .filter((r) => r.status !== 'completed' && r.status !== 'fired')
    .map(
      (r) =>
        `Schedule "${r.schedule_name}" last fire ended in status "${r.status}" (${r.fired_at})`,
    );
}

interface LatestScheduleFire {
  schedule_name: string;
  status: string;
  fired_at: string;
}

function latestScheduleFire(
  db: Database.Database,
  schedule: ScheduleHealth,
): LatestScheduleFire | undefined {
  if (schedule.activationId === null) return undefined;
  return db
    .prepare(
      `SELECT schedule_name, status, fired_at FROM schedule_fires
       WHERE schedule_name = ? AND activation_id = ?
       ORDER BY fired_at DESC, rowid DESC LIMIT 1`,
    )
    .get(schedule.name, schedule.activationId) as LatestScheduleFire | undefined;
}

function currentScheduleFires(
  db: Database.Database,
  schedules: ScheduleHealth[],
): Map<string, LatestScheduleFire> {
  const latest = new Map<string, LatestScheduleFire>();
  for (const schedule of schedules) {
    const row = latestScheduleFire(db, schedule);
    if (row !== undefined) {
      latest.set(schedule.name, row);
    }
  }
  return latest;
}

function scheduleExpectedRun(health: ScheduleHealth, nowMs: number): number | null {
  try {
    const cron = new Cron(health.cron, { timezone: health.timezone });
    const cutoff = nowMs - SCHEDULE_COMPLETION_GRACE_MS;
    const [previous] = cron.previousRuns(1, new Date(cutoff));
    // Croner 10.0.1 can map a missing DST hour to a future instant even in
    // previousRuns(). That instant cannot be overdue before its actual time.
    const expected = previous?.getTime();
    return expected !== undefined && expected <= cutoff ? expected : null;
  } catch {
    return null;
  }
}

function scheduleAvailabilityViolation(schedule: ScheduleHealth): string | undefined {
  if (!schedule.enabled) return undefined;
  if (!schedule.registered || !schedule.active) {
    return `Schedule "${schedule.name}" is enabled but has no active registered schedule`;
  }
  if (schedule.activationId === null) {
    return `Schedule "${schedule.name}" has no activation identity`;
  }
  return undefined;
}

function scheduleInFlightViolation(schedule: ScheduleHealth, nowMs: number): string | undefined {
  if (schedule.inFlightSince === null) return undefined;
  if (nowMs - schedule.inFlightSince > SCHEDULE_STUCK_IN_FLIGHT_MS) {
    return `Schedule "${schedule.name}" has an invocation stuck for over 1h`;
  }
  return undefined;
}

function currentScheduleFireAt(
  row: LatestScheduleFire | undefined,
  activatedAt: number | null,
): number | null {
  if (row === undefined) return null;
  const firedAt = Date.parse(row.fired_at);
  if (!Number.isFinite(firedAt)) return null;
  if (activatedAt !== null && firedAt < activatedAt) return null;
  return firedAt;
}

function scheduleFreshnessViolation(
  schedule: ScheduleHealth,
  latest: Map<string, LatestScheduleFire>,
  nowMs: number,
): string | undefined {
  const row = latest.get(schedule.name);
  const expectedRun = scheduleExpectedRun(schedule, nowMs);
  if (expectedRun === null) return undefined;
  if (schedule.activatedAt !== null && expectedRun < schedule.activatedAt) {
    return undefined;
  }

  const activatedAt = schedule.activatedAt;
  const firedAt = currentScheduleFireAt(row, activatedAt);
  if (firedAt === null || firedAt < expectedRun) {
    return `Schedule "${schedule.name}" has not fired for its latest expected run`;
  }
  return undefined;
}

function scheduleFireStatusViolation(
  schedule: ScheduleHealth,
  latest: Map<string, LatestScheduleFire>,
): string | undefined {
  const row = latest.get(schedule.name);
  if (row === undefined || row.status === 'completed' || row.status === 'fired') {
    return undefined;
  }
  return `Schedule "${schedule.name}" last fire ended in status "${row.status}"`;
}

function checkScheduleHealthEntry(
  schedule: ScheduleHealth,
  latest: Map<string, LatestScheduleFire>,
  nowMs: number,
): string | undefined {
  if (!schedule.enabled) return undefined;
  const availability = scheduleAvailabilityViolation(schedule);
  if (availability !== undefined) return availability;
  if (schedule.inFlightSince !== null) return scheduleInFlightViolation(schedule, nowMs);
  const statusViolation = scheduleFireStatusViolation(schedule, latest);
  if (statusViolation !== undefined) return statusViolation;
  if (
    schedule.activatedAt === null ||
    nowMs - schedule.activatedAt < SCHEDULE_ACTIVATION_GRACE_MS
  ) {
    return undefined;
  }
  return scheduleFreshnessViolation(schedule, latest, nowMs);
}

/** Check only the current effective schedule definitions. Historical rows for
 * removed or disabled definitions are intentionally ignored. */
export function checkScheduleHealth(
  db: Database.Database,
  schedules: ScheduleHealth[],
  nowMs: number,
): string[] {
  const latest = currentScheduleFires(db, schedules);
  return schedules.flatMap((schedule) => {
    const violation = checkScheduleHealthEntry(schedule, latest, nowMs);
    return violation === undefined ? [] : [violation];
  });
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

/** The weekly canary fires a dedicated minimal template with
 * scheduleId="weekly-canary" (see template-scheduler.ts / projects/schedules/
 * weekly-canary.yaml), which stamps the tree's scheduleId — that's the
 * correlation, no separate bookkeeping needed. Only the most recent canary
 * tree matters; a fresh one (younger than CANARY_GRACE_HOURS) is given time
 * to finish before being judged.
 *
 * Two blind spots this also covers (absence and staleness), both gated on
 * `scheduleEnabled` — a disabled canary schedule that has never fired, or
 * hasn't fired recently, is expected, not a violation. */
export function checkCanary(
  engine: ExecutionTreeQuery,
  nowMs: number,
  scheduleEnabled: boolean,
): string[] {
  const row = [...engine.queryTrees()]
    .filter((tree) => tree.scheduleId === CANARY_SCHEDULE_NAME)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!row) {
    if (!scheduleEnabled) return [];
    return [
      `Weekly canary has never fired a task tree, but the "${CANARY_SCHEDULE_NAME}" schedule is enabled`,
    ];
  }

  const ageMs = nowMs - new Date(row.createdAt).getTime();

  if (scheduleEnabled && ageMs > CANARY_STALE_DAYS * ONE_DAY_MS) {
    const ageDays = Math.floor(ageMs / ONE_DAY_MS);
    return [
      `Weekly canary's newest tree ${row.id} is ${String(ageDays)}d old (fired ${row.createdAt}) — expected at least one per week`,
    ];
  }

  if (ageMs < CANARY_GRACE_HOURS * MS_PER_HOUR) return [];

  if (row.status !== 'completed') {
    return [
      `Weekly canary tree ${row.id} (fired ${row.createdAt}) did not reach "completed" — status is "${row.status}"`,
    ];
  }
  return [];
}

export interface SelfTestDeps {
  db: Database.Database;
  executionEngine: ExecutionTreeQuery;
  executionLogger: ExecutionLogger;
  pendingApprovals: PendingApprovals;
  serviceRunner: { getRunningCount(): number };
  dataDir: string;
  /** Current definition diagnostics are read on each run; persisted prior
   * violations remain notification history and do not replace this snapshot. */
  getDefinitionDiagnostics?: () => readonly DefinitionDiagnostic[];
  getProjectRecoveryDiagnostics?: () => readonly DefinitionDiagnostic[];
  /** Optional so callers/tests that construct SelfTestDeps by hand don't
   * need a real schedule engine — when absent, checkCanary treats the
   * canary schedule as "can't tell if it's enabled" and skips the
   * enabled-gated absence/staleness checks rather than guessing. */
  scheduleEngine?: {
    list(): Array<{ name: string; enabled: boolean }>;
    getHealth?(): ScheduleHealth[];
  };
}

export interface SelfTestResult {
  ok: boolean;
  violations: string[];
}

function isCanaryScheduleEnabled(deps: SelfTestDeps): boolean {
  return (
    deps.scheduleEngine?.list().some((s) => s.name === CANARY_SCHEDULE_NAME && s.enabled) ?? false
  );
}

/** Runs every invariant and aggregates the violations. Zero model calls —
 * every check is a store read, a numeric comparison, or a disk probe. */
export function runSelfTestChecks(deps: SelfTestDeps, nowMs = Date.now()): SelfTestResult {
  const health = deps.scheduleEngine?.getHealth?.();
  const scheduleViolations =
    health === undefined
      ? checkScheduleFires(
          deps.db,
          deps.scheduleEngine
            ? new Set(
                deps.scheduleEngine
                  .list()
                  .filter((s) => s.enabled)
                  .map((s) => s.name),
              )
            : undefined,
        )
      : checkScheduleHealth(deps.db, health, nowMs);
  const violations = [
    ...[
      ...(deps.getDefinitionDiagnostics?.() ?? []),
      ...(deps.getProjectRecoveryDiagnostics?.() ?? []),
    ]
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map(formatDefinitionDiagnostic),
    ...checkStuckTrees(deps.executionEngine, nowMs),
    ...checkFailedTrees(deps.executionEngine, nowMs),
    ...checkServicesLoaded(deps.serviceRunner.getRunningCount(), countEnvEligibleServices()),
    ...scheduleViolations,
    ...checkErrorRate(deps.executionLogger.getTaskStats(ONE_DAY_MS)),
    ...checkStaleApprovals(deps.pendingApprovals.query(), nowMs),
    ...checkDataDirWritable(deps.dataDir),
    ...checkDbIntegrity(deps.db),
    ...checkCanary(deps.executionEngine, nowMs, isCanaryScheduleEnabled(deps)),
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

function parseViolationsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch (err) {
    log.warn(`Failed to parse persisted self-test violations: ${String(err)}`);
    return [];
  }
}

/** The violation set from the previous run, read BEFORE the current run's
 * result is persisted — used to dedupe alerts (see notifyViolations). */
function getPreviousViolations(db: Database.Database): string[] {
  const row = db
    .prepare(`SELECT violations_json FROM self_test_results ORDER BY ran_at DESC LIMIT 1`)
    .get() as { violations_json: string } | undefined;
  return row ? parseViolationsJson(row.violations_json) : [];
}

/** One batched notification for the whole run — never one per violation,
 * and never a repeat of violations already alerted on last run (a standing
 * violation still shows up in the persisted result and in /api/health, it
 * just doesn't re-page every run). Only genuinely new violations trigger a
 * notification; a "still failing: N" line covers what's already known. */
function notifyViolations(
  eventBus: EventBus,
  result: SelfTestResult,
  previousViolations: string[],
): void {
  if (result.ok) return;

  const previousSet = new Set(previousViolations);
  const newViolations = result.violations.filter((v) => !previousSet.has(v));
  const standingCount = result.violations.length - newViolations.length;
  if (newViolations.length === 0) return;

  const bodyLines = newViolations.map((v) => `- ${v}`);
  if (standingCount > 0) {
    bodyLines.push('', `_still failing: ${String(standingCount)} previously reported issue(s)_`);
  }

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'self-test',
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: `Self-test found ${String(newViolations.length)} new issue(s)`,
      body: bodyLines.join('\n'),
      topicName: 'System',
      destination: { kind: 'global', topic: 'system' },
    },
  });
}

export interface SelfTestJobDeps extends SelfTestDeps {
  eventBus: EventBus;
}

/** Scheduled job handler (registered as 'self-test' in core-jobs.ts). One
 * batched notification for the whole run — never one per violation. */
export async function runSelfTestJob(deps: SelfTestJobDeps): Promise<{ summary: string }> {
  const previousViolations = getPreviousViolations(deps.db);
  const result = runSelfTestChecks(deps);
  persistResult(deps.db, result);
  notifyViolations(deps.eventBus, result, previousViolations);

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

  const ok = row.ok === 1;
  let violations: string[];
  try {
    const parsed: unknown = JSON.parse(row.violations_json);
    violations = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch (err) {
    log.warn(`Failed to parse persisted self-test violations: ${String(err)}`);
    // A failed run (ok=false) whose violations can't be parsed must not
    // silently read as "0 violations" — that would render as healthy on
    // the dashboard despite the persisted row saying otherwise. Surface
    // the parse failure itself as a violation instead.
    violations = ok
      ? []
      : ['Self-test results are unreadable (failed to parse persisted violations)'];
  }

  return { lastRun: row.ran_at, ok, violations };
}
