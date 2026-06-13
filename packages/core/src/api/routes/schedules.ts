import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';

export function registerScheduleRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/schedules', async () => {
    return deps.scheduleEngine.list();
  });

  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/schedules/:id',
    async (req, reply) => {
      const ok = deps.scheduleEngine.setEnabled(req.params.id, req.body.enabled === true);
      if (!ok) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Schedule not found' });
      return { id: req.params.id, enabled: req.body.enabled === true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/schedules/:id/trigger', async (req, reply) => {
    const ok = await deps.scheduleEngine.runNow(req.params.id);
    if (!ok) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Schedule not found' });
    return { triggered: true };
  });
}
