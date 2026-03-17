import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';
import type { StoredMessage } from '../../session-manager/message-store.ts';

const HEADING_PREFIX_LENGTH = 4;

interface ParsedReference {
  bubbleId: string;
  title: string;
  snippet: string;
}

function classifyLine(
  line: string,
  state: { title: string; snippet: string },
): { title: string; snippet: string } {
  if (line.startsWith('### ')) {
    return { title: line.slice(HEADING_PREFIX_LENGTH), snippet: '' };
  }
  if (!line.startsWith('Tags:') && !line.startsWith('[ref:') && line.trim()) {
    return { title: state.title, snippet: line };
  }
  return state;
}

function parseContextMessage(
  msg: StoredMessage,
  refPattern: RegExp,
): { taskId: string; refs: ParsedReference[] } {
  const taskId = msg.taskId ?? 'unknown';
  const refs: ParsedReference[] = [];
  const lines = msg.content.split('\n');
  let state = { title: '', snippet: '' };

  for (const line of lines) {
    state = classifyLine(line, state);
    const refMatch = refPattern.exec(line);
    if (refMatch) {
      const bubbleId = refMatch[1].trim();
      if (!refs.some((r) => r.bubbleId === bubbleId)) {
        refs.push({ bubbleId, title: state.title, snippet: state.snippet });
      }
    }
  }
  refPattern.lastIndex = 0;
  return { taskId, refs };
}

function parseReferencesFromContextMessages(
  contextMessages: StoredMessage[],
): Record<string, ParsedReference[]> {
  const refPattern = /\[ref:\s*([^\]]+)\]/g;
  const grouped: Record<string, ParsedReference[]> = {};

  for (const msg of contextMessages) {
    const { taskId, refs } = parseContextMessage(msg, refPattern);
    if (!grouped[taskId]) grouped[taskId] = [];
    grouped[taskId].push(...refs);
  }

  return grouped;
}

export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    return deps.sessionManager.getProjectSessions(req.params.id);
  });

  // Get or create the active session for a project
  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    return deps.sessionManager.getOrCreateSession(req.params.id);
  });

  // Force-create a new session (archives existing active sessions)
  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions/new', async (req) => {
    return deps.sessionManager.createSession(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return session;
  });

  // Debug: consolidated session data for investigation
  app.get<{ Params: { id: string } }>('/api/sessions/:id/debug', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });

    const messages = deps.messageStore.getMessages(req.params.id);
    const tasks = deps.executionLogger.queryTasks({ sessionId: req.params.id });
    const auditEntries = deps.auditLog.query({ sessionId: req.params.id });
    const rawMessages = deps.messageStore.getRawMessages(req.params.id);

    return { session, messages, tasks, auditEntries, rawMessages };
  });

  // Get knowledge references injected during a session, grouped by task
  app.get<{ Params: { id: string } }>('/api/sessions/:id/references', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });

    const messages = deps.messageStore.getMessages(req.params.id);
    const contextMessages = messages.filter((m) => m.role === 'context');
    const grouped = parseReferencesFromContextMessages(contextMessages);

    return { references: grouped };
  });

  // Get messages for a session
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/sessions/:id/messages', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;

    return deps.messageStore.getMessages(req.params.id, { limit, offset });
  });
}
