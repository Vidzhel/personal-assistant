import { type SessionReference } from '@raven/shared';
import { getDb } from '../db/database.ts';
import crypto from 'node:crypto';

export function createReference(
  sourceSessionId: string,
  targetSessionId: string,
  context?: string,
): SessionReference {
  const db = getDb();
  const ref: SessionReference = {
    id: crypto.randomUUID(),
    sourceSessionId,
    targetSessionId,
    context,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    'INSERT INTO session_references (id, source_session_id, target_session_id, context, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(ref.id, ref.sourceSessionId, ref.targetSessionId, ref.context ?? null, ref.createdAt);

  return ref;
}

export function getReferencesFrom(sessionId: string): SessionReference[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM session_references WHERE source_session_id = ? ORDER BY created_at')
    .all(sessionId) as ReferenceRow[];
  return rows.map(rowToReference);
}

export function getReferencesTo(sessionId: string): SessionReference[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM session_references WHERE target_session_id = ? ORDER BY created_at')
    .all(sessionId) as ReferenceRow[];
  return rows.map(rowToReference);
}

export function getAllReferences(sessionId: string): {
  from: SessionReference[];
  to: SessionReference[];
} {
  return {
    from: getReferencesFrom(sessionId),
    to: getReferencesTo(sessionId),
  };
}

export function deleteReference(referenceId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM session_references WHERE id = ?').run(referenceId);
  return result.changes > 0;
}

export function buildSessionReferencesContext(sessionId: string): string | undefined {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sr.context, s.name, s.summary
       FROM session_references sr
       JOIN sessions s ON s.id = sr.target_session_id
       WHERE sr.source_session_id = ?
       ORDER BY sr.created_at`,
    )
    .all(sessionId) as Array<{
    context: string | null;
    name: string | null;
    summary: string | null;
  }>;

  if (rows.length === 0) return undefined;

  const lines = rows.map((row) => {
    const name = row.name ?? 'Unnamed session';
    const summary = row.summary ?? 'No summary available';
    let line = `- **${name}**: ${summary}`;
    if (row.context) {
      line += `\n  Context: ${row.context}`;
    }
    return line;
  });

  return lines.join('\n');
}

interface ReferenceRow {
  id: string;
  source_session_id: string;
  target_session_id: string;
  context: string | null;
  created_at: string;
}

function rowToReference(row: ReferenceRow): SessionReference {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    context: row.context ?? undefined,
    createdAt: row.created_at,
  };
}
