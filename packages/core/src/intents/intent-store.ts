import type Database from 'better-sqlite3';
import { createLogger, generateId } from '@raven/shared';

const log = createLogger('intent-store');

const DEFAULT_FIRE_BUDGET = 3;
const DEFAULT_TIME_FIRE_BUDGET = 1;
const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_EXPIRY_DAYS = 90;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

export type IntentKind = 'event' | 'time';
export type IntentStatus = 'active' | 'exhausted' | 'expired' | 'cancelled';

export interface Intent {
  id: string;
  kind: IntentKind;
  keywords: string[];
  eventTypes: string[];
  message: string;
  nextFireAt: number | null;
  fireBudget: number;
  firesUsed: number;
  cooldownHours: number;
  lastFiredAt: number | null;
  expiresAt: number | null;
  status: IntentStatus;
  createdAt: number;
  sourceSession: string | null;
}

interface IntentRow {
  id: string;
  kind: string;
  pattern: string;
  event_types: string;
  message: string;
  next_fire_at: number | null;
  fire_budget: number;
  fires_used: number;
  cooldown_hours: number;
  last_fired_at: number | null;
  expires_at: number | null;
  status: string;
  created_at: number;
  source_session: string | null;
}

function safeParseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch (err) {
    log.warn(`Failed to parse intent JSON array field: ${String(err)}`);
    return [];
  }
}

function rowToIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    kind: row.kind as IntentKind,
    keywords: safeParseStringArray(row.pattern),
    eventTypes: safeParseStringArray(row.event_types),
    message: row.message,
    nextFireAt: row.next_fire_at,
    fireBudget: row.fire_budget,
    firesUsed: row.fires_used,
    cooldownHours: row.cooldown_hours,
    lastFiredAt: row.last_fired_at,
    expiresAt: row.expires_at,
    status: row.status as IntentStatus,
    createdAt: row.created_at,
    sourceSession: row.source_session,
  };
}

export interface CreateIntentInput {
  kind: IntentKind;
  /** kind='event' only — ALL must match (case-insensitive). */
  keywords?: string[];
  /** kind='event' only — RavenEvent `type` strings to listen for. */
  eventTypes?: string[];
  /** kind='time' only — epoch ms of the target one-shot fire time. */
  nextFireAt?: number;
  message: string;
  /** Defaults to 1 for kind='time' (one-shot) and 3 for kind='event'
   * (recurring reminder), matching the owner's likely intent for each shape
   * unless they explicitly ask for more. */
  fireBudget?: number;
  cooldownHours?: number;
  /** epoch ms. Defaults to now + 90 days. */
  expiresAt?: number;
  sourceSession?: string;
}

export interface IntentStore {
  create(input: CreateIntentInput, nowMs?: number): Intent;
  list(filter?: { status?: IntentStatus }): Intent[];
  listActive(): Intent[];
  /** Active kind='time' intents whose nextFireAt has arrived — read by the
   * matcher's minute sweep. */
  listDueTimeIntents(nowMs: number): Intent[];
  get(id: string): Intent | undefined;
  /** Cancels an active/exhausted intent (idempotent no-op on an already
   * terminal one). Returns true only if this call changed the row. */
  cancel(id: string): boolean;
  /**
   * The single guarded UPDATE that enforces budget/cooldown/expiry
   * atomically — no read-then-write race between two events matching the
   * same intent in the same tick. Returns true only when this call was the
   * one that incremented fires_used (i.e., the fire should actually be
   * delivered); false means budget/cooldown/expiry/status blocked it and
   * nothing changed.
   */
  tryFire(id: string, nowMs: number): boolean;
  /** Flips 'active' rows whose expires_at has passed to 'expired'. Returns
   * the count flipped. Independent of tryFire's own expiry guard, which only
   * blocks a fire in the moment — this is what makes the status durable. */
  expireStale(nowMs: number): number;
}

function getById(db: Database.Database, id: string): Intent | undefined {
  const row = db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
}

