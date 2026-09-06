import type { FastifyInstance } from 'fastify';
import { generateId, HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';
import { ChatRequestSchema, validateChatTarget } from '../../session-manager/chat-validation.ts';

export function registerChatRoute(
  app: FastifyInstance,
  deps: Pick<
    ApiDeps,
    'eventBus' | 'sessionManager' | 'projectRegistry' | 'resolveModel' | 'prepareModel'
  >,
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
    const { sessionId, modelConfig } = parsed.data;
    const target = validateChatTarget(deps.sessionManager, projectId, {
      sessionId,
      projectRegistry: deps.projectRegistry,
    });
    if (!target.ok) return reply.status(target.statusCode).send({ error: target.error });
    try {
      await deps.prepareModel?.({ projectId, sessionId: target.session?.id, turn: modelConfig });
      deps.resolveModel?.({ projectId, sessionId: target.session?.id, turn: modelConfig });
    } catch (error) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: String(error) });
    }

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'api',
      type: 'user:chat:message',
      payload: parsed.data,
    });

    return { status: 'queued' };
  });
}
