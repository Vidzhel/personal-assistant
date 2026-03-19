import type { DatabaseInterface } from '@raven/shared';
import { generateId, createLogger } from '@raven/shared';
import { matchesPattern } from './urgency-classifier.ts';

const log = createLogger('snooze-store');

export interface SnoozeRecord {
  id: string;
  category: string;
  snoozedUntil: string | null;
  heldCount: number;
  lastSuggestedAt: string | null;
  createdAt: string;
}

type SnoozeDuration = '1h' | '1d' | '1w' | 'mute';

const DURATION_MS: Record<string, number> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

interface CreateSnoozeParams {
  category: string;
  duration: SnoozeDuration;
}

export function createSnooze(db: DatabaseInterface, params: CreateSnoozeParams): SnoozeRecord {
  const id = generateId();
  const now = new Date();
  const createdAt = now.toISOString();

  let snoozedUntil: string | null = null;
  if (params.duration !== 'mute') {
    const ms = DURATION_MS[params.duration];
    snoozedUntil = new Date(now.getTime() + ms).toISOString();
  }

  db.run(
    `INSERT INTO notification_snooze (id, category, snoozed_until, held_count, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    id,
    params.category,
    snoozedUntil,
    createdAt,
  );

  log.info(`Created snooze ${id} for "${params.category}" until ${snoozedUntil ?? 'muted'}`);
  return {
    id,
    category: params.category,
    snoozedUntil,
    heldCount: 0,
    lastSuggestedAt: null,
    createdAt,
  };
}

export function getActiveSnoozes(db: DatabaseInterface): SnoozeRecord[] {
  const now = new Date().toISOString();
  return db.all<SnoozeRecord>(
    `SELECT id, category, snoozed_until AS snoozedUntil, held_count AS heldCount,
            last_suggested_at AS lastSuggestedAt, created_at AS createdAt
     FROM notification_snooze
     WHERE snoozed_until IS NULL OR snoozed_until > ?`,
    now,
  );
}

export function getSnoozeForCategory(db: DatabaseInterface, source: string): SnoozeRecord | null {
  const now = new Date().toISOString();
  const allSnoozes = db.all<SnoozeRecord>(
    `SELECT id, category, snoozed_until AS snoozedUntil, held_count AS heldCount,
            last_suggested_at AS lastSuggestedAt, created_at AS createdAt
     FROM notification_snooze
     WHERE snoozed_until IS NULL OR snoozed_until > ?`,
    now,
  );

  for (const snooze of allSnoozes) {
    if (matchesPattern(source, snooze.category)) {
      return snooze;
    }
  }

  return null;
}

export function removeSnooze(db: DatabaseInterface, id: string): boolean {
  const exists = db.get<{ id: string }>(`SELECT id FROM notification_snooze WHERE id = ?`, id);
  if (!exists) return false;
  db.run(`DELETE FROM notification_snooze WHERE id = ?`, id);
  return true;
}

export function incrementHeldCount(db: DatabaseInterface, id: string): void {
  db.run(`UPDATE notification_snooze SET held_count = held_count + 1 WHERE id = ?`, id);
}

export function expireSnoozes(db: DatabaseInterface, now: string): SnoozeRecord[] {
  const expired = db.all<SnoozeRecord>(
    `SELECT id, category, snoozed_until AS snoozedUntil, held_count AS heldCount,
            last_suggested_at AS lastSuggestedAt, created_at AS createdAt
     FROM notification_snooze
     WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`,
    now,
  );

  if (expired.length > 0) {
    db.run(
      `DELETE FROM notification_snooze WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`,
      now,
    );
    log.info(`Expired ${expired.length} snooze(s)`);
  }

  return expired;
}

export function updateLastSuggested(db: DatabaseInterface, category: string): void {
  const now = new Date().toISOString();
  db.run(`UPDATE notification_snooze SET last_suggested_at = ? WHERE category = ?`, now, category);
}

export function getLastSuggestionTime(db: DatabaseInterface, category: string): string | null {
  const row = db.get<{ lastSuggestedAt: string | null }>(
    `SELECT last_suggested_at AS lastSuggestedAt FROM notification_snooze WHERE category = ?`,
    category,
  );
  return row?.lastSuggestedAt ?? null;
}
