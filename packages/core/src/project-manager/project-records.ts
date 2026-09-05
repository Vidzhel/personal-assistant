import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertProjectMutationAllowed } from './project-mutation.ts';

const MOVE_DIR = '.raven-record-moves';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MoveIntentSchema = z
  .object({
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    destinationHash: z.string().regex(/^[0-9a-f]{64}$/),
    destinationBytes: z.string(),
  })
  .strict();

export interface ProjectRecordProject {
  id: string;
  fsPath: string;
}

export interface ProjectRecordDeps {
  projectsDir: string;
  projects: () => ProjectRecordProject[];
}

export interface ProjectRecordLocation {
  projectId: string;
  fsPath: string;
  directory: string;
  filePath: string;
  system: boolean;
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertRoot(root: string): string {
  const absolute = resolve(root);
  const stat = statOrUndefined(absolute);
  if (!stat) throw new Error(`Projects root does not exist: ${absolute}`);
  if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new Error(`Projects root must not be a symlink: ${absolute}`);
  }
  if (!stat.isDirectory()) throw new Error(`Projects root must be a directory: ${absolute}`);
  return absolute;
}

function assertDirectory(path: string, label: string): void {
  const stat = statOrUndefined(path);
  if (!stat) throw new Error(`${label} does not exist: ${path}`);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function assertSafeRelativePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid project filesystem path: ${path}`);
  }
}

function assertNoSymlinkComponents(root: string, path: string): void {
  const base = assertRoot(root);
  const absolute = resolve(path);
  const rel = relative(base, absolute);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Path escapes projects root: ${path}`);
  let current = base;
  for (const part of rel ? rel.split('/') : []) {
    current = join(current, part);
    const stat = statOrUndefined(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(`Project record path must not contain symlinks: ${current}`);
    }
  }
}

function ensureDirectory(path: string): void {
  const parts = path.split('/');
  let current = parts.shift() === '' ? '/' : (parts.shift() ?? '');
  for (const part of parts) {
    current = current === '/' ? `/${part}` : join(current, part);
    const stat = statOrUndefined(current);
    if (stat) assertDirectory(current, 'Project record directory');
    else {
      mkdirSync(current);
      assertDirectory(current, 'Project record directory');
      flushDirectory(dirname(current));
    }
  }
}

function flushDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export function assertSafeRecordId(id: string): void {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') throw new Error(`Invalid record id: ${id}`);
}

export function assertRecordDirectory(root: string, directory: string): void {
  assertNoSymlinkComponents(root, directory);
  const stat = statOrUndefined(directory);
  if (stat) assertDirectory(directory, 'Task record directory');
}

export function atomicWrite(root: string, path: string, bytes: string): void {
  const base = assertRoot(root);
  assertNoSymlinkComponents(base, dirname(path));
  ensureDirectory(dirname(path));
  const existing = statOrUndefined(path);
  if (existing?.isSymbolicLink())
    throw new Error(`Project record file must not be a symlink: ${path}`);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertNoSymlinkComponents(base, dirname(path));
    renameSync(temporary, path);
    flushDirectory(dirname(path));
  } finally {
    if (statOrUndefined(temporary)) unlinkSync(temporary);
  }
}

function moveIntentPath(root: string, id: string): string {
  assertSafeRecordId(id);
  const directory = join(assertRoot(root), MOVE_DIR);
  assertNoSymlinkComponents(root, directory);
  ensureDirectory(directory);
  return join(directory, `${id}.json`);
}

function pathWithin(root: string, path: string): void {
  const base = assertRoot(root);
  if (path !== resolve(path)) throw new Error(`Move path must be canonical: ${path}`);
  const rel = relative(base, resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Move path escapes projects root: ${path}`);
  assertNoSymlinkComponents(base, path);
}

function unlinkSafe(root: string, path: string): void {
  pathWithin(root, path);
  const stat = statOrUndefined(path);
  if (!stat) throw new Error(`Expected record file is missing: ${path}`);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Move path is not a file: ${path}`);
  unlinkSync(path);
  flushDirectory(dirname(path));
}

function validateMovePath(deps: ProjectRecordDeps, path: string, collection: string): void {
  assertSafeRelativePath(collection);
  const base = assertRoot(deps.projectsDir);
  pathWithin(base, path);
  const rel = relative(base, resolve(path));
  const parts = rel.split('/');
  const collectionParts = collection.split('/');
  const collectionStart = parts.length - collectionParts.length - 1;
  const actualCollection = parts.slice(collectionStart, -1).join('/');
  if (parts.length < collectionParts.length + 1 || actualCollection !== collection) {
    throw new Error(`Move path is not a project record: ${path}`);
  }
  const filename = parts.at(-1);
  if (filename === undefined || !filename.endsWith('.yaml')) {
    throw new Error(`Move path is not YAML: ${path}`);
  }
  assertSafeRecordId(filename.slice(0, -'.yaml'.length));
  const fsPath = parts.slice(0, collectionStart).join('/');
  const project = deps.projects().find((candidate) => candidate.fsPath === fsPath);
  if (!project) throw new Error(`Move project no longer exists: ${fsPath}`);
  assertDirectory(join(base, fsPath), 'Project directory');
}

