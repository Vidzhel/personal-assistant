import type Database from 'better-sqlite3';
import { createLogger, generateId, type AuditEntry, type AuditLogFilter } from '@raven/shared';

const log = createLogger('audit-log');

export interface AuditLog {
  insert(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry;
  query(filters?: AuditLogFilter): AuditEntry[];
  initialize(): void;
}

interface AuditLogRow {
  id: string;
  timestamp: string;
  skill_name: string;
  action_name: string;
  permission_tier: string;
  outcome: string;
  details: string | null;
  session_id: string | null;
  pipeline_name: string | null;
}

function rowToEntry(row: AuditLogRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    skillName: row.skill_name,
    actionName: row.action_name,
    permissionTier: row.permission_tier as AuditEntry['permissionTier'],
    outcome: row.outcome as AuditEntry['outcome'],
    ...(row.details !== null && { details: row.details }),
    ...(row.session_id !== null && { sessionId: row.session_id }),
    ...(row.pipeline_name !== null && { pipelineName: row.pipeline_name }),
  };
}

export function createAuditLog(db: Database.Database): AuditLog {
  return {
    initialize(): void {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'")
        .get() as { name: string } | undefined;
      if (!table) {
        throw new Error('audit_log table does not exist. Run migrations first.');
      }
      log.info('Audit log table verified');
    },

    insert(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
      const id = generateId();
      const timestamp = new Date().toISOString();

      db.prepare(
        `INSERT INTO audit_log (id, timestamp, skill_name, action_name, permission_tier, outcome, details, session_id, pipeline_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        timestamp,
        entry.skillName,
        entry.actionName,
        entry.permissionTier,
        entry.outcome,
        entry.details ?? null,
        entry.sessionId ?? null,
        entry.pipelineName ?? null,
      );

      const inserted = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as AuditLogRow;

      return rowToEntry(inserted);
    },

    query(filters?: AuditLogFilter): AuditEntry[] {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters?.skillName) {
        conditions.push('skill_name = ?');
        params.push(filters.skillName);
      }
      if (filters?.tier) {
        conditions.push('permission_tier = ?');
        params.push(filters.tier);
      }
      if (filters?.outcome) {
        conditions.push('outcome = ?');
        params.push(filters.outcome);
      }
      if (filters?.from) {
        conditions.push('timestamp >= ?');
        params.push(filters.from);
      }
      if (filters?.to) {
        conditions.push('timestamp <= ?');
        params.push(filters.to);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = filters?.limit ?? 100;
      const offset = filters?.offset ?? 0;

      const rows = db
        .prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as AuditLogRow[];

      return rows.map(rowToEntry);
    },
  };
}
