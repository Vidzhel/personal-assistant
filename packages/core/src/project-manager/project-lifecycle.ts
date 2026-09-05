import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  gitAutoCommit,
  META_PROJECT_ID,
  type Project,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from '@raven/shared';
import type Database from 'better-sqlite3';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import {
  readProjectDefinition,
  writeProjectDefinition,
} from '../project-registry/project-definition.ts';
import {
  getProjectRow,
  parseProjectRow,
  projectFromNode,
  projectMetadata,
  projectReferences,
  saveProjectRow,
} from './project-cache.ts';
import {
  assertProjectPath,
  managedPath,
  pathPresent,
  readManagedContext,
  replaceContextChecked,
} from './project-files.ts';
import { withProjectMutation, ProjectMutationError } from './project-mutation.ts';
import { kebabCase } from './project-sync.ts';
import {
  createMutationJournal,
  flushProjectMutationPath,
  removeProjectMutationJournal,
} from './project-recovery/journal.ts';

export interface ProjectLifecycleDeps {
  db: Database.Database;
  projectRegistry: ProjectRegistry;
  scaffoldingApi: ScaffoldingApi;
  projectsDir: string;
  neo4jClient?: Neo4jClient;
  checkpoint?: (label: string) => Promise<void>;
}

async function creationPath(
  deps: ProjectLifecycleDeps,
  name: string,
  auto: boolean,
): Promise<string> {
  const base = kebabCase(name);
  let path = base;
  let suffix = 1;
  for (;;) {
    try {
      assertProjectPath(path);
    } catch (error) {
      if (!auto) throw error;
      path = `project-${base}`;
    }
    const occupied =
      deps.db.prepare('SELECT 1 FROM projects WHERE fs_path = ?').get(path) ||
      (await pathPresent(await managedPath(deps.projectsDir, path)));
    if (!occupied) return path;
    if (!auto) throw new ProjectMutationError(`Project path ${path} already exists`);
    path = `${base}-${++suffix}`;
  }
}

export async function createManagedProject(
  deps: ProjectLifecycleDeps,
  input: ProjectCreateInput,
  callerId?: string,
): Promise<Project> {
  return withProjectMutation(deps.projectsDir, async () => {
    deps.projectRegistry.assertHealthy();
    if (callerId && deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(callerId)) {
      return parseProjectRow(getProjectRow(deps.db, callerId));
    }
    const fsPath = await creationPath(deps, input.name, callerId !== undefined);
    const now = Date.now();
    const project: Project = {
      ...input,
      id: callerId ?? randomUUID(),
      fsPath,
      skills: input.skills ?? [],
      isMeta: false,
      createdAt: now,
      updatedAt: now,
    };
    await deps.scaffoldingApi.createProject({ ...projectMetadata(project), path: fsPath });
    try {
      if (!deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id))
        saveProjectRow(deps.db, project);
    } catch (error) {
      await deps.projectRegistry.load(deps.projectsDir);
      throw error;
    }
    await gitAutoCommit(
      [join(deps.projectsDir, fsPath, 'context.md')],
      `feat(project): create ${fsPath}`,
    );
    return parseProjectRow(getProjectRow(deps.db, project.id));
  });
}

function linkedProject(deps: ProjectLifecycleDeps, id: string): Project & { fsPath: string } {
  const project = parseProjectRow(getProjectRow(deps.db, id));
  if (!project.fsPath)
    throw new ProjectMutationError(
      'Project has no managed definition; reconcile it before changing it',
    );
  assertProjectPath(project.fsPath, project.id === META_PROJECT_ID);
  const node = deps.projectRegistry.getProject(project.fsPath);
  if (!node) throw new ProjectMutationError('Project definition is unavailable');
  const authoritativeId = node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id);
  if (authoritativeId !== project.id) {
    throw new ProjectMutationError(
      `Project identity no longer matches its managed definition at ${project.fsPath}`,
    );
  }
  return { ...project, fsPath: project.fsPath };
}

export async function updateManagedProject(
  deps: ProjectLifecycleDeps,
  id: string,
  updates: ProjectUpdateInput,
): Promise<void> {
  return withProjectMutation(deps.projectsDir, async () => {
    deps.projectRegistry.assertHealthy();
    const previous = linkedProject(deps, id);
    const original = await readManagedContext(deps.projectsDir, previous.fsPath);
    const node = deps.projectRegistry.getProject(previous.fsPath);
    if (!node) throw new ProjectMutationError('Project definition is unavailable');
    const current = { ...node, metadata: readProjectDefinition(original).metadata };
    const next = { ...projectFromNode(current, previous), ...updates, updatedAt: Date.now() };
    const intended = writeProjectDefinition(original, projectMetadata(next));
    const journal = createMutationJournal({
      projectsDir: deps.projectsDir,
      operation: 'update',
      projectId: previous.id,
      path: previous.fsPath,
      originalBytes: original,
      intendedBytes: intended,
    });
    await deps.checkpoint?.('update:before-context');
    await replaceContextChecked({
      root: deps.projectsDir,
      path: previous.fsPath,
      content: intended,
      expectedHash: journal.originalHash,
    });
    await deps.checkpoint?.('update:after-context');
    await deps.projectRegistry.load(deps.projectsDir);
    saveProjectRow(deps.db, next);
    await deps.checkpoint?.('update:cache');
    removeProjectMutationJournal(deps.projectsDir, journal.mutationId);
    await gitAutoCommit(
      [join(deps.projectsDir, previous.fsPath, 'context.md')],
      `fix(project): update ${previous.fsPath}`,
    );
  });
}

