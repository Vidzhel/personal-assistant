import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  CreateDataSourceSchema,
  HTTP_STATUS,
  META_PROJECT_ID,
  ProjectWorkspaceSchema,
  ProjectWorkspaceSourceSchema,
  WorkspaceUpdateSchema,
  projectWorkspaceDefaults,
  type CreateDataSourceInput,
  type ProjectDataSource,
  type ProjectNode,
  type ProjectWorkspace,
  type ProjectWorkspaceSource,
  type UpdateDataSourceInput,
  type WorkspaceUpdate,
  UpdateDataSourceSchema,
} from '@raven/shared';
import { ProjectMutationError, withProjectMutation } from './project-mutation.ts';
import { readProjectTextFile } from './project-file-read.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import { readProjectDefinition } from '../project-registry/project-definition.ts';

const MANIFEST = 'project.yaml';
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MANIFEST_BYTES = 1_048_576;
const DEFAULT_MEMORY_MAX_FILES = 30;
const DEFAULT_MEMORY_MAX_TOTAL_KB = 64;

export interface ProjectWorkspaceStoreDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  projectRoot: string;
}

export interface ProjectWorkspaceStore {
  getWorkspace(projectId: string): ProjectWorkspace;
  getDataSources(projectId: string): ProjectDataSource[];
  getDataSource(projectId: string, id: string): ProjectDataSource | undefined;
  getProjectHome(projectId: string): string;
  listProjectIds(): string[];
  updateWorkspace(projectId: string, patch: WorkspaceUpdate): Promise<ProjectWorkspace>;
  createDataSource(projectId: string, input: CreateDataSourceInput): Promise<ProjectDataSource>;
  updateDataSource(
    projectId: string,
    id: string,
    input: UpdateDataSourceInput,
  ): Promise<ProjectDataSource>;
  deleteDataSource(projectId: string, id: string): Promise<void>;
}

interface LocatedProject {
  projectId: string;
  directory: string;
  node: ProjectNode;
}

interface LoadedWorkspace {
  workspace: ProjectWorkspace;
  bytes?: string;
}

function mutationError(message: string, statusCode = 409): ProjectMutationError {
  return new ProjectMutationError(message, statusCode);
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertRealDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = statOrUndefined(absolute);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw mutationError(`${label} is missing or unsafe: ${absolute}`);
  }
  if (realpathSync(absolute) !== absolute) throw mutationError(`${label} is not canonical`);
  return absolute;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = statOrUndefined(current);
    if (stat?.isSymbolicLink()) throw mutationError(`Workspace path contains a symlink: ${path}`);
    if (!stat) return;
  }
}

function assertWithin(root: string, path: string): void {
  const base = resolve(root);
  const child = resolve(path);
  const rel = relative(base, child);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') {
    throw mutationError(`Workspace path escapes its root: ${path}`, HTTP_STATUS.BAD_REQUEST);
  }
}

function sourceProjectId(node: ProjectNode): string {
  return node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id);
}

function locateProject(deps: ProjectWorkspaceStoreDeps, projectId: string): LocatedProject {
  deps.projectRegistry.assertHealthy();
  const node = deps.projectRegistry
    .listProjects()
    .find((candidate) => sourceProjectId(candidate) === projectId);
  if (!node) throw mutationError('Project not found', HTTP_STATUS.NOT_FOUND);
  const projectsRoot = assertRealDirectory(deps.projectsDir, 'Projects root');
  const directory = resolve(projectsRoot, node.id);
  assertWithin(projectsRoot, directory);
  assertNoSymlinkComponents(directory);
  assertRealDirectory(directory, 'Project directory');
  assertProjectIdentity(node, directory, projectId);
  return { projectId, directory, node };
}

