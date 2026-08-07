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
  // deleted (Phase 2). L22: zero web callers remain (grepped — the dashboard
  // now reads /api/skills exclusively). Kept as a 410 tombstone rather than
  // deleted outright, so any external/out-of-tree caller still gets "gone
  // for good" instead of a transient, retry-worthy 404.
  app.get('/api/suites', async (_req, reply) =>
    reply.status(HTTP_STATUS.GONE).send({ error: 'Suites have been retired — use /api/skills.' }),
  );
}

function listLibrarySkills(deps: ApiDeps): LibrarySkillSummary[] {
  const library = deps.capabilityLibrary;
  if (!library) return [];

  const permissionEngine = deps.permissionEngine;

  return library.getSkillNames().map((name) => {
    const skill = library.getSkill(name);
    return {
      name,
      description: skill?.config.description ?? '',
      domain: skill?.domain ?? '',
      mcps: skill?.config.mcps ?? [],
      // M10: report the EFFECTIVE tier (permissions.json overrides applied),
      // same source of truth as /api/permissions/catalog — not the skill's
      // bare declared default, which silently diverges from reality once an
      // override exists.
      actions: (skill?.config.actions ?? []).map((a) => ({
        name: a.name,
        tier: permissionEngine?.resolveTier(a.name) ?? a.defaultTier,
      })),
      model: skill?.config.model,
    };
  });
}
