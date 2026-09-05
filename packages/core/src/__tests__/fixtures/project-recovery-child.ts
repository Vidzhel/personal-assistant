import { initDatabase, closeDatabase } from '../../db/database.ts';
import { ProjectRegistry } from '../../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../../project-registry/agent-yaml-store.ts';
import { createScaffoldingApi } from '../../scaffolding/scaffolding-api.ts';
import { syncProjectCache } from '../../project-manager/project-sync.ts';
import {
  updateManagedProject,
  deleteManagedProject,
  type ProjectLifecycleDeps,
} from '../../project-manager/project-lifecycle.ts';
import { createProjectDefinition } from '../../project-manager/create-project-definition.ts';

interface ChildMessage {
  type: 'ready' | 'error' | 'complete';
  phase?: string;
  message?: string;
}

function send(message: ChildMessage): void {
  process.send?.(message);
}

function holdAt(phase: string, requested: string): Promise<void> {
  if (phase !== requested) return Promise.resolve();
  send({ type: 'ready', phase });
  return new Promise(() => undefined);
}

async function main(): Promise<void> {
  const [projectsDir, dbPath, operation, projectId, requestedPhase] = process.argv.slice(2);
  if (!projectsDir || !dbPath || !operation || !projectId || !requestedPhase) {
    throw new Error(
      'project recovery child requires projectsDir, dbPath, operation, projectId, phase',
    );
  }
  const db = initDatabase(dbPath);
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  const checkpoint = (phase: string) => holdAt(phase, requestedPhase);
  const scaffoldingApi = createScaffoldingApi({
    projectsDir,
    projectRegistry,
    agentYamlStore: createAgentYamlStore(),
    syncProjects: () => {
      syncProjectCache({ db, projectRegistry });
    },
  });
  const deps: ProjectLifecycleDeps = {
    db,
    projectRegistry,
    scaffoldingApi,
    projectsDir,
    checkpoint,
  };

  if (operation === 'update') {
    await updateManagedProject(deps, projectId, { name: 'Interrupted update' });
  } else if (operation === 'archive' || operation === 'archive-plain') {
    await deleteManagedProject(deps, projectId);
  } else if (operation === 'create') {
    await createProjectDefinition(
      { projectsDir, projectRegistry, checkpoint },
      { path: 'interrupted-create', id: projectId, displayName: 'Interrupted create' },
    );
  } else {
    throw new Error(`Unknown project recovery operation: ${operation}`);
  }
  send({ type: 'complete' });
  closeDatabase();
}

main().catch((error: unknown) => {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  closeDatabase();
  process.exitCode = 1;
});
