import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { META_PROJECT_ID } from '@raven/shared';
import { initDatabase } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  createManagedProject,
  deleteManagedProject,
} from '../project-manager/project-lifecycle.ts';
import { runProjectSync, syncProjectCache } from '../project-manager/project-sync.ts';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('project deletion and task admission', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it('rejects new task writes while deletion awaits graph references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-project-task-lock-'));
    const paths = createRavenTestFixture(root);
    const db = initDatabase(paths.dbPath);
    cleanup = () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    };
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(paths.projectsDir);
    const scaffoldingApi = createScaffoldingApi({
      projectsDir: paths.projectsDir,
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      syncProjects: () => {
        syncProjectCache({ db, projectRegistry });
      },
    });
    const deps = { db, projectRegistry, scaffoldingApi, projectsDir: paths.projectsDir };
    await runProjectSync(deps);
    const project = await createManagedProject(deps, { name: 'Delete race', systemAccess: 'none' });
    const eventBus = new EventBus();
    const created = vi.fn();
    eventBus.on('task:created', created);
    const tasks = createTaskStore({
      projectsDir: paths.projectsDir,
      projects: () =>
        projectRegistry.listProjects().map((node) => ({
          id: node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id),
          fsPath: node.id,
        })),
      eventBus,
    });
    const containingProject = await createManagedProject(deps, {
      name: 'File-only reference',
      systemAccess: 'none',
    });
    const saved = tasks.createTask({ title: 'Keep this task', projectId: containingProject.id });
    await expect(deleteManagedProject(deps, containingProject.id)).rejects.toThrow('other files');
    expect(tasks.getTask(saved.id)?.projectId).toBe(containingProject.id);
    created.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async () => {
      await gate;
      return [];
    });
    const deletion = deleteManagedProject({ ...deps, neo4jClient: { query } as never }, project.id);
    try {
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      expect(() => tasks.createTask({ title: 'Racing write', projectId: project.id })).toThrow(
        'being updated',
      );
      expect(created).not.toHaveBeenCalled();
    } finally {
      release();
      await deletion;
    }
    expect(existsSync(join(paths.projectsDir, project.fsPath!))).toBe(false);
    expect(() => tasks.createTask({ title: 'Stale owner', projectId: project.id })).toThrow(
      'Unknown project',
    );
  });
});