function readMoveIntent(path: string): z.infer<typeof MoveIntentSchema> {
  return MoveIntentSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function assertMoveFileHash(path: string, expected: string, label: string): void {
  if (sha256(readFileSync(path, 'utf8')) !== expected) {
    throw new Error(`Cannot recover record move; ${label} conflicts: ${path}`);
  }
}

function assertMoveState(
  deps: ProjectRecordDeps,
  intent: z.infer<typeof MoveIntentSchema>,
  collection: string,
): { sourceExists: boolean; destinationExists: boolean } {
  validateMovePath(deps, intent.sourcePath, collection);
  validateMovePath(deps, intent.destinationPath, collection);
  if (
    intent.sourcePath === intent.destinationPath ||
    intent.sourcePath.split('/').at(-1) !== intent.destinationPath.split('/').at(-1)
  )
    throw new Error('Move source and destination are identical');
  if (sha256(intent.destinationBytes) !== intent.destinationHash)
    throw new Error('Move intent content hash is invalid');
  const sourceStat = statOrUndefined(intent.sourcePath);
  const destinationStat = statOrUndefined(intent.destinationPath);
  if (sourceStat?.isSymbolicLink() || destinationStat?.isSymbolicLink()) {
    throw new Error('Move record files must not be symlinks');
  }
  if (sourceStat) assertMoveFileHash(intent.sourcePath, intent.sourceHash, 'source changed');
  if (destinationStat)
    assertMoveFileHash(intent.destinationPath, intent.destinationHash, 'destination');
  return {
    sourceExists: sourceStat !== undefined,
    destinationExists: destinationStat !== undefined,
  };
}

function recoverIntent(deps: ProjectRecordDeps, intentPath: string, collection: string): void {
  const intent = readMoveIntent(intentPath);
  const state = assertMoveState(deps, intent, collection);
  if (!state.sourceExists && !state.destinationExists) {
    throw new Error('Cannot recover record move; both files are missing');
  }
  if (state.sourceExists && !state.destinationExists) {
    atomicWrite(deps.projectsDir, intent.destinationPath, intent.destinationBytes);
  }
  if (statOrUndefined(intent.sourcePath)) unlinkSafe(deps.projectsDir, intent.sourcePath);
  unlinkSafe(deps.projectsDir, intentPath);
}

export function recoverProjectRecordMoves(
  deps: ProjectRecordDeps,
  collection = 'tasks/board',
): void {
  const root = assertRoot(deps.projectsDir);
  const directory = join(root, MOVE_DIR);
  const stat = statOrUndefined(directory);
  if (!stat) return;
  assertDirectory(directory, 'Move intent directory');
  const entries = readdirSync(directory, { withFileTypes: true });
  const intents = entries.filter((entry) => entry.name.endsWith('.json'));
  if (intents.length > 0) assertProjectMutationAllowed(root);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Move intent must not be a symlink: ${path}`);
    if (entry.isFile() && entry.name.endsWith('.json')) recoverIntent(deps, path, collection);
  }
}

export function moveProjectRecord(options: {
  deps: ProjectRecordDeps;
  sourcePath: string;
  destinationPath: string;
  destinationBytes: string;
  collection?: string;
}): void {
  const {
    deps,
    sourcePath,
    destinationPath,
    destinationBytes,
    collection = 'tasks/board',
  } = options;
  const root = assertRoot(deps.projectsDir);
  assertProjectMutationAllowed(root);
  validateMovePath(deps, sourcePath, collection);
  validateMovePath(deps, destinationPath, collection);
  const sourceStat = statOrUndefined(sourcePath);
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw new Error(`Move source is not a regular file: ${sourcePath}`);
  const destinationStat = statOrUndefined(destinationPath);
  if (destinationStat?.isSymbolicLink())
    throw new Error(`Move destination must not be a symlink: ${destinationPath}`);
  if (
    destinationStat &&
    sha256(readFileSync(destinationPath, 'utf8')) !== sha256(destinationBytes)
  ) {
    throw new Error(`Move destination conflicts: ${destinationPath}`);
  }
  const intentPath = moveIntentPath(root, randomUUID());
  atomicWrite(
    root,
    intentPath,
    JSON.stringify({
      sourcePath,
      destinationPath,
      sourceHash: sha256(readFileSync(sourcePath, 'utf8')),
      destinationHash: sha256(destinationBytes),
      destinationBytes,
    }),
  );
  recoverIntent(deps, intentPath, collection);
}

export function resolveProjectRecordLocation(options: {
  deps: ProjectRecordDeps;
  collection: string;
  projectId: string | undefined;
  recordId: string;
}): ProjectRecordLocation {
  const { deps, collection, projectId, recordId } = options;
  assertSafeRelativePath(collection);
  assertSafeRecordId(recordId);
  const projects = deps.projects();
  const project = projectId
    ? projects.find((candidate) => candidate.id === projectId)
    : projects.find((candidate) => candidate.id === 'meta' || candidate.fsPath === 'system');
  if (!project) throw new Error(`Unknown project: ${projectId ?? 'system'}`);
  assertSafeRelativePath(project.fsPath);
  const root = assertRoot(deps.projectsDir);
  assertDirectory(join(root, project.fsPath), 'Project directory');
  const directory = join(root, project.fsPath, collection);
  assertNoSymlinkComponents(root, join(root, project.fsPath));
  return {
    projectId: project.id,
    fsPath: project.fsPath,
    directory,
    filePath: join(directory, `${recordId}.yaml`),
    system: project.id === 'meta' || project.fsPath === 'system',
  };
}

export function listProjectRecordDirectories(
  deps: ProjectRecordDeps,
  collection: string,
): Array<{ projectId: string; fsPath: string; directory: string; system: boolean }> {
  assertSafeRelativePath(collection);
  const root = assertRoot(deps.projectsDir);
  return deps.projects().map((project) => {
    assertSafeRelativePath(project.fsPath);
    const directory = join(root, project.fsPath, collection);
    assertNoSymlinkComponents(root, join(root, project.fsPath));
    return {
      projectId: project.id,
      fsPath: project.fsPath,
      directory,
      system: project.id === 'meta' || project.fsPath === 'system',
    };
  });
}
