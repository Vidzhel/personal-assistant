import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RavenTask } from '@raven/shared';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('composed project task files', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(raven!.port)}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  it('closes a failed startup when project definitions are invalid', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-invalid-project-startup-'));
    const paths = createRavenTestFixture(root);
    const definition = join(paths.projectsDir, 'context.md');
    writeFileSync(
      definition,
      '---\nravenProject: {version: 1, systemAccess: invalid}\n---\nContext',
    );
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: async () => ({ sessionId: 'fake', result: '', success: true, errors: [] }),
    };
    await expect(createRaven(buildTestConfig(), overrides)).rejects.toThrow();
    writeFileSync(definition, 'Valid human context');
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    expect((await request('/api/health')).status).toBe(200);
  });

  it('reads externally edited YAML after a restart and protects the containing project', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-task-files-'));
    const paths = createRavenTestFixture(root);
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: async () => ({ sessionId: 'fake', result: '', success: true, errors: [] }),
    };
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const createdProject = await request('/api/projects', 'POST', { name: 'Research' });
    expect(createdProject.status).toBe(200);
    const project = (await createdProject.json()) as { id: string; fsPath: string };
    const response = await request('/api/tasks', 'POST', {
      projectId: project.id,
      title: 'Read the methods',
      description: 'Review assumptions.\nRecord open questions.',
      status: 'in_progress',
      assignedAgentId: 'raven',
    });
    expect(response.status).toBe(201);
    const task = (await response.json()) as RavenTask;
    const path = join(paths.projectsDir, project.fsPath, 'tasks', 'board', `${task.id}.yaml`);
    expect(parse(readFileSync(path, 'utf8'))).toMatchObject(task);
    expect(raven.db.get("SELECT name FROM sqlite_master WHERE name = 'tasks'")).toBeUndefined();

    let chatCompleted = false;
    raven.eventBus.on('agent:task:complete', () => {
      chatCompleted = true;
    });
    expect(
      (await request(`/api/projects/${project.id}/chat`, 'POST', { message: 'Unrelated chat' }))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(chatCompleted).toBe(true));
    expect(await (await request(`/api/tasks/${task.id}`)).json()).toMatchObject({
      status: 'in_progress',
    });

    await raven.stop();
    raven = undefined;
    writeFileSync(path, stringify({ ...task, title: 'Owner edited the methods task' }));
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    expect(await (await request(`/api/tasks/${task.id}`)).json()).toMatchObject({
      id: task.id,
      title: 'Owner edited the methods task',
      projectId: project.id,
    });
    const first = await request(`/api/tasks/${task.id}/complete`, 'POST', {
      artifacts: ['notes/methods.md'],
    });
    expect(first.status).toBe(200);
    const completed = (await first.json()) as RavenTask;
    const second = await request(`/api/tasks/${task.id}/complete`, 'POST', {
      artifacts: ['notes/methods.md'],
    });
    expect(await second.json()).toMatchObject({
      completedAt: completed.completedAt,
      artifacts: ['notes/methods.md'],
      status: 'completed',
    });
    expect((await request(`/api/projects/${project.id}`, 'DELETE')).status).toBe(409);
    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({ id: task.id, status: 'completed' });
  });
});
