import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createLogger, type ProjectMemoryBudget } from '@raven/shared';
import { ProjectMutationError, withProjectMutation } from '../project-manager/project-mutation.ts';
import type { ProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { readProjectTextFile } from '../project-manager/project-file-read.ts';

const log = createLogger('memory-store');
const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_TOTAL_KB = 64;
const BYTES_PER_KB = 1024;
const MAX_MEMORY_FILE_BYTES = 1_048_576;
const MAX_MEMORY_ENTRIES = 2_000;
const MAX_MEMORY_DEPTH = 32;
const INDEX_FILE = 'MEMORY.md';
const BAD_REQUEST = 400;

export interface MemoryUsage {
  files: number;
  totalBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
  usage?: MemoryUsage;
}

export interface MemoryStore {
  read(projectId: string, relPath: string): Promise<string>;
  readIndex(projectId: string): Promise<string | null>;
  write(projectId: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  update(projectId: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  remove(projectId: string, relPath: string): Promise<MemoryWriteResult>;
  list(projectId: string): Promise<string[]>;
  usage(projectId: string): Promise<MemoryUsage>;
  getDirectory(projectId: string): string;
  withDirectory<T>(projectId: string, operation: (directory: string) => Promise<T>): Promise<T>;
  apply(projectId: string, input: MemoryApplyInput): Promise<MemoryWriteResult>;
}

export interface MemoryApplyInput {
  action: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  expected: string | null;
}

interface MemoryBudget {
  maxFiles: number;
  maxTotalBytes: number;
}

interface MemoryFile {
  path: string;
  name: string;
  size: number;
}

interface WriteInput {
  directory: string;
  relPath: string;
  content: string;
  mustExist: boolean;
  requireAbsent?: boolean;
  budget: MemoryBudget;
  expected: string | undefined;
}

export function formatMemoryBlock(index: string): string {
  return [
    '## Your Memory',
    'This is the index of what this project remembers. Use the `memory_read` tool to',
    'read a specific file, `memory_write` to save a new note, and `memory_update` to revise',
    'an existing one. Keep entries concise — your memory has a hard budget.',
    '',
    index.trim(),
  ].join('\n');
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

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  let current = absolute.startsWith('/') ? '/' : '';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = join(current, part);
    const stats = statOrUndefined(current);
    if (stats?.isSymbolicLink()) throw mutationError(`Memory path contains a symlink: ${path}`);
    if (!stats) return;
  }
}

function validateRelativePath(relPath: string, allowInternal: boolean): string[] {
  if (!isRelativeString(relPath)) {
    throw mutationError(`Invalid memory path: ${String(relPath)}`, BAD_REQUEST);
  }
  if (relPath.includes('\\')) throw mutationError(`Invalid memory path: ${relPath}`, BAD_REQUEST);
  const parts = relPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw mutationError(`Invalid memory path: ${relPath}`, BAD_REQUEST);
  }
  if (!parts.at(-1)?.endsWith('.md')) {
    throw mutationError(`Memory paths must be Markdown files: ${relPath}`, BAD_REQUEST);
  }
  if (!allowInternal && parts.some((part) => part === 'candidates' || part.startsWith('.'))) {
    throw mutationError(`Internal memory path is not available: ${relPath}`, BAD_REQUEST);
  }
  return parts;
}

function isRelativeString(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\0');
}

/** Resolve a safe Markdown path under a project memory directory. */
export function resolveMemoryPath(
  directory: string,
  relPath: string,
  allowInternal = false,
): string {
  const parts = validateRelativePath(relPath, allowInternal);
  const root = resolve(directory);
  const target = resolve(root, ...parts);
  const child = relative(root, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw mutationError(`Memory path escapes its project: ${relPath}`, BAD_REQUEST);
  }
  assertNoSymlinkComponents(root);
  assertNoSymlinkComponents(dirname(target));
  assertNoSymlinkComponents(target);
  return target;
}

function memoryBudget(value: ProjectMemoryBudget | undefined): MemoryBudget {
  return {
    maxFiles: value?.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: (value?.maxTotalKb ?? DEFAULT_MAX_TOTAL_KB) * BYTES_PER_KB,
  };
}

function readText(path: string): string | undefined {
  return readProjectTextFile(path, MAX_MEMORY_FILE_BYTES);
}

interface ScanState {
  root: string;
  directory: string;
  current: string;
  depth: number;
  files: MemoryFile[];
  counter: { value: number };
}

function currentPath(current: string, name: string): string {
  return current ? current + '/' + name : name;
}

async function scanMemoryEntry(state: ScanState, entry: Dirent): Promise<void> {
  if (entry.name === 'candidates' || entry.name.startsWith('.')) return;
  const childName = currentPath(state.current, entry.name);
  if (entry.isSymbolicLink()) throw mutationError('Memory path contains a symlink: ' + childName);
  if (entry.isDirectory()) {
    const childPath = join(state.root, childName);
    assertNoSymlinkComponents(childPath);
    await scanMemoryDirectory({
      ...state,
      directory: childPath,
      current: childName,
      depth: state.depth + 1,
    });
    return;
  }
  if (!entry.isFile() || !entry.name.endsWith('.md')) return;
  const childPath = resolveMemoryPath(state.root, childName);
  const text = readText(childPath);
  if (text === undefined) throw mutationError('Memory file disappeared: ' + childName);
  state.files.push({ path: childPath, name: childName, size: Buffer.byteLength(text) });
}

async function scanMemoryDirectory(state: ScanState): Promise<void> {
  if (state.depth > MAX_MEMORY_DEPTH) throw mutationError('Memory directory is too deep');
  let entries;
  try {
    entries = await readdir(state.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && state.current === '') return;
    throw error;
  }
  for (const entry of entries) {
    state.counter.value += 1;
    if (state.counter.value > MAX_MEMORY_ENTRIES) {
      throw mutationError('Too many memory entries');
    }
    await scanMemoryEntry(state, entry);
  }
}

async function memoryFiles(directory: string): Promise<MemoryFile[]> {
  assertNoSymlinkComponents(directory);
  const files: MemoryFile[] = [];
  await scanMemoryDirectory({
    root: directory,
    directory,
    current: '',
    depth: 0,
    files,
    counter: { value: 0 },
  });
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function usageFrom(files: MemoryFile[], budget: MemoryBudget): MemoryUsage {
  return {
    files: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    maxFiles: budget.maxFiles,
    maxTotalBytes: budget.maxTotalBytes,
  };
}

function flushDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(dirname(path));
}

function expectedBytes(path: string): string | undefined {
  return readText(path);
}

function atomicWrite(path: string, content: string, expected?: string): void {
  ensureParent(path);
  if (expectedBytes(path) !== expected) throw mutationError('Memory file changed during update');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (expectedBytes(path) !== expected) throw mutationError('Memory file changed during update');
    renameSync(temporary, path);
    flushDirectory(dirname(path));
  } finally {
    if (statOrUndefined(temporary)) unlinkSync(temporary);
  }
}

