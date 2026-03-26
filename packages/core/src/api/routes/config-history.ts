import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import {
  getConfigCommits,
  getCommitDetail,
  revertConfigFile,
} from '../../config-history/git-history.ts';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ConfigHistoryDeps {
  eventBus: EventBus;
}

export function registerConfigHistoryRoutes(app: FastifyInstance, deps: ConfigHistoryDeps): void {
  // GET /api/config-history — paginated list of config commits
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>('/api/config-history', async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const commits = await getConfigCommits(limit, offset);
    return { commits, limit, offset };
  });

  // GET /api/config-history/:hash — commit detail with diffs
  app.get<{
    Params: { hash: string };
  }>('/api/config-history/:hash', async (request, reply) => {
    try {
      const detail = await getCommitDetail(request.params.hash);
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/config-history/:hash/revert — revert a commit or specific file
  app.post<{
    Params: { hash: string };
    Body: { file?: string };
  }>('/api/config-history/:hash/revert', async (request, reply) => {
    try {
      const result = await revertConfigFile(request.params.hash, deps.eventBus, request.body?.file);

      if (!result.success) {
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(result);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });
}