function assertUnreferenced(deps: ProjectLifecycleDeps, project: Project): void {
  if (project.id === META_PROJECT_ID || project.isMeta || project.fsPath === 'system') {
    throw new ProjectMutationError('Cannot delete the system meta-project');
  }
  const references = projectReferences(deps.db, project.id);
  if (references.length > 0)
    throw new ProjectMutationError(`Project is referenced by ${references.join(', ')}`);
}

async function assertEmpty(
  deps: ProjectLifecycleDeps,
  project: Project & { fsPath: string },
): Promise<boolean> {
  assertUnreferenced(deps, project);
  const path = await managedPath(deps.projectsDir, project.fsPath);
  await managedPath(deps.projectsDir, `${project.fsPath}/context.md`);
  if ((await readdir(path)).some((entry) => entry !== 'context.md')) {
    throw new ProjectMutationError('Project contains children, local definitions, or other files');
  }
  if (!deps.neo4jClient) return false;
  const links = await deps.neo4jClient.query<{ id: string }>(
    'MATCH (b)-[:BELONGS_TO_PROJECT]->(p:Project {id: $id}) RETURN b.id AS id LIMIT 1',
    { id: project.id },
  );
  if (links.length > 0) throw new ProjectMutationError('Project has linked knowledge');
  return true;
}

export async function deleteManagedProject(
  deps: ProjectLifecycleDeps,
  id: string,
): Promise<{ knowledgeReferencesChecked: boolean }> {
  return withProjectMutation(deps.projectsDir, () => deleteProjectMutation({ deps, id }));
}

async function deleteProjectMutation(input: {
  deps: ProjectLifecycleDeps;
  id: string;
}): Promise<{ knowledgeReferencesChecked: boolean }> {
  const { deps, id } = input;
  deps.projectRegistry.assertHealthy();
  const linked = linkedProject(deps, id);
  const original = await readManagedContext(deps.projectsDir, linked.fsPath);
  const definition = readProjectDefinition(original);
  const node = deps.projectRegistry.getProject(linked.fsPath);
  if (!node) throw new ProjectMutationError('Project definition is unavailable');
  const project = {
    ...projectFromNode({ ...node, metadata: definition.metadata }, linked),
    fsPath: linked.fsPath,
  };
  const knowledgeReferencesChecked = await assertEmpty(deps, project);
  await archiveProjectMutation({ deps, id, project, original });
  return { knowledgeReferencesChecked };
}

async function archiveProjectMutation(input: {
  deps: ProjectLifecycleDeps;
  id: string;
  project: Project & { fsPath: string };
  original: string;
}): Promise<void> {
  const { deps, id, project, original } = input;
  const archiveRoot = await managedPath(deps.projectsDir, '.archive');
  const source = await managedPath(deps.projectsDir, project.fsPath);
  const archive = await managedPath(deps.projectsDir, `.archive/${randomUUID()}`);
  const archiveJson = JSON.stringify(project, null, 2) + '\n';
  const archiveName = archive.slice(archive.lastIndexOf('/') + 1);
  const journal = createMutationJournal({
    projectsDir: deps.projectsDir,
    operation: 'archive',
    projectId: project.id,
    path: project.fsPath,
    originalBytes: original,
    intendedBytes: original,
    archivePath: `.archive/${archiveName}`,
    archiveJson,
  });
  await deps.checkpoint?.('archive:journal');
  await mkdir(archiveRoot, { recursive: true });
  await assertArchiveSource({
    deps,
    project,
    expectedHash: journal.originalHash,
  });
  flushProjectMutationPath(dirname(source));
  await rename(source, archive);
  flushProjectMutationPath(dirname(source));
  flushProjectMutationPath(archiveRoot);
  await deps.checkpoint?.('archive:after-rename');
  const snapshot = await writeArchiveSnapshot(archive, archiveJson);
  await deps.checkpoint?.('archive:after-json');
  await deps.projectRegistry.load(deps.projectsDir);
  deps.db.transaction(() => {
    assertUnreferenced(deps, parseProjectRow(getProjectRow(deps.db, id)));
    deps.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  })();
  await deps.checkpoint?.('archive:cache');
  removeProjectMutationJournal(deps.projectsDir, journal.mutationId);
  await gitAutoCommit(
    [join(source, 'context.md'), join(archive, 'context.md'), snapshot],
    `chore(project): archive ${project.fsPath}`,
  );
}

async function writeArchiveSnapshot(archive: string, bytes: string): Promise<string> {
  const snapshot = join(archive, 'archive.json');
  await writeFile(snapshot, bytes, { flag: 'wx' });
  flushProjectMutationPath(snapshot);
  flushProjectMutationPath(archive);
  return snapshot;
}

async function assertArchiveSource(input: {
  deps: ProjectLifecycleDeps;
  project: Project & { fsPath: string };
  expectedHash: string;
}): Promise<void> {
  const raw = await readManagedContext(input.deps.projectsDir, input.project.fsPath);
  const hash = createHash('sha256').update(raw).digest('hex');
  if (hash !== input.expectedHash)
    throw new ProjectMutationError('Project context changed before archive');
  const definition = readProjectDefinition(raw);
  if (definition.metadata?.id && definition.metadata.id !== input.project.id) {
    throw new ProjectMutationError('Project identity changed before archive');
  }
  if (!definition.metadata?.id && input.project.id !== input.project.fsPath) {
    throw new ProjectMutationError('Plain project identity changed before archive');
  }
  const path = await managedPath(input.deps.projectsDir, input.project.fsPath);
  if ((await readdir(path)).some((entry) => entry !== 'context.md')) {
    throw new ProjectMutationError('Project gained files before archive');
  }
}
