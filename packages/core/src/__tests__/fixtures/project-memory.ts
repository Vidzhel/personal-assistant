import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createMemoryStore } from '../../agent-memory/memory-store.ts';
import { ProjectRegistry } from '../../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../../project-manager/project-workspace.ts';
import { assertIsolatedRoot } from '../setup/isolated-composition.ts';

export async function createProjectMemoryFixture(projectsDir: string, ids: string[]) {
  assertIsolatedRoot(existsSync(projectsDir) ? projectsDir : dirname(projectsDir));
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(projectsDir, 'context.md'), '# Global fixture\n');
  for (const id of ids) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Unsafe fixture project ID');
    mkdirSync(join(projectsDir, id), { recursive: true });
    writeFileSync(join(projectsDir, id, 'context.md'), `# ${id}\n`);
  }
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  const workspaceStore = createProjectWorkspaceStore({
    projectsDir,
    projectRegistry,
    projectRoot: dirname(projectsDir),
  });
  return {
    projectRegistry,
    workspaceStore,
    memoryStore: createMemoryStore({ projectsDir, workspaceStore }),
  };
}
