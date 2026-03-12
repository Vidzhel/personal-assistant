import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

export function registerSuiteRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // Keep /api/skills as an alias for backward compatibility with the dashboard
  app.get('/api/skills', async () => listSuites(deps));
  app.get('/api/suites', async () => listSuites(deps));
}

function listSuites(deps: ApiDeps): unknown[] {
  const suites = deps.suiteRegistry.getAllSuites();
  return suites.map((s) => ({
    name: s.manifest.name,
    displayName: s.manifest.displayName,
    version: s.manifest.version,
    description: s.manifest.description,
    capabilities: s.manifest.capabilities,
    mcpServers: Object.keys(s.mcpServers),
    agentDefinitions: s.agents.map((a) => a.name),
  }));
}
