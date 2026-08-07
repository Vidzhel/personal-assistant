import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

const HTTP_STATUS = { GONE: 410 } as const;

export interface LibrarySkillSummary {
  name: string;
  description: string;
  domain: string;
  mcps: string[];
  actions: Array<{ name: string; tier: string }>;
  model?: string;
}

export function registerSuiteRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // /api/skills serves the capability library — the sole capability system.
  app.get('/api/skills', async () => listLibrarySkills(deps));

  // /api/suites served suite manifests before the suites/ stratum was
  // deleted (Phase 2). Retired: 410 tells any remaining caller (the web
  // dashboard currently still calls this at runtime — see Task 4) that the
  // resource is gone for good, rather than a transient 404.
  app.get('/api/suites', async (_req, reply) =>
    reply.status(HTTP_STATUS.GONE).send({ error: 'Suites have been retired — use /api/skills.' }),
  );
}

function listLibrarySkills(deps: ApiDeps): LibrarySkillSummary[] {
  const library = deps.capabilityLibrary;
  if (!library) return [];

  return library.getSkillNames().map((name) => {
    const skill = library.getSkill(name);
    return {
      name,
      description: skill?.config.description ?? '',
      domain: skill?.domain ?? '',
      mcps: skill?.config.mcps ?? [],
      actions: (skill?.config.actions ?? []).map((a) => ({ name: a.name, tier: a.defaultTier })),
      model: skill?.config.model,
    };
  });
}
