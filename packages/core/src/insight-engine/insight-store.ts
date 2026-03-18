import { createHash } from 'node:crypto';
import {
  createLogger,
  generateId,
  type DatabaseInterface,
  type InsightStatus,
} from '@raven/shared';

const log = createLogger('insight-store');

const MS_PER_DAY = 86_400_000;

export interface InsightRow {
  id: string;
  pattern_key: string;
  title: string;
  body: string;
  confidence: number;
  status: InsightStatus;
  service_sources: string;
  suppression_hash: string;
  created_at: string;
  delivered_at: string | null;
  dismissed_at: string | null;
}

export interface InsertInsightParams {
  patternKey: string;
  title: string;
  body: string;
  confidence: number;
  status: InsightStatus;
  serviceSources: string[];
  suppressionHash: string;
}

export function computeSuppressionHash(patternKey: string, keyFacts: string[]): string {
  const normalized = [patternKey, ...keyFacts.sort()].join('|');
  return createHash('sha256').update(normalized).digest('hex');
}

export function insertInsight(db: DatabaseInterface, params: InsertInsightParams): string {
  const id = generateId();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO insights (id, pattern_key, title, body, confidence, status, service_sources, suppression_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.patternKey,
    params.title,
    params.body,
    params.confidence,
    params.status,
    JSON.stringify(params.serviceSources),
    params.suppressionHash,
    now,
  );

  log.info(`Inserted insight ${id} (${params.patternKey}) with status ${params.status}`);
  return id;
}

export function getInsightsByStatus(db: DatabaseInterface, status: InsightStatus): InsightRow[] {
  return db.all<InsightRow>(
    'SELECT * FROM insights WHERE status = ? ORDER BY created_at DESC',
    status,
  );
}

export function updateInsightStatus(
  db: DatabaseInterface,
  id: string,
  status: InsightStatus,
): void {
  const updates: Record<string, string | null> = {};

  if (status === 'delivered') {
    updates.delivered_at = new Date().toISOString();
  } else if (status === 'dismissed') {
    updates.dismissed_at = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) {
    const setClauses = [`status = ?`, ...Object.keys(updates).map((k) => `${k} = ?`)];
    const params = [status, ...Object.values(updates), id];
    db.run(`UPDATE insights SET ${setClauses.join(', ')} WHERE id = ?`, ...params);
  } else {
    db.run('UPDATE insights SET status = ? WHERE id = ?', status, id);
  }

  log.info(`Updated insight ${id} status to ${status}`);
}

export function findRecentByHash(
  db: DatabaseInterface,
  suppressionHash: string,
  windowDays: number,
): InsightRow | undefined {
  const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
  return db.get<InsightRow>(
    'SELECT * FROM insights WHERE suppression_hash = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    suppressionHash,
    cutoff,
  );
}
