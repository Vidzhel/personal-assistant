import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    return deps.sessionManager.getProjectSessions(req.params.id);
  });

  // Get or create the active session for a project
  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    return deps.sessionManager.getOrCreateSession(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Not found' });
    return session;
  });

  // Get messages for a session
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/sessions/:id/messages', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;

    return deps.messageStore.getMessages(req.params.id, { limit, offset });
  });
}
