import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

const MICRO_USD = 1_000_000;
const MAX_SAFE_MICRO_USD = Number.MAX_SAFE_INTEGER;
const VALID_STATUSES = new Set(['reserved', 'known', 'unknown', 'released']);

export interface ModelBudgetOptions {
  db: Database.Database;
  dailyLimitUsd: number;
  maxConcurrent: number;
  timeZone: string;
  now?: () => number;
}
export interface ModelBudgetReserveInput {
  taskId: string;
  model: string;
}
export interface ModelBudgetLease {
  id: string;
  maxBudgetUsd: number;
}
export interface ModelBudgetSettlement {
  costUsd?: number;
  reason?: string;
}
export interface ModelBudgetCounts {
  reserved: number;
  known: number;
  unknown: number;
  released: number;
}
export interface ModelBudgetSummary {
  day: string;
  timeZone: string;
  limitUsd: number;
  knownUsd: number;
  reservedUsd: number;
  unknownUsd: number;
  remainingUsd: number;
  counts: ModelBudgetCounts;
}
export interface ModelBudget {
  reserve(input: ModelBudgetReserveInput): ModelBudgetLease | undefined;
  settle(id: string, settlement?: ModelBudgetSettlement): void;
  releaseBeforeStart(id: string): void;
  recoverInterrupted(): void;
  getSummary(): ModelBudgetSummary;
}

type Status = 'reserved' | 'known' | 'unknown' | 'released';
interface AggregateRow {
  status: Status;
  amount_micro_usd: number;
  count: number;
}
interface Aggregate {
  known: number;
  reserved: number;
  unknown: number;
  counts: ModelBudgetCounts;
}

function asMicroUsd(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  const micros = Math.round(value * MICRO_USD);
  if (!Number.isSafeInteger(micros) || micros > MAX_SAFE_MICRO_USD) {
    throw new Error(`${name} is outside the supported money range`);
  }
  return micros;
}

function assertTimeZone(timeZone: string): void {
  if (!timeZone || typeof timeZone !== 'string') {
    throw new Error('timeZone must be a valid IANA time zone');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
}

function dayAt(epochMs: number, timeZone: string): string {
  if (!Number.isFinite(epochMs)) throw new Error('now must return a finite epoch timestamp');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epochMs);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function tx<T>(db: Database.Database, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original SQLite error if SQLite already rolled back.
    }
    throw error;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

class SqliteModelBudget implements ModelBudget {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly limitMicroUsd: number;
  private readonly maxConcurrent: number;
  private readonly timeZone: string;
  private readonly aggregateQuery: Database.Statement;

  constructor(options: ModelBudgetOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.limitMicroUsd = asMicroUsd(options.dailyLimitUsd, 'dailyLimitUsd');
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 'maxConcurrent');
    assertTimeZone(options.timeZone);
    this.timeZone = options.timeZone;
    this.aggregateQuery = this.db.prepare(`
      SELECT status,
             CASE status WHEN 'known' THEN COALESCE(SUM(actual_micro_usd), 0)
               WHEN 'released' THEN 0 ELSE COALESCE(SUM(reservation_micro_usd), 0) END
               AS amount_micro_usd,
             COUNT(*) AS count
        FROM model_budget_leases WHERE bucket_day = ? GROUP BY status`);
  }

  private aggregate(day: string): Aggregate {
    const result: Aggregate = {
      known: 0,
      reserved: 0,
      unknown: 0,
      counts: { reserved: 0, known: 0, unknown: 0, released: 0 },
    };
    for (const row of this.aggregateQuery.all(day) as AggregateRow[]) {
      if (!VALID_STATUSES.has(row.status)) throw new Error('Invalid model budget lease status');
      result.counts[row.status] = row.count;
      if (row.status === 'known') result.known = row.amount_micro_usd;
      if (row.status === 'reserved') result.reserved = row.amount_micro_usd;
      if (row.status === 'unknown') result.unknown = row.amount_micro_usd;
    }
    return result;
  }

  getSummary(): ModelBudgetSummary {
    const day = dayAt(this.now(), this.timeZone);
    const aggregate = this.aggregate(day);
    const remaining = Math.max(
      0,
      this.limitMicroUsd - aggregate.known - aggregate.reserved - aggregate.unknown,
    );
    const dollars = (micros: number): number => micros / MICRO_USD;
    return {
      day,
      timeZone: this.timeZone,
      limitUsd: dollars(this.limitMicroUsd),
      knownUsd: dollars(aggregate.known),
      reservedUsd: dollars(aggregate.reserved),
      unknownUsd: dollars(aggregate.unknown),
      remainingUsd: dollars(remaining),
      counts: aggregate.counts,
    };
  }

  reserve(input: ModelBudgetReserveInput): ModelBudgetLease | undefined {
    if (
      typeof input.taskId !== 'string' ||
      typeof input.model !== 'string' ||
      !input.taskId ||
      !input.model
    ) {
      throw new Error('taskId and model are required');
    }
    const createdAt = this.now();
    const day = dayAt(createdAt, this.timeZone);
    return tx(this.db, () => {
      const aggregate = this.aggregate(day);
      const available =
        this.limitMicroUsd - aggregate.known - aggregate.reserved - aggregate.unknown;
      const fixedCeiling = Math.floor(this.limitMicroUsd / Math.max(2, this.maxConcurrent + 1));
      const ceiling = Math.min(fixedCeiling, Math.floor(available / 2));
      if (ceiling < 1) return undefined;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO model_budget_leases
          (id, task_id, model, bucket_day, time_zone, reservation_micro_usd, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(id, input.taskId, input.model, day, this.timeZone, ceiling, createdAt);
      return { id, maxBudgetUsd: ceiling / MICRO_USD };
    });
  }

  settle(id: string, settlement: ModelBudgetSettlement = {}): void {
    tx(this.db, () => {
      const row = this.db.prepare('SELECT status FROM model_budget_leases WHERE id = ?').get(id) as
        { status: Status } | undefined;
      if (!row || row.status !== 'reserved') return;
      const completedAt = this.now();
      if (settlement.costUsd === undefined) {
        this.db
          .prepare(
            `UPDATE model_budget_leases SET status = 'unknown', reason = ?, settled_at = ?
            WHERE id = ? AND status = 'reserved'`,
          )
          .run(
            settlement.reason ?? 'Model query ended without a trustworthy cost estimate',
            completedAt,
            id,
          );
        return;
      }
      const cost = asMicroUsd(settlement.costUsd, 'costUsd');
      this.db
        .prepare(
          `UPDATE model_budget_leases SET status = 'known', actual_micro_usd = ?, reason = ?, settled_at = ?
          WHERE id = ? AND status = 'reserved'`,
        )
        .run(cost, settlement.reason ?? null, completedAt, id);
    });
  }

  releaseBeforeStart(id: string): void {
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE model_budget_leases SET status = 'released', actual_micro_usd = 0,
          reason = 'Model query did not start', settled_at = ? WHERE id = ? AND status = 'reserved'`,
        )
        .run(this.now(), id);
    });
  }

  recoverInterrupted(): void {
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE model_budget_leases SET status = 'unknown',
          reason = 'Prior process ended before model query cost was finalized', settled_at = ?
          WHERE status = 'reserved'`,
        )
        .run(this.now());
    });
  }
}

export function createModelBudget(options: ModelBudgetOptions): ModelBudget {
  return new SqliteModelBudget(options);
}
