import type Database from 'better-sqlite3';
import { createLogger, generateId } from '@raven/shared';

const log = createLogger('pending-approvals');

export interface PendingApproval {
  id: string;
  actionName: string;
  skillName: string;
  details?: string;
  requestedAt: string;
  resolvedAt?: string;
  resolution?: 'approved' | 'denied';
  sessionId?: string;
}

export interface PendingApprovals {
  insert(
    entry: Omit<PendingApproval, 'id' | 'requestedAt' | 'resolvedAt' | 'resolution'>,
  ): PendingApproval;
  query(): PendingApproval[];
  getById(id: string): PendingApproval | undefined;
  resolve(id: string, resolution: 'approved' | 'denied'): PendingApproval;
  /** Most recent still-unresolved approval for this (actionName, sessionId)
   * pair, if any — used by tool-policy.ts's blockForApproval to dedup
   * repeated red-tier attempts (e.g. a model retrying the same blocked MCP
   * call) into one pending row instead of spamming a fresh approval +
   * Telegram ping per attempt. sessionId is matched with SQL `IS` so
   * `undefined` correctly matches other undefined-session callers too. */
  findUnresolved(actionName: string, sessionId?: string): PendingApproval | undefined;
  initialize(): void;
}

interface PendingApprovalRow {
  id: string;
  action_name: string;
  skill_name: string;
  details: string | null;
  requested_at: string;
  resolved_at: string | null;
  resolution: string | null;
  session_id: string | null;
}

function rowToApproval(row: PendingApprovalRow): PendingApproval {
  return {
    id: row.id,
    actionName: row.action_name,
    skillName: row.skill_name,
    requestedAt: row.requested_at,
    ...(row.details !== null && { details: row.details }),
    ...(row.resolved_at !== null && { resolvedAt: row.resolved_at }),
    ...(row.resolution !== null && {
      resolution: row.resolution as 'approved' | 'denied',
    }),
    ...(row.session_id !== null && { sessionId: row.session_id }),
  };
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes all pending approval methods
export function createPendingApprovals(db: Database.Database): PendingApprovals {
  return {
    initialize(): void {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_approvals'")
        .get() as { name: string } | undefined;
      if (!table) {
        throw new Error('pending_approvals table does not exist. Run migrations first.');
      }
      log.info('Pending approvals table verified');
    },

    insert(
      entry: Omit<PendingApproval, 'id' | 'requestedAt' | 'resolvedAt' | 'resolution'>,
    ): PendingApproval {
      const id = generateId();
      const requestedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO pending_approvals (id, action_name, skill_name, details, requested_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        entry.actionName,
        entry.skillName,
        entry.details ?? null,
        requestedAt,
        entry.sessionId ?? null,
      );

      const inserted = db
        .prepare('SELECT * FROM pending_approvals WHERE id = ?')
        .get(id) as PendingApprovalRow;

      return rowToApproval(inserted);
    },

    query(): PendingApproval[] {
      const rows = db
        .prepare(
          'SELECT * FROM pending_approvals WHERE resolution IS NULL ORDER BY requested_at ASC',
        )
        .all() as PendingApprovalRow[];

      return rows.map(rowToApproval);
    },

    getById(id: string): PendingApproval | undefined {
      const row = db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as
        PendingApprovalRow | undefined;

      return row ? rowToApproval(row) : undefined;
    },

    findUnresolved(actionName: string, sessionId?: string): PendingApproval | undefined {
      const row = db
        .prepare(
          `SELECT * FROM pending_approvals
           WHERE action_name = ? AND session_id IS ? AND resolution IS NULL
           ORDER BY requested_at DESC LIMIT 1`,
        )
        .get(actionName, sessionId ?? null) as PendingApprovalRow | undefined;

      return row ? rowToApproval(row) : undefined;
    },

    resolve(id: string, resolution: 'approved' | 'denied'): PendingApproval {
      const resolvedAt = new Date().toISOString();

      const result = db
        .prepare(
          'UPDATE pending_approvals SET resolution = ?, resolved_at = ? WHERE id = ? AND resolution IS NULL',
        )
        .run(resolution, resolvedAt, id);

      if (result.changes === 0) {
        const existing = db.prepare('SELECT id FROM pending_approvals WHERE id = ?').get(id) as
          { id: string } | undefined;
        if (!existing) {
          const err = new Error(`Pending approval not found: ${id}`);
          (err as Error & { code: string }).code = 'APPROVAL_NOT_FOUND';
          throw err;
        }
        const err = new Error(`Pending approval already resolved: ${id}`);
        (err as Error & { code: string }).code = 'APPROVAL_ALREADY_RESOLVED';
        throw err;
      }

      const updated = db
        .prepare('SELECT * FROM pending_approvals WHERE id = ?')
        .get(id) as PendingApprovalRow;

      return rowToApproval(updated);
    },
  };
}
