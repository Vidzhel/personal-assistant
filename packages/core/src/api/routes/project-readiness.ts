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
  app.get<{ Params: { id: string } }>('/api/projects/:id/readiness', async (request, reply) => {
    try {
      if (!hasCurrentProject(deps, request.params.id)) {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
      }
      return reply.send(inspectProjectReadiness(deps, request.params.id));
    } catch (error) {
      return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
        error: sanitizeReadinessError(error),
      });
    }
  });
}
