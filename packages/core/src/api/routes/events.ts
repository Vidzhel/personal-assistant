import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/database.ts';

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

interface EventRow {
  id: string;
  type: string;
  source: string;
  project_id: string | null;
  payload: string;
  timestamp: number;
}

interface EventQueryParams {
  since?: string;
  type?: string;
  projectId?: string;
  limit?: string;
  source?: string;
}

function buildEventQuery(query: EventQueryParams): {
  where: string;
  params: unknown[];
  limit: number;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.since) {
    conditions.push('timestamp >= ?');
    params.push(Number(query.since));
  }
  if (query.type) {
    conditions.push('type = ?');
    params.push(query.type);
  }
  if (query.projectId) {
    conditions.push('project_id = ?');
    params.push(query.projectId);
  }
  if (query.source) {
    conditions.push('source = ?');
    params.push(query.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(query.limit ?? DEFAULT_EVENT_LIMIT), MAX_EVENT_LIMIT);
  return { where, params, limit };
}

function mapEventRow(r: EventRow): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    type: r.type,
    source: r.source,
    projectId: r.project_id,
    payload,
    timestamp: r.timestamp,
  };
}

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/api/events/sources', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT source FROM events ORDER BY source').all() as Array<{
      source: string;
    }>;
    return rows.map((r) => r.source);
  });

  app.get('/api/events/types', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT type FROM events ORDER BY type').all() as Array<{
      type: string;
    }>;
    return rows.map((r) => r.type);
  });

  app.get<{ Querystring: EventQueryParams }>('/api/events', async (req) => {
    const db = getDb();
    const { where, params, limit } = buildEventQuery(req.query);
    const rows = db
      .prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit);
    return (rows as EventRow[]).map(mapEventRow);
  });
}
