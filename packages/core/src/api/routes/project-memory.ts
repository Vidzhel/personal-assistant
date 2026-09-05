import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { MemoryStore } from '../../agent-memory/memory-store.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';

/** Memory ownership is explicit even when the same agent works in several projects. */
export function registerProjectMemoryRoutes(app: FastifyInstance, store?: MemoryStore): void {
  void app.register(async (memoryApp) => {
    memoryApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectMutationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.send(error);
    });
    memoryApp.get<{ Params: { id: string } }>('/api/projects/:id/memory', async (req, reply) => {
      if (!store) {
        return reply
          .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
          .send({ error: 'Memory store not available' });
      }
      const projectId = req.params.id;
      const files = await store.list(projectId);
      return Promise.all(
        files.map(async (file) => ({ file, content: await store.read(projectId, file) })),
      );
    });
  });
}
