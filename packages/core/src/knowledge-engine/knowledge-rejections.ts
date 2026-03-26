import crypto from 'node:crypto';
import { getDb } from '../db/database.ts';

interface RecordRejectionInput {
  projectId: string;
  sessionId: string;
  contentHash: string;
  reason?: string;
}

export function recordKnowledgeRejection(input: RecordRejectionInput): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_rejections (id, project_id, session_id, content_hash, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.projectId,
    input.sessionId,
    input.contentHash,
    input.reason ?? null,
    now,
  );
}

export function isContentRejected(projectId: string, contentHash: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM knowledge_rejections WHERE project_id = ? AND content_hash = ? LIMIT 1')
    .get(projectId, contentHash);
  return !!row;
}
