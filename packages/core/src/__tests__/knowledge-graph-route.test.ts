import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus/event-bus.ts';
import { registerKnowledgeRoutes } from '../api/routes/knowledge.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { IngestionProcessor } from '../knowledge-engine/ingestion.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

function projectContext(id: string): string {
  return `---\nravenProject:\n  version: 1\n  id: ${id}\n---\n# ${id}\n`;
}

describe('knowledge graph project guard', () => {
  let root: string;
  let projectsDir: string;
  let registry: ProjectRegistry;
  let workspaceStore: ReturnType<typeof createProjectWorkspaceStore>;
  let app: ReturnType<typeof Fastify>;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-knowledge-graph-route-'));
    projectsDir = join(root, 'projects');
    const projectDir = join(projectsDir, 'alpha');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'context.md'), projectContext('alpha'));

    registry = new ProjectRegistry();
    await registry.load(projectsDir);
    workspaceStore = createProjectWorkspaceStore({
      projectsDir,
      projectRegistry: registry,
      projectRoot: root,
    });

    query = vi.fn().mockResolvedValue([]);
    const neo4j = { query } as unknown as Neo4jClient;
    app = Fastify({ logger: false });
    registerKnowledgeRoutes(app, {
      eventBus: new EventBus(),
      knowledgeStore: {} as KnowledgeStore,
      ingestionProcessor: {} as IngestionProcessor,
      neo4j,
      projectRegistry: registry,
      workspaceStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when the current context changes during a graph read', async () => {
    let releaseQuery!: () => void;
    query.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseQuery = () => resolve([]);
        }),
    );

    const pending = app.inject({
      method: 'GET',
      url: '/api/knowledge/graph?projectId=alpha',
    });
    await vi.waitFor(() => expect(releaseQuery).toEqual(expect.any(Function)));
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: beta\n---\n',
    );
    releaseQuery();

    const response = await pending;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Project not found' });
  });

  it('fails closed when registry health is unavailable', async () => {
    vi.spyOn(registry, 'assertHealthy').mockImplementation(() => {
      throw new Error('reload failed');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/knowledge/graph?projectId=alpha',
    });
    expect(response.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a current project with its optional workspace manifest absent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/knowledge/graph?projectId=alpha',
    });
    expect(response.statusCode).toBe(200);
  });
});