function assertProjectIdentity(node: ProjectNode, directory: string, projectId: string): void {
  const contextPath = join(directory, 'context.md');
  let definition;
  try {
    const bytes = readProjectTextFile(contextPath, MAX_MANIFEST_BYTES);
    if (bytes === undefined) throw mutationError(`Project context is missing: ${node.id}`);
    definition = readProjectDefinition(bytes);
  } catch (error) {
    throw mutationError(`Project context is unreadable: ${errorMessage(error)}`);
  }
  const identity = definition.metadata?.id ?? (node.isMeta ? META_PROJECT_ID : node.id);
  if (identity !== projectId) throw mutationError(`Project context identity conflicts: ${node.id}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manifestPath(directory: string): string {
  return join(directory, MANIFEST);
}

function parseWorkspace(bytes: string): ProjectWorkspace {
  try {
    return ProjectWorkspaceSchema.parse(parse(bytes));
  } catch (error) {
    throw mutationError(`Invalid project workspace manifest: ${errorMessage(error)}`);
  }
}

function loadWorkspace(directory: string): LoadedWorkspace {
  const bytes = readProjectTextFile(manifestPath(directory), MAX_MANIFEST_BYTES);
  return bytes === undefined
    ? { workspace: projectWorkspaceDefaults() }
    : { workspace: parseWorkspace(bytes), bytes };
}

function flushDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function currentBytes(path: string): string | undefined {
  return readProjectTextFile(path, MAX_MANIFEST_BYTES);
}

function assertExpected(path: string, expected?: string): void {
  if (currentBytes(path) !== expected)
    throw mutationError('Project workspace changed during update');
}

function writeWorkspace(directory: string, workspace: ProjectWorkspace, expected?: string): void {
  const path = manifestPath(directory);
  assertNoSymlinkComponents(directory);
  assertExpected(path, expected);
  const temporary = join(directory, `.${MANIFEST}.${randomUUID()}.tmp`);
  const bytes = stringify(workspace);
  if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES) {
    throw mutationError(
      'Project workspace manifest exceeds the 1 MiB limit',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertNoSymlinkComponents(directory);
    assertExpected(path, expected);
    renameSync(temporary, path);
    flushDirectory(directory);
  } finally {
    if (statOrUndefined(temporary)) unlinkSync(temporary);
  }
}

function detachedWorkspace(workspace: ProjectWorkspace): ProjectWorkspace {
  return {
    version: 1,
    execution: { ...workspace.execution },
    sources: workspace.sources.map((source) => ({
      ...source,
      contextFiles: source.contextFiles ? [...source.contextFiles] : undefined,
    })),
    ...(workspace.memory ? { memory: { ...workspace.memory } } : {}),
  };
}

function runtimeSource(projectId: string, source: ProjectWorkspaceSource): ProjectDataSource {
  return {
    ...source,
    projectId,
    contextFiles: source.contextFiles ? [...source.contextFiles] : undefined,
  };
}

function runtimeSources(projectId: string, workspace: ProjectWorkspace): ProjectDataSource[] {
  return workspace.sources.map((source) => runtimeSource(projectId, source));
}

function parseWorkspaceUpdate(input: unknown): WorkspaceUpdate {
  try {
    return WorkspaceUpdateSchema.parse(input);
  } catch (error) {
    throw mutationError(
      `Invalid workspace update: ${errorMessage(error)}`,
      HTTP_STATUS.BAD_REQUEST,
    );
  }
}

function parseCreateSource(input: unknown): CreateDataSourceInput {
  try {
    return CreateDataSourceSchema.parse(input);
  } catch (error) {
    throw mutationError(`Invalid data source: ${errorMessage(error)}`, HTTP_STATUS.BAD_REQUEST);
  }
}

function parseUpdateSource(input: unknown): UpdateDataSourceInput {
  try {
    return UpdateDataSourceSchema.parse(input);
  } catch (error) {
    throw mutationError(
      `Invalid data source update: ${errorMessage(error)}`,
      HTTP_STATUS.BAD_REQUEST,
    );
  }
}

function assertSafeSourceId(id: string): void {
  if (!SOURCE_ID.test(id) || id === 'home') {
    throw mutationError(`Invalid source id: ${id}`, HTTP_STATUS.BAD_REQUEST);
  }
}

function resolveFolder(root: string, uri: string): string {
  const base = assertRealDirectory(root, 'Workspace root');
  const candidate = resolve(base, uri);
  try {
    assertNoSymlinkComponents(candidate);
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
    const canonical = realpathSync(candidate);
    assertNoSymlinkComponents(canonical);
    return canonical;
  } catch (error) {
    if (error instanceof ProjectMutationError) throw error;
    throw mutationError(`Folder source is missing or unsafe: ${uri}`, HTTP_STATUS.BAD_REQUEST);
  }
}

function normalizeSource(root: string, source: ProjectWorkspaceSource): ProjectWorkspaceSource {
  const normalized = {
    ...source,
    uri: source.sourceType === 'folder' ? resolveFolder(root, source.uri) : source.uri,
    contextFiles: source.sourceType === 'folder' ? (source.contextFiles ?? []) : undefined,
  };
  try {
    return ProjectWorkspaceSourceSchema.parse(normalized);
  } catch (error) {
    throw mutationError(`Invalid data source: ${errorMessage(error)}`, HTTP_STATUS.BAD_REQUEST);
  }
}

function createStoredSource(root: string, input: CreateDataSourceInput): ProjectWorkspaceSource {
  const now = new Date().toISOString();
  return normalizeSource(root, {
    id: randomUUID(),
    uri: input.uri,
    label: input.label,
    description: input.description,
    sourceType: input.sourceType,
    contextFiles: input.contextFiles,
    createdAt: now,
    updatedAt: now,
  });
}

function updateStoredSource(
  root: string,
  existing: ProjectWorkspaceSource,
  input: UpdateDataSourceInput,
): ProjectWorkspaceSource {
  const sourceType = input.sourceType ?? existing.sourceType;
  if (sourceType !== 'folder' && input.contextFiles !== undefined) {
    throw mutationError('Only folder sources may define context files', HTTP_STATUS.BAD_REQUEST);
  }
  return normalizeSource(root, {
    ...existing,
    ...input,
    sourceType,
    contextFiles:
      sourceType === 'folder' ? (input.contextFiles ?? existing.contextFiles ?? []) : undefined,
    updatedAt: new Date().toISOString(),
  });
}

function workspaceWithExecution(
  workspace: ProjectWorkspace,
  patch: WorkspaceUpdate,
): ProjectWorkspace {
  const execution = { ...workspace.execution, ...(patch.execution ?? {}) };
  if (execution.sourceId === null) delete execution.sourceId;
  const memory = workspaceMemory(workspace, patch);
  return parseCompleteWorkspace({ ...workspace, execution, ...(memory ? { memory } : {}) });
}

function workspaceMemory(
  workspace: ProjectWorkspace,
  patch: WorkspaceUpdate,
): ProjectWorkspace['memory'] {
  if (!patch.memory) return workspace.memory;
  return {
    maxFiles: patch.memory.maxFiles ?? workspace.memory?.maxFiles ?? DEFAULT_MEMORY_MAX_FILES,
    maxTotalKb:
      patch.memory.maxTotalKb ?? workspace.memory?.maxTotalKb ?? DEFAULT_MEMORY_MAX_TOTAL_KB,
  };
}

function parseCompleteWorkspace(input: unknown): ProjectWorkspace {
  try {
    return ProjectWorkspaceSchema.parse(input);
  } catch (error) {
    throw mutationError(`Invalid project workspace: ${errorMessage(error)}`);
  }
}

function writeUpdatedWorkspace(
  located: LocatedProject,
  loaded: LoadedWorkspace,
  workspace: ProjectWorkspace,
): ProjectWorkspace {
  writeWorkspace(located.directory, workspace, loaded.bytes);
  return detachedWorkspace(workspace);
}

function readStoreWorkspace(deps: ProjectWorkspaceStoreDeps, projectId: string): LoadedWorkspace {
  const located = locateProject(deps, projectId);
  return loadWorkspace(located.directory);
}

function updateStoreWorkspace(
  deps: ProjectWorkspaceStoreDeps,
  projectId: string,
  patch: WorkspaceUpdate,
): Promise<ProjectWorkspace> {
  return withProjectMutation(deps.projectsDir, async () => {
    const located = locateProject(deps, projectId);
    const loaded = loadWorkspace(located.directory);
    const next = workspaceWithExecution(loaded.workspace, parseWorkspaceUpdate(patch));
    return writeUpdatedWorkspace(located, loaded, next);
  });
}

function createStoreSource(
  deps: ProjectWorkspaceStoreDeps,
  projectId: string,
  input: CreateDataSourceInput,
): Promise<ProjectDataSource> {
  return withProjectMutation(deps.projectsDir, async () => {
    const located = locateProject(deps, projectId);
    const loaded = loadWorkspace(located.directory);
    const source = createStoredSource(deps.projectRoot, parseCreateSource(input));
    const next = parseCompleteWorkspace({
      ...loaded.workspace,
      sources: [...loaded.workspace.sources, source],
    });
    writeWorkspace(located.directory, next, loaded.bytes);
    return runtimeSource(projectId, source);
  });
}

function updateStoreSource(options: {
  deps: ProjectWorkspaceStoreDeps;
  projectId: string;
  id: string;
  input: UpdateDataSourceInput;
}): Promise<ProjectDataSource> {
  const { deps, projectId, id, input } = options;
  return withProjectMutation(deps.projectsDir, async () => {
    assertSafeSourceId(id);
    const located = locateProject(deps, projectId);
    const loaded = loadWorkspace(located.directory);
    const index = loaded.workspace.sources.findIndex((source) => source.id === id);
    const existing = index < 0 ? undefined : loaded.workspace.sources[index];
    if (!existing) throw mutationError('Data source not found', HTTP_STATUS.NOT_FOUND);
    const source = updateStoredSource(deps.projectRoot, existing, parseUpdateSource(input));
    const sources = [...loaded.workspace.sources];
    sources[index] = source;
    const next = parseCompleteWorkspace({ ...loaded.workspace, sources });
    writeWorkspace(located.directory, next, loaded.bytes);
    return runtimeSource(projectId, source);
  });
}

function deleteStoreSource(
  deps: ProjectWorkspaceStoreDeps,
  projectId: string,
  id: string,
): Promise<void> {
  return withProjectMutation(deps.projectsDir, async () => {
    assertSafeSourceId(id);
    const located = locateProject(deps, projectId);
    const loaded = loadWorkspace(located.directory);
    if (!loaded.workspace.sources.some((source) => source.id === id)) {
      throw mutationError('Data source not found', HTTP_STATUS.NOT_FOUND);
    }
    const next = parseCompleteWorkspace({
      ...loaded.workspace,
      execution:
        loaded.workspace.execution.sourceId === id
          ? { ...loaded.workspace.execution, sourceId: undefined }
          : loaded.workspace.execution,
      sources: loaded.workspace.sources.filter((source) => source.id !== id),
    });
    writeWorkspace(located.directory, next, loaded.bytes);
  });
}

export function createProjectWorkspaceStore(
  deps: ProjectWorkspaceStoreDeps,
): ProjectWorkspaceStore {
  return {
    getWorkspace(projectId) {
      return detachedWorkspace(readStoreWorkspace(deps, projectId).workspace);
    },
    getDataSources(projectId) {
      return runtimeSources(projectId, readStoreWorkspace(deps, projectId).workspace);
    },
    getDataSource(projectId, id) {
      assertSafeSourceId(id);
      const source = readStoreWorkspace(deps, projectId).workspace.sources.find(
        (candidate) => candidate.id === id,
      );
      return source ? runtimeSource(projectId, source) : undefined;
    },
    getProjectHome(projectId) {
      return locateProject(deps, projectId).directory;
    },
    listProjectIds() {
      deps.projectRegistry.assertHealthy();
      return deps.projectRegistry.listProjects().map((node) => sourceProjectId(node));
    },
    updateWorkspace: (projectId, patch) => updateStoreWorkspace(deps, projectId, patch),
    createDataSource: (projectId, input) => createStoreSource(deps, projectId, input),
    updateDataSource: (projectId, id, input) => updateStoreSource({ deps, projectId, id, input }),
    deleteDataSource: (projectId, id) => deleteStoreSource(deps, projectId, id),
  };
}

export function readProjectWorkspace(projectDirectory: string): ProjectWorkspace {
  assertRealDirectory(projectDirectory, 'Project directory');
  return loadWorkspace(projectDirectory).workspace;
}
