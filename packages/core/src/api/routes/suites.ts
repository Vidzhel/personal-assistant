import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';
import {
  SuiteScaffoldInputSchema,
  type SuiteScaffolder,
} from '../../suite-registry/suite-scaffolder.ts';

const HTTP_STATUS = { OK_CREATED: 201, BAD_REQUEST: 400 } as const;

export function registerSuiteRoutes(
  app: FastifyInstance,
  deps: ApiDeps & { suiteScaffolder?: SuiteScaffolder },
): void {
  // Keep /api/skills as an alias for backward compatibility with the dashboard
  app.get('/api/skills', async () => listSuites(deps));
  app.get('/api/suites', async () => listSuites(deps));

  // POST /api/suites — scaffold a new lightweight suite
  if (deps.suiteScaffolder) {
    const scaffolder = deps.suiteScaffolder;
    app.post('/api/suites', async (req, reply) => {
      const result = SuiteScaffoldInputSchema.safeParse(req.body);
      if (!result.success) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          error: 'Invalid suite input',
          details: result.error.issues,
        });
      }

      try {
        const { suitePath } = scaffolder.scaffoldSuite(result.data);
        return reply.status(HTTP_STATUS.OK_CREATED).send({
          name: result.data.name,
          displayName: result.data.displayName,
          description: result.data.description,
          suitePath,
        });
      } catch (err) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message });
      }
    });
  }
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
