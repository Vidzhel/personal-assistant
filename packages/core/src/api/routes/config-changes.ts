import type { FastifyInstance, FastifyReply } from 'fastify';
import { createLogger, mapConfigChangeRow } from '@raven/shared';
import type {
  ConfigChangeResolver,
  DatabaseInterface,
  EventBusInterface,
  PendingConfigChangeRow,
} from '@raven/shared';

export type { ConfigChangeResolver };

const log = createLogger('api:config-changes');

const HTTP_STATUS = { BAD_REQUEST: 400, NOT_FOUND: 404, NOT_IMPLEMENTED: 501 } as const;

export interface ConfigChangesRouteDeps {
  db: DatabaseInterface;
  eventBus: EventBusInterface;
  resolver?: ConfigChangeResolver;
}

// eslint-disable-next-line max-lines-per-function -- route registration function
export function registerConfigChangesRoutes(
  app: FastifyInstance,
  deps: ConfigChangesRouteDeps,
): void {
  // GET /api/config-changes — list pending/recent changes
  app.get<{
    Querystring: { status?: string; limit?: string };
  }>('/api/config-changes', async (req) => {
    const status = req.query.status;
    const DEFAULT_LIMIT = 50;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;

    if (status) {
      const rows = deps.db.all<PendingConfigChangeRow>(
        'SELECT * FROM pending_config_changes WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        status,
        limit,
      );
      return rows.map(mapRow);
    }

    const rows = deps.db.all<PendingConfigChangeRow>(
      'SELECT * FROM pending_config_changes ORDER BY created_at DESC LIMIT ?',
      limit,
    );
    return rows.map(mapRow);
  });

  // GET /api/config-changes/:id — get change detail with diff
  app.get<{
    Params: { id: string };
  }>('/api/config-changes/:id', async (req, reply: FastifyReply) => {
    const row = deps.db.get<PendingConfigChangeRow>(
      'SELECT * FROM pending_config_changes WHERE id = ?',
      req.params.id,
    );
    if (!row) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Config change not found' });
    }
    return mapRow(row);
  });

  // POST /api/config-changes/:id/resolve — approve/reject change
  app.post<{
    Params: { id: string };
    Body: { resolution: 'apply' | 'discard' };
  }>('/api/config-changes/:id/resolve', async (req, reply: FastifyReply) => {
    const { resolution } = req.body as { resolution: 'apply' | 'discard' };

    if (!resolution || !['apply', 'discard'].includes(resolution)) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'resolution must be "apply" or "discard"' });
    }

    if (!deps.resolver) {
      return reply
        .status(HTTP_STATUS.NOT_IMPLEMENTED)
        .send({ error: 'Config change resolver not available' });
    }

    const result = deps.resolver.resolve(req.params.id, resolution);

    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.message });
    }

    return result;
  });

  log.info('Config changes routes registered');
}

const mapRow = mapConfigChangeRow;
