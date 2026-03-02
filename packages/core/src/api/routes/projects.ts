import type { FastifyInstance } from 'fastify';
import { generateId } from '@raven/shared';
import { getDb } from '../../db/database.js';

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows.map(parseProjectRow);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return parseProjectRow(row);
  });

  app.post<{ Body: { name: string; description?: string; skills?: string[]; systemPrompt?: string } }>(
    '/api/projects',
    async (req) => {
      const db = getDb();
      const now = Date.now();
      const id = generateId();
      const { name, description, skills, systemPrompt } = req.body;

      db.prepare(
        'INSERT INTO projects (id, name, description, skills, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, name, description ?? null, JSON.stringify(skills ?? []), systemPrompt ?? null, now, now);

      return { id, name, description, skills: skills ?? [], systemPrompt, createdAt: now, updatedAt: now };
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; skills?: string[]; systemPrompt?: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      const db = getDb();
      const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const updates = req.body;
      const now = Date.now();
      db.prepare(
        'UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), skills = COALESCE(?, skills), system_prompt = COALESCE(?, system_prompt), updated_at = ? WHERE id = ?',
      ).run(
        updates.name ?? null,
        updates.description ?? null,
        updates.skills ? JSON.stringify(updates.skills) : null,
        updates.systemPrompt ?? null,
        now,
        req.params.id,
      );

      return { success: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { success: true };
  });
}

function parseProjectRow(row: unknown) {
  const r = row as { id: string; name: string; description: string | null; skills: string; system_prompt: string | null; created_at: number; updated_at: number };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    skills: JSON.parse(r.skills),
    systemPrompt: r.system_prompt,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
