import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, ProjectDataSource, ProjectWorkspace } from '@raven/shared';
import { createRaven, type RavenInstance } from '../raven.ts';
import { getDb } from '../db/database.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('e2e: file-owned workspace configuration', () => {
  let root: string;
  let fixture: ReturnType<typeof createRavenTestFixture>;
  let raven: RavenInstance | undefined;

  async function boot(dbPath = fixture.dbPath): Promise<void> {
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      dbPath,
      skipSuites: true,
      agentBackend: async () => {
        throw new Error('Configuration must not dispatch a model');
      },
    });
    await raven.start();
  }

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://localhost:${raven!.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  }

  async function createProject(name: string): Promise<Project> {
    const response = await request('/api/projects', 'POST', { name });
    expect(response.status).toBe(200);
    return response.json() as Promise<Project>;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-workspace-config-'));
    fixture = createRavenTestFixture(root);
    await boot();
  });

  afterEach(async () => {
    await raven?.stop();
    raven = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps attachments and execution settings when rebuilding operational SQLite', async () => {
    const project = await createProject('Workspace fixture');
    const repository = join(root, 'attached-repository');
    mkdirSync(repository);
    writeFileSync(join(repository, 'AGENTS.md'), 'Follow the local pipeline.');
    const base = `/api/projects/${project.id}`;
    const added = await request(`${base}/data-sources`, 'POST', {
      uri: repository,
      label: 'Attached repository',
      sourceType: 'folder',
      contextFiles: ['AGENTS.md'],
    });
    expect(added.status).toBe(201);
    const source = (await added.json()) as ProjectDataSource;
    expect(
      (
        await request(`${base}/workspace`, 'PUT', {
          execution: { mode: 'full', sourceId: source.id },
        })
      ).status,
    ).toBe(200);
    const manifest = join(fixture.projectsDir, project.fsPath!, 'project.yaml');
    const bytes = readFileSync(manifest, 'utf8');
    expect(bytes).toContain(repository);
    expect(bytes).not.toContain('projectId:');
    expect(
      getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_data_sources'").get(),
    ).toBeUndefined();

    await raven!.stop();
    raven = undefined;
    await boot(join(root, 'fresh.db'));
    const workspace = (await (await request(`${base}/workspace`)).json()) as ProjectWorkspace;
    expect(workspace.execution).toEqual({ mode: 'full', sourceId: source.id });
    expect(await (await request(`${base}/data-sources`)).json()).toEqual([source]);
    expect(readFileSync(manifest, 'utf8')).toBe(bytes);
    expect((await request(`${base}/data-sources/${source.id}`, 'DELETE')).status).toBe(204);
    expect(await (await request(`${base}/workspace`)).json()).toMatchObject({
      execution: { mode: 'full' },
      sources: [],
    });
  }, 15000);

  it('reports malformed configuration and recovers after a file correction and reload', async () => {
    const project = await createProject('Broken workspace fixture');
    const sibling = await createProject('Valid workspace fixture');
    const base = `/api/projects/${project.id}`;
    const manifest = join(fixture.projectsDir, project.fsPath!, 'project.yaml');
    writeFileSync(manifest, 'version: 1\nexecution:\n  mode: unknown\n');
    expect((await request(`${base}/workspace`)).status).toBe(409);
    await request('/api/definitions/reload', 'POST');
    const health = await (await request('/api/health')).text();
    expect(health).toContain(`${project.fsPath}/project.yaml`);
    expect((await request(`/api/projects/${sibling.id}/workspace`)).status).toBe(200);
    writeFileSync(manifest, 'version: 1\nexecution:\n  mode: default\nsources: []\n');
    expect((await request('/api/definitions/reload', 'POST')).status).toBe(200);
    expect((await request(`${base}/workspace`)).status).toBe(200);
    expect(await (await request('/api/health')).text()).not.toContain('invalid-project-workspace');
  }, 15000);
});
