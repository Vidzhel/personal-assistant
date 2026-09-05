import type { FastifyInstance } from 'fastify';
import { generateId, HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';
import { ChatRequestSchema, validateChatTarget } from '../../session-manager/chat-validation.ts';

export function registerChatRoute(
  app: FastifyInstance,
  deps: Pick<ApiDeps, 'eventBus' | 'sessionManager' | 'projectRegistry'>,
): void {
  app.post<{
    Params: { id: string };
    Body: { message: string; sessionId?: string };
  }>('/api/projects/:id/chat', async (req, reply) => {
    const { id: projectId } = req.params;
    const parsed = ChatRequestSchema.safeParse({ ...req.body, projectId });
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid chat message' });
    }
    const { message, sessionId } = parsed.data;
    const target = validateChatTarget(deps.sessionManager, projectId, {
      sessionId,
      projectRegistry: deps.projectRegistry,
    });
    if (!target.ok) return reply.status(target.statusCode).send({ error: target.error });

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'api',
      type: 'user:chat:message',
      payload: { projectId, message, sessionId },
    });

    return { status: 'queued' };
  });
}
