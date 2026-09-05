import { z } from 'zod';
import { HTTP_STATUS, type AgentSession } from '@raven/shared';
import { getDb } from '../db/database.ts';
import type { SessionManager } from './session-manager.ts';

export const CHAT_REQUEST_ID_MAX_LENGTH = 128;

export const ChatRequestSchema = z.object({
  requestId: z.string().min(1).max(CHAT_REQUEST_ID_MAX_LENGTH).optional(),
  projectId: z.string().min(1),
  message: z.string().min(1),
  // The dashboard sends null while its initial session is loading.
  sessionId: z
    .string()
    .min(1)
    .nullish()
    .transform((id) => id ?? undefined),
});

type ChatTarget =
  { ok: true; session?: AgentSession } | { ok: false; statusCode: number; error: string };

/** Read-only preflight, also enforced by the orchestrator before any chat writes. */
export function validateChatTarget(
  sessionManager: SessionManager,
  projectId: string,
  sessionId: string | undefined,
): ChatTarget {
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
    return { ok: false, statusCode: HTTP_STATUS.NOT_FOUND, error: 'Project not found' };
  }
  if (sessionId === undefined) return { ok: true };

  const session = sessionManager.getSession(sessionId);
  if (!session || session.projectId !== projectId) {
    return {
      ok: false,
      statusCode: HTTP_STATUS.NOT_FOUND,
      error: 'Session not found in this project. Select a session or start a new one.',
    };
  }
  return { ok: true, session };
}
