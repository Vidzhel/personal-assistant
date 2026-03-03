import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    return deps.sessionManager.getProjectSessions(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = deps.sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Not found' });
    return session;
  });
}
