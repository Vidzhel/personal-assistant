import type { FastifyInstance } from 'fastify';
import type { PermissionEngine } from '../../permission-engine/permission-engine.ts';

export function registerPermissionRoutes(
  app: FastifyInstance,
  permissionEngine: PermissionEngine,
): void {
  // GET /api/permissions/catalog — read-only view of every declared action,
  // its resolved tier (config/permissions.json overrides win — see
  // PermissionEngine.getActionCatalog), and where it came from.
  app.get('/api/permissions/catalog', async () => permissionEngine.getActionCatalog());
}
