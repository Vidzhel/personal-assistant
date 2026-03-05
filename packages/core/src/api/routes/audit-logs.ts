import type { FastifyInstance } from 'fastify';
import { AuditLogFilterSchema } from '@raven/shared';
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
        .status(400)
        .send({ error: 'Invalid query parameters', details: result.error.flatten().fieldErrors });
    }

    return auditLog.query(result.data);
  });
}
