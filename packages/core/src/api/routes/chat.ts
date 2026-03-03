import type { FastifyInstance } from 'fastify';
import { generateId } from '@raven/shared';
import type { ApiDeps } from '../server.ts';

export function registerChatRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{
    Params: { id: string };
    Body: { message: string; sessionId?: string };
  }>('/api/projects/:id/chat', async (req) => {
    const { id: projectId } = req.params;
    const { message, sessionId } = req.body;

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
