import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { locateTaskArtifact } from '../project-manager/task-artifact-files.ts';
import type { TaskArtifact } from '@raven/shared';
import type { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-artifact-location-'));
  roots.push(root);
  const projectsDir = join(root, 'projects');
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(projectsDir, name), { recursive: true });
    writeFileSync(join(projectsDir, name, 'context.md'), `# ${name}`);
  }
  const repository = join(root, 'repository');
  mkdirSync(repository);
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  const workspaceStore = createProjectWorkspaceStore({
    projectsDir,
    projectRegistry: registry,
    projectRoot: root,
  });
  const source = await workspaceStore.createDataSource('alpha', {
    label: 'Repository',
    sourceType: 'folder',
    uri: repository,
  });
  await workspaceStore.updateWorkspace('alpha', { execution: { sourceId: source.id } });
  return { root, projectsDir, repository, workspaceStore, source };
}

function file(filePath: string, sourceId?: string): TaskArtifact {
  return { type: 'file', label: 'Result', filePath, ...(sourceId ? { sourceId } : {}) };
}

describe('task artifact source registration', () => {
  it('binds relative artifacts to their original source when the selected cwd changes', async () => {
    const { workspaceStore, source } = await fixture();
    const location = locateTaskArtifact({
      projectId: 'alpha',
      workspaceStore,
      artifact: file('outputs/report.md'),
    });
    expect(location).toEqual({
      projectId: 'alpha',
      sourceId: source.id,
      path: 'outputs/report.md',
    });
    await workspaceStore.updateWorkspace('alpha', { execution: { sourceId: null } });
    expect(
      locateTaskArtifact({
        projectId: 'alpha',
        workspaceStore,
        artifact: file(location.path, location.sourceId),
      }),
    ).toEqual(location);
    await workspaceStore.deleteDataSource('alpha', source.id);
    expect(() =>
      locateTaskArtifact({
        projectId: 'alpha',
        workspaceStore,
        artifact: file(location.path, location.sourceId),
      }),
    ).toThrow(/source not found/);
  });

  it('maps absolute paths to owned roots without granting a sibling project or prefix', async () => {
    const { projectsDir, repository, workspaceStore, source } = await fixture();
    expect(
      locateTaskArtifact({
        projectId: 'alpha',
        workspaceStore,
        artifact: file(join(repository, 'report # ü.md')),
      }),
    ).toEqual({ projectId: 'alpha', sourceId: source.id, path: 'report # ü.md' });
    expect(
      locateTaskArtifact({
        projectId: 'alpha',
        workspaceStore,
        artifact: file(join(projectsDir, 'alpha', 'report.md')),
      }).sourceId,
    ).toBe('home');
    for (const path of [join(projectsDir, 'beta', 'secret.md'), `${repository}-other/secret.md`]) {
      expect(() =>
        locateTaskArtifact({ projectId: 'alpha', workspaceStore, artifact: file(path) }),
      ).toThrow(/outside/);
    }
    expect(() =>
      locateTaskArtifact({
        projectId: 'beta',
        workspaceStore,
        artifact: file('report.md', source.id),
      }),
    ).toThrow(/source not found/);
  });

  it('rejects path traversal and stale identity before registering a file', async () => {
    const { projectsDir, workspaceStore } = await fixture();
    for (const path of [
      '../secret',
      './report',
      'outputs//report',
      'a\\b',
      'a\0b',
      '/tmp/../secret',
    ]) {
      expect(() =>
        locateTaskArtifact({ projectId: 'alpha', workspaceStore, artifact: file(path) }),
      ).toThrow();
    }
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: replaced\n---\n',
    );
    expect(() =>
      locateTaskArtifact({ projectId: 'alpha', workspaceStore, artifact: file('report.md') }),
    ).toThrow(/identity/);
  });
});

// The persisted artifact reference is derived through the actual scoped completion tool.
it('registers existing file artifacts through MCP and refuses missing output before completion', async () => {
  const { buildTaskLifecycleTools } = await import('../mcp-server/tools/task-lifecycle.ts');
  const { vi } = await import('vitest');
  const { workspaceStore, repository, source } = await fixture();
  const onTaskCompleted = vi.fn();
  const engine = {
    getTree: () => ({
      projectId: 'alpha',
      status: 'running',
      tasks: new Map([['step', { status: 'in_progress', agentTaskId: 'attempt' }]]),
    }),
    onTaskCompleted,
  } as unknown as TaskExecutionEngine;
  const tools = buildTaskLifecycleTools(
    {
      workspaceStore,
      executionEngine: engine,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
    },
    { role: 'task', projectId: 'alpha', treeId: 'tree', taskId: 'step', agentTaskId: 'attempt' },
  );
  const tool = tools.find((tool) => tool.name === 'complete_task')!;
  const missing = await tool.handler({ summary: 'Missing', artifacts: [file('missing.md')] }, {});
  expect(missing.isError).toBe(true);
  expect(onTaskCompleted).not.toHaveBeenCalled();
  writeFileSync(join(repository, 'report.md'), '# Real report');
  const result = await tool.handler(
    { summary: 'Done', artifacts: [file(join(repository, 'report.md'))] },
    {},
  );
  expect(result.isError).not.toBe(true);
  expect(onTaskCompleted).toHaveBeenCalledWith(
    expect.objectContaining({
      artifacts: [{ type: 'file', label: 'Result', sourceId: source.id, filePath: 'report.md' }],
    }),
  );
});

it('resolves a persisted artifact through the tree project and refuses detached and unbound files', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerTaskArtifactFileRoutes } = await import('../api/routes/task-artifact-files.ts');
  const { workspaceStore, repository, source } = await fixture();
  writeFileSync(join(repository, 'report.md'), '# Real report');
  const engine = {
    getTree: (id: string) =>
      id === 'tree'
        ? {
            projectId: 'alpha',
            tasks: new Map([
              ['step', { artifacts: [file('report.md', source.id), file('report.md')] }],
            ]),
          }
        : undefined,
  } as unknown as TaskExecutionEngine;
  const app = Fastify();
  registerTaskArtifactFileRoutes(app, { executionEngine: engine, workspaceStore });
  try {
    const path = '/api/task-trees/tree/tasks/step/artifacts/0/file';
    const response = await app.inject(path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: 'alpha',
      sourceId: source.id,
      path: 'report.md',
      preview: 'text',
    });
    expect(
      (await app.inject('/api/task-trees/missing/tasks/step/artifacts/0/file')).statusCode,
    ).toBe(404);
    expect((await app.inject('/api/task-trees/tree/tasks/step/artifacts/1/file')).statusCode).toBe(
      409,
    );
    await workspaceStore.deleteDataSource('alpha', source.id);
    expect((await app.inject(path)).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
