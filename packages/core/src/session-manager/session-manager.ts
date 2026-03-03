import { createLogger, generateId, type AgentSession } from '@raven/shared';
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

  linkSdkSession(sessionId: string, sdkSessionId: string): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, sessionId);
  }

  updateStatus(sessionId: string, status: AgentSession['status']): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?').run(
      status,
      Date.now(),
      sessionId,
    );
  }

  getSession(sessionId: string): AgentSession | undefined {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getProjectSessions(projectId: string): AgentSession[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_active_at DESC')
      .all(projectId) as SessionRow[];
    return rows.map(rowToSession);
  }
}

interface SessionRow {
  id: string;
  sdk_session_id: string | null;
  project_id: string;
  status: string;
  created_at: number;
  last_active_at: number;
  turn_count: number;
  current_task_id: string | null;
}

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
  };
}