function budgetFailure(
  usage: MemoryUsage,
  files: number,
  bytes: number,
): MemoryWriteResult | undefined {
  if (files > usage.maxFiles) {
    return {
      ok: false,
      error: `memory budget exceeded: ${files} files > ${usage.maxFiles} max.`,
      usage,
    };
  }
  if (bytes > usage.maxTotalBytes) {
    return {
      ok: false,
      error: `memory budget exceeded: ${bytes} bytes > ${usage.maxTotalBytes} max.`,
      usage,
    };
  }
  return undefined;
}

function writeTargetError(
  input: WriteInput,
  existing: ReturnType<typeof lstatSync> | undefined,
): MemoryWriteResult | undefined {
  if (existing?.isDirectory())
    return { ok: false, error: 'memory path is a directory, not a file' };
  if (input.requireAbsent && existing) return { ok: false, error: 'memory file already exists' };
  if (!input.mustExist || existing) return undefined;
  if (input.expected !== undefined) throw mutationError('Memory file changed during update');
  return { ok: false, error: 'memory file does not exist' };
}

function writeBudgetFailure(input: WriteInput, files: MemoryFile[]): MemoryWriteResult | undefined {
  const path = resolveMemoryPath(input.directory, input.relPath);
  const existing = statOrUndefined(path);
  const previous = files.find((file) => file.path === path)?.size ?? 0;
  const usage = usageFrom(files, input.budget);
  return budgetFailure(
    usage,
    existing ? files.length : files.length + 1,
    usage.totalBytes - previous + Buffer.byteLength(input.content),
  );
}

async function writeMemoryFile(input: WriteInput): Promise<MemoryWriteResult> {
  const path = resolveMemoryPath(input.directory, input.relPath);
  const existing = statOrUndefined(path);
  const targetError = writeTargetError(input, existing);
  if (targetError) return targetError;
  const files = await memoryFiles(input.directory);
  const failure = writeBudgetFailure(input, files);
  if (failure) return failure;
  atomicWrite(path, input.content, input.expected);
  const after = usageFrom(await memoryFiles(input.directory), input.budget);
  log.info(`memory ${input.mustExist ? 'updated' : 'written'}: ${input.relPath}`);
  return { ok: true, usage: after };
}

interface RemoveInput {
  directory: string;
  relPath: string;
  budget: MemoryBudget;
  expected?: string | null;
}

async function removeMemoryFile(input: RemoveInput): Promise<MemoryWriteResult> {
  const { directory, relPath, budget, expected } = input;
  const path = resolveMemoryPath(directory, relPath);
  const stats = statOrUndefined(path);
  if (!stats) {
    if (expected !== undefined) throw mutationError('Memory file changed during removal');
    return { ok: false, error: `memory file does not exist: ${relPath}` };
  }
  if (stats.isDirectory()) return { ok: false, error: `memory path is a directory: ${relPath}` };
  if (expected === null) throw mutationError('Memory file changed during removal');
  const snapshot = expected === undefined ? expectedBytes(path) : expected;
  if (snapshot === undefined) return { ok: false, error: `memory file does not exist: ${relPath}` };
  if (expected !== undefined && expectedBytes(path) !== expected) {
    throw mutationError('Memory file changed during removal');
  }
  unlinkSync(path);
  flushDirectory(dirname(path));
  return { ok: true, usage: usageFrom(await memoryFiles(directory), budget) };
}

