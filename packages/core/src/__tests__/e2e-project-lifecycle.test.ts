import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTaskCompleteEvent, Project } from '@raven/shared';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const INITIAL_SETTINGS = {
  name: 'Field Study',
  description: 'Initial research description',
  skills: ['metadata-only-initial-skill'],
  systemPrompt: 'Use the initial research conventions.',
  systemAccess: 'read' as const,
};
const UPDATED_SETTINGS = {
  name: 'Renamed Field Study',
  description: 'Updated research description',
  skills: ['metadata-only-updated-skill', 'another-metadata-skill'],
  systemPrompt: 'Explain decisions using the revised research conventions.',
  systemAccess: 'read-write' as const,
};
const HUMAN_CONTEXT =
  '# Research notes\r\n\r\nKeep the unusual symbol α and these line endings.\r\n';

describe('e2e: project definitions survive the complete lifecycle', () => {
  let root: string;
  let fixture: ReturnType<typeof createRavenTestFixture>;
  let raven: RavenInstance | undefined;
  let calls: BackendOptions[];

  async function boot(dbPath = fixture.dbPath): Promise<void> {
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      dbPath,
      skipSuites: true,
      agentBackend: async (opts) => {
        calls.push(opts);
        opts.onAssistantMessage('Fixture reply.');
        return { result: 'Fixture reply.', success: true, errors: [] };
      },
    });
    await raven.start();
  }

  async function restart(dbPath = fixture.dbPath): Promise<void> {
    await raven!.stop();
    raven = undefined;
    await boot(dbPath);
  }

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://localhost:${raven!.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  async function getProject(id: string): Promise<Project> {
    const response = await request(`/api/projects/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Project;
  }

  async function createProject(settings: unknown = INITIAL_SETTINGS): Promise<Project> {
    const response = await request('/api/projects', 'POST', settings);
    expect(response.status).toBe(200);
    const project = (await response.json()) as Project;
    expect(project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(project.fsPath).toBeDefined();
    return project;
  }

  function contextPath(project: Project): string {
    return join(fixture.projectsDir, project.fsPath!, 'context.md');
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-project-lifecycle-'));
    fixture = createRavenTestFixture(root);
    calls = [];
    await boot();
  });

  afterEach(async () => {
    if (raven) await raven.stop();
    raven = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('persists all create/update fields across restarts and injects only the intended chat context', async () => {
    const project = await createProject();
    expect(project.fsPath).toBe('field-study');
    await restart();
    expect(await getProject(project.id)).toMatchObject({
      ...INITIAL_SETTINGS,
      id: project.id,
      fsPath: project.fsPath,
    });

    // Simulate an owner editing the existing definition: preserve their body,
    // unrelated frontmatter, and comments through the API metadata update.
    const raw = readFileSync(contextPath(project), 'utf8');
    const frontmatterEnd = raw.indexOf('\n---\n', 4);
    expect(frontmatterEnd).toBeGreaterThan(0);
    writeFileSync(
      contextPath(project),
      `${raw.slice(0, frontmatterEnd)}\ncustomLabel: preserved # keep this comment\n---\n${HUMAN_CONTEXT}`,
    );
    const updated = await request(`/api/projects/${project.id}`, 'PUT', UPDATED_SETTINGS);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ success: true });
    await restart();

    expect(await getProject(project.id)).toMatchObject({
      ...UPDATED_SETTINGS,
      id: project.id,
      fsPath: project.fsPath,
    });
    const persisted = readFileSync(contextPath(project), 'utf8');
    expect(persisted.endsWith(HUMAN_CONTEXT)).toBe(true);
    expect(persisted).toContain('customLabel: preserved # keep this comment');
    expect(existsSync(join(fixture.projectsDir, 'renamed-field-study'))).toBe(false);

    const completed = new Promise<AgentTaskCompleteEvent>((resolve) => {
      raven!.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve);
    });
    const chat = await request(`/api/projects/${project.id}/chat`, 'POST', {
      message: 'Explain the current research conventions.',
    });
    expect(chat.status).toBe(200);
    expect((await completed).payload.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toContain(UPDATED_SETTINGS.systemPrompt);
    expect(calls[0].systemPrompt).toContain('Keep the unusual symbol α');
    expect(calls[0].systemPrompt).not.toContain('ravenProject:');
    expect(calls[0].systemPrompt).not.toContain('customLabel:');
    expect(calls[0].systemPrompt).not.toContain(INITIAL_SETTINGS.systemPrompt);
  }, 15000);

  it('deletes an empty project without resurrection and leaves recoverable archived context', async () => {
    const project = await createProject({ name: 'Disposable Project' });
    const original = readFileSync(contextPath(project), 'utf8');
    const deleted = await request(`/api/projects/${project.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      success: true,
      knowledgeReferencesChecked: false,
    });
    expect((await request(`/api/projects/${project.id}`)).status).toBe(404);
    expect(existsSync(contextPath(project))).toBe(false);

    const archiveDir = join(fixture.projectsDir, '.archive');
    const archives = readdirSync(archiveDir);
    expect(archives).toHaveLength(1);
    const archivedContext = join(archiveDir, archives[0], 'context.md');
    expect(readFileSync(archivedContext, 'utf8')).toBe(original);
    await restart();

    expect((await request(`/api/projects/${project.id}`)).status).toBe(404);
    const listed = await request('/api/projects');
    expect(listed.status).toBe(200);
    expect((await listed.json()) as Project[]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    );
    expect(existsSync(contextPath(project))).toBe(false);
    expect(readFileSync(archivedContext, 'utf8')).toBe(original);
  }, 15000);

  it.each(['sessions', 'data-sources', 'children', 'system'] as const)(
    'refuses deletion with %s without changing definitions or records',
    async (reference) => {
      const project =
        reference === 'system'
          ? await getProject('meta')
          : await createProject({ name: 'Referenced Project' });
      let referencePath: string | undefined;
      if (reference === 'sessions') {
        referencePath = `/api/projects/${project.id}/sessions`;
        expect((await request(referencePath, 'POST')).status).toBe(200);
      } else if (reference === 'data-sources') {
        referencePath = `/api/projects/${project.id}/data-sources`;
        const source = await request(referencePath, 'POST', {
          uri: 'https://example.invalid/fixture',
          label: 'Fixture source',
          sourceType: 'url',
        });
        expect(source.status).toBe(201);
      } else if (reference === 'children') {
        referencePath = `/api/projects/${project.id}/children`;
        const child = await request('/api/scaffold/project', 'POST', {
          path: `${project.fsPath}/child`,
          displayName: 'Child project',
        });
        expect(child.status).toBe(201);
        const childList = await request(referencePath);
        expect(childList.status).toBe(200);
        const children = (await childList.json()) as Array<{ id: string }>;
        expect(children).toHaveLength(1);
        expect(await getProject(children[0].id)).toMatchObject({ parentId: project.id });
        expect(await getProject(project.id)).toMatchObject({ children: [children[0].id] });
      }
      const before = await getProject(project.id);
      const raw = readFileSync(contextPath(project), 'utf8');
      const directories = readdirSync(fixture.projectsDir).sort();
      const references = referencePath ? await (await request(referencePath)).json() : undefined;

      const deleted = await request(`/api/projects/${project.id}`, 'DELETE');
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toMatchObject({ error: expect.any(String) });
      expect(await getProject(project.id)).toEqual(before);
      expect(readFileSync(contextPath(project), 'utf8')).toBe(raw);
      expect(readdirSync(fixture.projectsDir).sort()).toEqual(directories);
      if (referencePath) expect(await (await request(referencePath)).json()).toEqual(references);
    },
    15000,
  );

  it('rebuilds the SQLite project cache from definitions while preserving the created UUID', async () => {
    const project = await createProject();
    const raw = readFileSync(contextPath(project), 'utf8');
    // Keep the original DB for comparison; a fresh DB exercises filesystem recovery.
    await restart(join(root, 'rebuilt.db'));
    expect(await getProject(project.id)).toMatchObject({
      ...INITIAL_SETTINGS,
      id: project.id,
      fsPath: project.fsPath,
    });
    expect(readFileSync(contextPath(project), 'utf8')).toBe(raw);
  }, 15000);
});
