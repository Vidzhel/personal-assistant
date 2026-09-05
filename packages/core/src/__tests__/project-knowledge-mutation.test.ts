import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDatabase } from '../db/database.ts';
import { registerProjectKnowledgeRoutes } from '../api/routes/project-knowledge.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  createManagedProject,
  deleteManagedProject,
  type ProjectLifecycleDeps,
} from '../project-manager/project-lifecycle.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('knowledge mutations coordinate with project archive/delete', () => {
  let root: string;
  let app: ReturnType<typeof Fastify>;
  let deps: ProjectLifecycleDeps;
  let project: Awaited<ReturnType<typeof createManagedProject>>;
  let linked: boolean;
  let run: ReturnType<typeof vi.fn>;
  let insert: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-knowledge-mutation-'));
    const fixture = createRavenTestFixture(root);
    initDatabase(fixture.dbPath);
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(fixture.projectsDir);
    linked = false;
    run = vi.fn(async () => {
      linked = true;
    });
    insert = vi.fn(async () => ({ id: 'fixture-bubble' }));
    const neo4j = {
      run,
      query: vi.fn(async () => (linked ? [{ id: 'fixture-bubble' }] : [])),
    } as unknown as Neo4jClient;
    deps = {
      db: getDb(),
      projectRegistry,
      projectsDir: fixture.projectsDir,
      neo4jClient: neo4j,
      scaffoldingApi: createScaffoldingApi({
        projectsDir: fixture.projectsDir,
        projectRegistry,
        agentYamlStore: createAgentYamlStore(),
      }),
    };
    project = await createManagedProject(deps, { name: 'Knowledge fixture', systemAccess: 'none' });
    app = Fastify();
    registerProjectKnowledgeRoutes(app, {
      projectsDir: fixture.projectsDir,
      neo4j,
      knowledgeStore: { insert } as unknown as KnowledgeStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  function submit(kind: 'link' | 'proposal') {
    return app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/${kind === 'link' ? 'knowledge-links' : 'knowledge-proposals/approve'}`,
      payload:
        kind === 'link'
          ? { bubbleId: 'fixture-bubble' }
          : { action: 'approve', content: 'Fixture knowledge' },
    });
  }

  it.each(['link', 'proposal'] as const)(
    'rechecks the parent after a queued %s request acquires the deletion lock',
    async (kind) => {
      const acquired = deferred();
      const release = deferred();
      const deletion = withProjectMutation(deps.projectsDir, async () => {
        acquired.resolve();
        await release.promise;
        return deleteManagedProject(deps, project.id);
      });
      await acquired.promise;
      const pending = Promise.resolve(submit(kind));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(run).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await deletion;
      const response = await pending;
      expect(response.statusCode).toBe(404);
      expect(run).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(existsSync(join(deps.projectsDir, project.fsPath!))).toBe(false);
    },
  );

  it.each(['link', 'proposal'] as const)(
    'holds the lock for the complete %s write so deletion observes the resulting link',
    async (kind) => {
      const entered = deferred();
      const release = deferred();
      const slowWrite = async () => {
        entered.resolve();
        await release.promise;
        if (kind === 'link') linked = true;
        return { id: 'fixture-bubble' };
      };
      if (kind === 'link') run.mockImplementationOnce(slowWrite);
      else insert.mockImplementationOnce(slowWrite);
      const pending = Promise.resolve(submit(kind));
      await entered.promise;
      let deletionEntered = false;
      const deletion = withProjectMutation(deps.projectsDir, async () => {
        deletionEntered = true;
        return deleteManagedProject(deps, project.id);
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(deletionEntered).toBe(false);
      } finally {
        release.resolve();
      }
      expect((await pending).statusCode).toBe(201);
      expect(await deletion).toMatchObject({
        statusCode: 409,
        message: 'Project has linked knowledge',
      });
      expect(getDb().prepare('SELECT id FROM projects WHERE id = ?').get(project.id)).toBeDefined();
      expect(existsSync(join(deps.projectsDir, project.fsPath!, 'context.md'))).toBe(true);
    },
  );

  it('rejects missing parents for link reads/removals and proposal rejection without graph or SQLite writes', async () => {
    await deleteManagedProject(deps, project.id);
    for (const options of [
      { method: 'GET' as const, url: `/api/projects/${project.id}/knowledge-links` },
      {
        method: 'DELETE' as const,
        url: `/api/projects/${project.id}/knowledge-links/fixture-bubble`,
      },
      {
        method: 'POST' as const,
        url: `/api/projects/${project.id}/knowledge-proposals/reject`,
        payload: { action: 'reject', contentHash: 'fixture-hash' },
      },
    ])
      expect((await app.inject(options)).statusCode).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM knowledge_rejections WHERE project_id = ?')
        .get(project.id),
    ).toEqual({ count: 0 });
  });
});
