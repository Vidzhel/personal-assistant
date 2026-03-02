import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/database.js';

export function registerEventRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      since?: string;
      type?: string;
      projectId?: string;
      limit?: string;
    };
  }>('/api/events', async (req) => {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (req.query.since) {
      conditions.push('timestamp >= ?');
      params.push(Number(req.query.since));
    }
    if (req.query.type) {
      conditions.push('type = ?');
      params.push(req.query.type);
    }
    if (req.query.projectId) {
      conditions.push('project_id = ?');
      params.push(req.query.projectId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit ?? 100), 500);

    const rows = db
      .prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit);

    return (rows as Array<{ id: string; type: string; source: string; project_id: string | null; payload: string; timestamp: number }>).map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source,
      projectId: r.project_id,
      payload: JSON.parse(r.payload),
      timestamp: r.timestamp,
    }));
  });
}
