import {
  createLogger,
  generateId,
  ModelConfigSchema,
  type AgentSession,
  type ModelConfig,
} from '@raven/shared';
import { getDb } from '../db/database.ts';

const log = createLogger('session-manager');

export class SessionManager {
  getOrCreateSession(projectId: string): AgentSession {
    const db = getDb();

    // Check for an existing active session
    const existing = db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? AND status IN ('idle', 'running') ORDER BY last_active_at DESC LIMIT 1",
      )
      .get(projectId) as SessionRow | undefined;

    if (existing) {
      return rowToSession(existing);
    }

    // Create new session
    const session: AgentSession = {
      id: generateId(),
      projectId,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      turnCount: 0,
    };

    db.prepare(
      'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      session.id,
      session.projectId,
      session.status,
      session.createdAt,
      session.lastActiveAt,
      session.turnCount,
    );

    log.info(`Created session ${session.id} for project ${projectId}`);
    return session;
  }

  linkSdkSession(sessionId: string, sdkSessionId: string, revision?: string): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET sdk_session_id = ?, sdk_resume_revision = ? WHERE id = ?').run(
      sdkSessionId,
      revision ?? null,
      sessionId,
    );
  }

  /** Distinguishes a matching SDK lineage from a missing lineage and one that
   * was cleared because its dispatch revision changed. */
  getSdkResumeState(sessionId: string, revision?: string): SdkResumeState {
    const db = getDb();
    const row = db
      .prepare('SELECT sdk_session_id, sdk_resume_revision FROM sessions WHERE id = ?')
      .get(sessionId) as
      { sdk_session_id: string | null; sdk_resume_revision: string | null } | undefined;
    if (!row || row.sdk_session_id === null) return { status: 'missing' };
    const expectedRevision = revision ?? null;
    if (row.sdk_resume_revision !== expectedRevision) {
      db.prepare(
        `UPDATE sessions
         SET sdk_session_id = NULL, sdk_resume_revision = NULL
         WHERE id = ? AND sdk_resume_revision IS ? AND sdk_session_id IS ?`,
      ).run(sessionId, row.sdk_resume_revision, row.sdk_session_id);
      return { status: 'changed' };
    }
    return { status: 'matched', sessionId: row.sdk_session_id };
  }

  /** Compatibility wrapper for callers that only need a matching SDK id. */
  getSdkSessionId(sessionId: string, revision?: string): string | undefined {
    const state = this.getSdkResumeState(sessionId, revision);
    return state.status === 'matched' ? state.sessionId : undefined;
  }

  clearSdkSession(sessionId: string): void {
    const db = getDb();
    db.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, sdk_resume_revision = NULL WHERE id = ?',
    ).run(sessionId);
  }

  incrementTurnCount(sessionId: string): void {
    const db = getDb();
    db.prepare(
      'UPDATE sessions SET turn_count = turn_count + 1, last_active_at = ? WHERE id = ?',
    ).run(Date.now(), sessionId);
  }

  updateStatus(sessionId: string, status: AgentSession['status']): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?').run(
      status,
      Date.now(),
      sessionId,
    );
  }

  createSession(projectId: string): AgentSession {
    const db = getDb();

    // Archive any active sessions for this project
    db.prepare(
      "UPDATE sessions SET status = 'archived' WHERE project_id = ? AND status IN ('idle', 'running')",
    ).run(projectId);

    const session: AgentSession = {
      id: generateId(),
      projectId,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      turnCount: 0,
    };

    db.prepare(
      'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      session.id,
      session.projectId,
      session.status,
      session.createdAt,
      session.lastActiveAt,
      session.turnCount,
    );

    log.info(`Created new session ${session.id} for project ${projectId}`);
    return session;
  }

  /** Create another conversation without archiving other active project sessions. */
  createAdditionalSession(projectId: string): AgentSession {
    const db = getDb();
    const session: AgentSession = {
      id: generateId(),
      projectId,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      turnCount: 0,
    };
    db.prepare(
      'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      session.id,
      session.projectId,
      session.status,
      session.createdAt,
      session.lastActiveAt,
      session.turnCount,
    );
    log.info(`Created additional session ${session.id} for project ${projectId}`);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getProjectSessions(projectId: string): AgentSession[] {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT * FROM sessions WHERE project_id = ? ORDER BY pinned DESC, last_active_at DESC',
      )
      .all(projectId) as SessionRow[];
    return rows.map(rowToSession);
  }

  updateSession(
    sessionId: string,
    updates: {
      name?: string;
      description?: string;
      pinned?: boolean;
      modelConfig?: ModelConfig | null;
    },
  ): void {
    const db = getDb();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      values.push(updates.description);
    }
    if (updates.pinned !== undefined) {
      sets.push('pinned = ?');
      values.push(updates.pinned ? 1 : 0);
    }
    if (updates.modelConfig !== undefined) {
      sets.push('model_config_json = ?');
      values.push(
        updates.modelConfig === null
          ? null
          : JSON.stringify(ModelConfigSchema.parse(updates.modelConfig)),
      );
    }

    if (sets.length === 0) return;

    sets.push('last_active_at = ?');
    values.push(Date.now());
    values.push(sessionId);

    db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  updateSummary(sessionId: string, summary: string): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, sessionId);
  }

  autoGenerateName(sessionId: string, firstMessage: string): void {
    const db = getDb();
    const row = db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as
      { name: string | null } | undefined;

    if (!row || row.name !== null) return;

    const maxLength = 60;
    let name: string;
    if (firstMessage.length <= maxLength) {
      name = firstMessage;
    } else {
      const truncated = firstMessage.slice(0, maxLength);
      const lastSpace = truncated.lastIndexOf(' ');
      name = (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
    }

    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, sessionId);
  }
}

interface SessionRow {
  id: string;
  sdk_session_id: string | null;
  sdk_resume_revision: string | null;
  project_id: string;
  status: string;
  created_at: number;
  last_active_at: number;
  turn_count: number;
  current_task_id: string | null;
  name: string | null;
  description: string | null;
  pinned: number;
  summary: string | null;
  model_config_json: string | null;
}

export type SdkResumeState =
  { status: 'matched'; sessionId: string } | { status: 'changed' | 'missing' };

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    sdkSessionId: row.sdk_session_id ?? undefined,
    projectId: row.project_id,
    status: row.status as AgentSession['status'],
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    turnCount: row.turn_count,
    currentTaskId: row.current_task_id ?? undefined,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    pinned: row.pinned === 1,
    summary: row.summary ?? undefined,
    modelConfig:
      row.model_config_json === null
        ? undefined
        : ModelConfigSchema.parse(JSON.parse(row.model_config_json) as unknown),
  };
}
