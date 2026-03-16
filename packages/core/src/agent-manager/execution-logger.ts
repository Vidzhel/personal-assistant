import type Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';
import type { AgentTask } from '@raven/shared';

const log = createLogger('execution-logger');

const DEFAULT_QUERY_LIMIT = 50;

export interface TaskRecord {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: string;
  priority: string;
  result?: string;
  durationMs?: number;
  errors?: string[];
  blocked: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskQueryOpts {
  skillName?: string;
  status?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface TaskStats {
  total1h: number;
  succeeded1h: number;
  failed1h: number;
  avgDurationMs: number | null;
  lastTaskAt: string | null;
}

export interface ExecutionLogger {
  logTaskStart: (task: AgentTask) => void;
  logTaskComplete: (task: AgentTask) => void;
  queryTasks: (opts: TaskQueryOpts) => TaskRecord[];
  getTaskById: (id: string) => TaskRecord | undefined;
  getTaskStats: (sinceMs: number) => TaskStats;
}

interface AgentTaskRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  skill_name: string;
  action_name: string | null;
  prompt: string;
  status: string;
  priority: string;
  result: string | null;
  duration_ms: number | null;
  errors: string | null;
  blocked: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function epochToIso(epoch: number | null): string | undefined {
  if (epoch === null || epoch === undefined) return undefined;
  return new Date(epoch).toISOString();
}

function safeParseErrors(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [String(parsed)];
  } catch {
    return [json];
  }
}

function rowToTaskRecord(row: AgentTaskRow): TaskRecord {
  return {
    id: row.id,
    ...(row.session_id !== null && { sessionId: row.session_id }),
    ...(row.project_id !== null && { projectId: row.project_id }),
    skillName: row.skill_name,
    ...(row.action_name !== null && { actionName: row.action_name }),
    prompt: row.prompt,
    status: row.status,
    priority: row.priority,
    ...(row.result !== null && { result: row.result }),
    ...(row.duration_ms !== null && { durationMs: row.duration_ms }),
    ...(row.errors !== null && { errors: safeParseErrors(row.errors) }),
    blocked: row.blocked === 1,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.started_at !== null && { startedAt: epochToIso(row.started_at) }),
    ...(row.completed_at !== null && { completedAt: epochToIso(row.completed_at) }),
  };
}

interface StatsRow {
  total: number;
  succeeded: number;
  failed: number;
  avg_duration_ms: number | null;
  last_task_at: number | null;
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes all store methods
export function createExecutionLogger(deps: { db: Database.Database }): ExecutionLogger {
  const { db } = deps;

  return {
    logTaskStart(task: AgentTask): void {
      db.prepare(
        `INSERT INTO agent_tasks (id, session_id, project_id, skill_name, action_name, prompt, status, priority, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.sessionId ?? null,
        task.projectId ?? null,
        task.skillName,
        task.actionName ?? null,
        task.prompt,
        task.status,
        task.priority,
        task.createdAt,
        task.startedAt ?? null,
      );
      log.debug(`Logged task start: ${task.id}`);
    },

    logTaskComplete(task: AgentTask): void {
      db.prepare(
        `UPDATE agent_tasks
         SET status = ?, result = ?, duration_ms = ?, errors = ?, completed_at = ?, blocked = ?
         WHERE id = ?`,
      ).run(
        task.status,
        task.result ?? null,
        task.durationMs ?? null,
        task.errors ? JSON.stringify(task.errors) : null,
        task.completedAt ?? null,
        task.status === 'blocked' ? 1 : 0,
        task.id,
      );
      log.debug(`Logged task complete: ${task.id} (${task.status})`);
    },

    queryTasks(opts: TaskQueryOpts): TaskRecord[] {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.skillName) {
        conditions.push('skill_name = ?');
        params.push(opts.skillName);
      }
      if (opts.status) {
        conditions.push('status = ?');
        params.push(opts.status);
      }
      if (opts.sessionId) {
        conditions.push('session_id = ?');
        params.push(opts.sessionId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
      const offset = opts.offset ?? 0;

      const rows = db
        .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as AgentTaskRow[];

      return rows.map(rowToTaskRecord);
    },

    getTaskById(id: string): TaskRecord | undefined {
      const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as
        | AgentTaskRow
        | undefined;
      return row ? rowToTaskRecord(row) : undefined;
    },

    getTaskStats(sinceMs: number): TaskStats {
      const cutoff = Date.now() - sinceMs;
      const row = db
        .prepare(
          `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration_ms,
            MAX(completed_at) as last_task_at
          FROM agent_tasks
          WHERE completed_at > ?`,
        )
        .get(cutoff) as StatsRow;

      return {
        total1h: row.total,
        succeeded1h: row.succeeded,
        failed1h: row.failed,
        avgDurationMs: row.avg_duration_ms !== null ? Math.round(row.avg_duration_ms) : null,
        lastTaskAt: row.last_task_at !== null ? new Date(row.last_task_at).toISOString() : null,
      };
    },
  };
}
