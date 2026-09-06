import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import {
  inspectProjectReadiness,
  resolveReadinessProjectPath,
  sanitizeReadinessError,
  type ProjectReadinessDeps,
} from '../../diagnostics/project-readiness.ts';

export type ProjectReadinessRouteDeps = ProjectReadinessDeps;

function hasCurrentProject(deps: ProjectReadinessRouteDeps, projectId: string): boolean {
  deps.projectRegistry.assertHealthy();
  return resolveReadinessProjectPath(deps, projectId) !== undefined;
}

export function registerProjectReadinessRoute(
  app: FastifyInstance,
  deps: ProjectReadinessRouteDeps,
): void {
  const active = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of active) controller.abort();
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/readiness', async (request, reply) => {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    active.add(controller);
    request.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    try {
      if (!hasCurrentProject(deps, request.params.id)) {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
      }
      return reply.send(await inspectProjectReadiness(deps, request.params.id, controller.signal));
    } catch (error) {
      return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
        error: sanitizeReadinessError(error),
      });
    } finally {
      active.delete(controller);
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
    }
  });
}
