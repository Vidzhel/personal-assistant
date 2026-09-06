import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HTTP_STATUS } from '@raven/shared';
import type { ModelCatalog } from '../../agent-registry/model-catalog.ts';

const ModelQuerySchema = z.object({ refresh: z.enum(['true', 'false']).optional() });

export function registerModelRoutes(app: FastifyInstance, catalog?: ModelCatalog): void {
  app.get('/api/models', async (request, reply) => {
    const parsed = ModelQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid model catalog query' });
    }
    if (!catalog) {
      return reply
        .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
        .send({ error: 'Model catalog unavailable' });
    }
    const current = catalog.getSnapshot();
    return current.stale || parsed.data.refresh === 'true' ? await catalog.refresh() : current;
  });
}
