import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';
import type { StoredMessage } from '../../session-manager/message-store.ts';

const EnqueueBodySchema = z.object({
  message: z.string().min(1),
});

const HEADING_PREFIX_LENGTH = 4;

interface ParsedReference {
  bubbleId: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

interface EnrichedReference extends ParsedReference {
  domains: string[];
  permanence: string;
}

interface ParseState {
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

function classifyLine(line: string, state: ParseState): ParseState {
  if (line.startsWith('### ')) {
    return { title: line.slice(HEADING_PREFIX_LENGTH), snippet: '', score: 0, tags: [] };
  }
  if (line.startsWith('Tags:')) {
    const tagsMatch = /^Tags:\s*(.+?)\s*\|/.exec(line);
    const scoreMatch = /Score:\s*([\d.]+)/.exec(line);
    const rawTags = tagsMatch ? tagsMatch[1] : '';
    const tags =
      rawTags === 'none'
        ? []
        : rawTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    return { ...state, score, tags };
  }
  if (!line.startsWith('[ref:') && line.trim()) {
    return { ...state, snippet: line };
  }
  return state;
}

function parseContextMessage(msg: StoredMessage): { taskId: string; refs: ParsedReference[] } {
  const taskId = msg.taskId ?? 'unknown';
  const refs: ParsedReference[] = [];
  const lines = msg.content.split('\n');
  let state: ParseState = { title: '', snippet: '', score: 0, tags: [] };

  for (const line of lines) {
    state = classifyLine(line, state);
    const refMatch = /\[ref:\s*([^\]]+)\]/.exec(line);
    if (refMatch) {
      const bubbleId = refMatch[1].trim();
      if (!refs.some((r) => r.bubbleId === bubbleId)) {
        refs.push({
          bubbleId,
          title: state.title,
          snippet: state.snippet,
          score: state.score,
          tags: state.tags,
        });
      }
    }
  }
  return { taskId, refs };
}

function parseReferencesFromContextMessages(
  contextMessages: StoredMessage[],
): Record<string, ParsedReference[]> {
  const grouped: Record<string, ParsedReference[]> = {};

  for (const msg of contextMessages) {
    const { taskId, refs } = parseContextMessage(msg);
    if (!grouped[taskId]) grouped[taskId] = [];
    grouped[taskId].push(...refs);
  }

  return grouped;
}

async function enrichReferences(
  grouped: Record<string, ParsedReference[]>,
  deps: ApiDeps,
): Promise<Record<string, EnrichedReference[]>> {
  if (!deps.knowledgeStore) {
    const result: Record<string, EnrichedReference[]> = {};
    for (const [taskId, refs] of Object.entries(grouped)) {
      result[taskId] = refs.map((r) => ({ ...r, domains: [], permanence: 'normal' }));
    }
    return result;
  }

  const allBubbleIds = new Set<string>();
  for (const refs of Object.values(grouped)) {
    for (const r of refs) allBubbleIds.add(r.bubbleId);
  }

  const bubbleMetadata = new Map<string, { domains: string[]; permanence: string }>();
  for (const bubbleId of allBubbleIds) {
    const bubble = await deps.knowledgeStore.getById(bubbleId);
    if (bubble) {
      bubbleMetadata.set(bubbleId, { domains: bubble.domains, permanence: bubble.permanence });
    }
  }

  const result: Record<string, EnrichedReference[]> = {};
  for (const [taskId, refs] of Object.entries(grouped)) {
    result[taskId] = refs.map((r) => {
      const meta = bubbleMetadata.get(r.bubbleId);
      return {
        ...r,
        domains: meta?.domains ?? [],
        permanence: meta?.permanence ?? 'normal',
      };
    });
  }
  return result;
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

  // Get knowledge references injected during a session, grouped by task (enriched with metadata)
  app.get<{ Params: { id: string } }>('/api/sessions/:id/references', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });

    const messages = deps.messageStore.getMessages(req.params.id);
    const contextMessages = messages.filter((m) => m.role === 'context');
    const grouped = parseReferencesFromContextMessages(contextMessages);
    const enriched = await enrichReferences(grouped, deps);

    return { references: enriched };
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

  // Enqueue a message to a session — will be processed as the next user turn
  app.post<{ Params: { id: string } }>('/api/sessions/:id/enqueue', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Session not found' });
    }

    const result = EnqueueBodySchema.safeParse(req.body);
    if (!result.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid body', details: result.error.issues });
    }

    // Check if session has an active agent — reject if no agent is running or queued
    const activeTasks = deps.agentManager.getActiveTasks();
    const hasActiveAgent = [...activeTasks.running, ...activeTasks.queued].some(
      (t) => t.sessionId === req.params.id,
    );
    if (!hasActiveAgent) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'No active agent on this session — use chat instead' });
    }

    deps.messageStore.appendMessage(req.params.id, {
      role: 'user',
      content: result.data.message,
    });

    return { status: 'queued', sessionId: req.params.id };
  });
}