export interface MemoryStoreDeps {
  projectsDir: string;
  workspaceStore: ProjectWorkspaceStore;
}

interface StoreContext {
  getDirectory(projectId: string): string;
  getBudget(projectId: string): MemoryBudget;
  withDirectory<T>(projectId: string, operation: (directory: string) => Promise<T>): Promise<T>;
}

function projectMemoryDirectory(store: ProjectWorkspaceStore, projectId: string): string {
  store.getWorkspace(projectId);
  return join(store.getProjectHome(projectId), 'memory');
}

function createStoreContext(deps: MemoryStoreDeps): StoreContext {
  const getDirectory = (projectId: string): string =>
    projectMemoryDirectory(deps.workspaceStore, projectId);
  const getBudget = (projectId: string): MemoryBudget =>
    memoryBudget(deps.workspaceStore.getWorkspace(projectId).memory);
  const withDirectory = <T>(
    projectId: string,
    operation: (directory: string) => Promise<T>,
  ): Promise<T> =>
    withProjectMutation(deps.projectsDir, async () => {
      const directory = getDirectory(projectId);
      assertNoSymlinkComponents(directory);
      return operation(directory);
    });
  return { getDirectory, getBudget, withDirectory };
}

async function readStoreFile(
  context: StoreContext,
  projectId: string,
  relPath: string,
): Promise<string> {
  const text = readText(resolveMemoryPath(context.getDirectory(projectId), relPath));
  if (text === undefined) throw new Error('Memory file does not exist: ' + relPath);
  return text;
}

async function readStoreIndex(context: StoreContext, projectId: string): Promise<string | null> {
  return readText(resolveMemoryPath(context.getDirectory(projectId), INDEX_FILE)) ?? null;
}

interface StoreWriteInput {
  projectId: string;
  relPath: string;
  content: string;
  mustExist: boolean;
}

async function writeStoreFile(
  context: StoreContext,
  input: StoreWriteInput,
): Promise<MemoryWriteResult> {
  return context.withDirectory(input.projectId, async (directory) => {
    const path = resolveMemoryPath(directory, input.relPath);
    const expected = statOrUndefined(path)?.isDirectory() ? undefined : expectedBytes(path);
    return writeMemoryFile({
      directory,
      relPath: input.relPath,
      content: input.content,
      mustExist: input.mustExist,
      budget: context.getBudget(input.projectId),
      expected,
    });
  });
}

async function removeStoreFile(
  context: StoreContext,
  projectId: string,
  relPath: string,
): Promise<MemoryWriteResult> {
  return context.withDirectory(projectId, (directory) =>
    removeMemoryFile({ directory, relPath, budget: context.getBudget(projectId) }),
  );
}

async function applyStoreFile(
  context: StoreContext,
  input: { projectId: string; input: MemoryApplyInput },
): Promise<MemoryWriteResult> {
  const { projectId, input: change } = input;
  if (change.action === 'create' && change.expected !== null) {
    throw mutationError('Create requires an absent expected value', BAD_REQUEST);
  }
  if (change.action !== 'create' && change.expected === null) {
    throw mutationError('Update and delete require expected file bytes', BAD_REQUEST);
  }
  return context.withDirectory(projectId, async (directory) => {
    if (change.action === 'delete') {
      return removeMemoryFile({
        directory,
        relPath: change.path,
        budget: context.getBudget(projectId),
        expected: change.expected,
      });
    }
    if (change.content === undefined) {
      throw mutationError('Memory content is required', BAD_REQUEST);
    }
    return writeMemoryFile({
      directory,
      relPath: change.path,
      content: change.content,
      mustExist: change.action === 'update',
      requireAbsent: change.action === 'create',
      budget: context.getBudget(projectId),
      expected: change.expected ?? undefined,
    });
  });
}

export function createMemoryStore(deps: MemoryStoreDeps): MemoryStore {
  const context = createStoreContext(deps);
  return {
    getDirectory: context.getDirectory,
    withDirectory: context.withDirectory,
    read: (projectId, relPath) => readStoreFile(context, projectId, relPath),
    readIndex: (projectId) => readStoreIndex(context, projectId),
    write: (projectId, relPath, content) =>
      writeStoreFile(context, { projectId, relPath, content, mustExist: false }),
    update: (projectId, relPath, content) =>
      writeStoreFile(context, { projectId, relPath, content, mustExist: true }),
    remove: (projectId, relPath) => removeStoreFile(context, projectId, relPath),
    apply: (projectId, input) => applyStoreFile(context, { projectId, input }),
    async list(projectId) {
      return (await memoryFiles(context.getDirectory(projectId))).map((file) => file.name);
    },
    async usage(projectId) {
      const budget = context.getBudget(projectId);
      return usageFrom(await memoryFiles(context.getDirectory(projectId)), budget);
    },
  };
}