function listByStatus(db: Database.Database, status?: IntentStatus): Intent[] {
  const rows = status
    ? (db
        .prepare('SELECT * FROM intents WHERE status = ? ORDER BY created_at DESC')
        .all(status) as IntentRow[])
    : (db.prepare('SELECT * FROM intents ORDER BY created_at DESC').all() as IntentRow[]);
  return rows.map(rowToIntent);
}

interface ResolvedCreateDefaults {
  fireBudget: number;
  cooldownHours: number;
  expiresAt: number;
}

function resolveCreateDefaults(input: CreateIntentInput, nowMs: number): ResolvedCreateDefaults {
  const defaultBudget = input.kind === 'time' ? DEFAULT_TIME_FIRE_BUDGET : DEFAULT_FIRE_BUDGET;
  return {
    fireBudget: input.fireBudget ?? defaultBudget,
    cooldownHours: input.cooldownHours ?? DEFAULT_COOLDOWN_HOURS,
    expiresAt: input.expiresAt ?? nowMs + DEFAULT_EXPIRY_DAYS * MS_PER_DAY,
  };
}

function insertIntent(db: Database.Database, input: CreateIntentInput, nowMs: number): Intent {
  const defaults = resolveCreateDefaults(input, nowMs);
  const id = generateId();
  db.prepare(
    `INSERT INTO intents
       (id, kind, pattern, event_types, message, next_fire_at, fire_budget,
        fires_used, cooldown_hours, last_fired_at, expires_at, status,
        created_at, source_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, 'active', ?, ?)`,
  ).run(
    id,
    input.kind,
    JSON.stringify(input.keywords ?? []),
    JSON.stringify(input.eventTypes ?? []),
    input.message,
    input.nextFireAt ?? null,
    defaults.fireBudget,
    defaults.cooldownHours,
    defaults.expiresAt,
    nowMs,
    input.sourceSession ?? null,
  );

  const created = getById(db, id);
  if (!created) throw new Error(`Intent ${id} vanished immediately after insert`);
  log.info(`Intent created: ${id} (kind=${input.kind}, budget=${String(defaults.fireBudget)})`);
  return created;
}

// The atomic guard: every clause in WHERE must hold for the row to update at
// all, and the SET clause both records the fire AND flips status to
// 'exhausted' in the SAME statement once this fire consumes the last of the
// budget — there is no window between "check budget" and "record fire" for a
// second concurrent match to sneak through.
function tryFireGuarded(db: Database.Database, id: string, nowMs: number): boolean {
  const result = db
    .prepare(
      `UPDATE intents
       SET fires_used = fires_used + 1,
           last_fired_at = @now,
           status = CASE WHEN fires_used + 1 >= fire_budget THEN 'exhausted' ELSE status END
       WHERE id = @id
         AND status = 'active'
         AND fires_used < fire_budget
         AND (last_fired_at IS NULL OR @now - last_fired_at >= cooldown_hours * ${String(MS_PER_HOUR)})
         AND (expires_at IS NULL OR @now < expires_at)`,
    )
    .run({ now: nowMs, id });
  return result.changes > 0;
}

export function createIntentStore(db: Database.Database): IntentStore {
  return {
    create(input: CreateIntentInput, nowMs = Date.now()): Intent {
      return insertIntent(db, input, nowMs);
    },

    list(filter?: { status?: IntentStatus }): Intent[] {
      return listByStatus(db, filter?.status);
    },

    listActive(): Intent[] {
      return listByStatus(db, 'active');
    },

    listDueTimeIntents(nowMs: number): Intent[] {
      const rows = db
        .prepare(
          `SELECT * FROM intents
           WHERE kind = 'time' AND status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?`,
        )
        .all(nowMs) as IntentRow[];
      return rows.map(rowToIntent);
    },

    get(id: string): Intent | undefined {
      return getById(db, id);
    },

    cancel(id: string): boolean {
      const result = db
        .prepare(`UPDATE intents SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
        .run(id);
      return result.changes > 0;
    },

    tryFire(id: string, nowMs: number): boolean {
      return tryFireGuarded(db, id, nowMs);
    },

    expireStale(nowMs: number): number {
      const result = db
        .prepare(
          `UPDATE intents SET status = 'expired'
           WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
        )
        .run(nowMs);
      return result.changes;
    },
  };
}
