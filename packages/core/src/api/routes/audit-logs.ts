import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditLogFilterSchema, HTTP_STATUS } from '@raven/shared';
import type { AuditLog } from '../../permission-engine/audit-log.ts';

export function registerAuditLogRoutes(app: FastifyInstance, auditLog: AuditLog): void {
  app.get<{
    Querystring: {
      skillName?: string;
      tier?: string;
      outcome?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/audit-logs', async (req, reply) => {
    const result = AuditLogFilterSchema.safeParse(req.query);
    if (!result.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid query parameters', details: z.treeifyError(result.error) });
    }

    return auditLog.query(result.data);
  });
}
