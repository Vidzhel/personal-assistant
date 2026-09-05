import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import { getDb } from '../../db/database.ts';
import type { ApiDeps } from '../server.ts';
import {
  ProjectMutationError,
  withProjectMutation,
} from '../../project-manager/project-mutation.ts';
import { syncProjectCache } from '../../project-manager/project-sync.ts';
import {
  readProjectRecoveryReport,
  recoverProjectMutation,
  type RecoveryDeps,
} from '../../project-manager/project-recovery/journal.ts';

function recoveryDeps(deps: ApiDeps): Required<RecoveryDeps> {
  if (!deps.projectsDir || !deps.projectRegistry) {
    throw new ProjectMutationError(
      'Project definition storage is unavailable',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
    );
  }
  return { projectsDir: deps.projectsDir, projectRegistry: deps.projectRegistry, db: getDb() };
}

export function registerProjectRecoveryRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/api/definitions/reload', async (_request, reply) => {
    if (!deps.reloadRegistries) {
      throw new ProjectMutationError(
        'Definition reload is unavailable',
        HTTP_STATUS.SERVICE_UNAVAILABLE,
      );
    }
    const result = await deps.reloadRegistries();
    if (Object.values(result).some((loaded) => !loaded)) {
      return reply.status(HTTP_STATUS.CONFLICT).send({
        error: 'Some definitions could not reload; review the current diagnostics.',
        result,
      });
    }
    return result;
  });
  app.get('/api/project-recovery', async () => {
    const recovery = recoveryDeps(deps);
    return readProjectRecoveryReport(recovery.projectsDir);
  });
  app.post<{ Params: { mutationId: string } }>(
    '/api/project-recovery/:mutationId/recover',
    async (req) => {
      const recovery = recoveryDeps(deps);
      return withProjectMutation(recovery.projectsDir, async () => {
        const result = await recoverProjectMutation(recovery, req.params.mutationId);
        await recovery.projectRegistry.load(recovery.projectsDir);
        syncProjectCache(recovery);
        return result;
      });
    },
  );
}
