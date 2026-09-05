import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ProjectWorkspaceSchema } from '@raven/shared';
import { readProjectTextFile } from '../project-file-read.ts';
import type Database from 'better-sqlite3';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';
import { projectReferences } from '../project-cache.ts';
import { readProjectDefinition } from '../../project-registry/project-definition.ts';
import { ProjectMutationError, withProjectMutation } from '../project-mutation.ts';

const JOURNAL_DIR = '.project-mutations';
const VERSION = 1;
const JOURNAL_FILE_MODE = 0o600;
const MAX_MUTATION_SOURCE_BYTES = 16_777_216;
const JOURNAL_SUFFIX_LENGTH = '.yaml'.length;
const PREPARED_PREFIX = `${JOURNAL_DIR}/prepared-`;
const ARCHIVE_PREFIX = '.archive/';
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const JournalSchemaBase = z.object({
  version: z.literal(VERSION),
  mutationId: z.string().min(1),
  operation: z.enum(['create', 'update', 'archive']),
  projectId: z.string().min(1),
  path: z.string().min(1),
  originalBytes: z.string(),
  intendedBytes: z.string(),
  originalHash: Hash,
  intendedHash: Hash,
  preparedPath: z.string().min(1).optional(),
  archivePath: z.string().min(1).optional(),
  archiveJson: z.string().optional(),
  archiveJsonHash: Hash.optional(),
  workspaceBytes: z.string().optional(),
  workspaceHash: Hash.optional(),
});
const JournalSchema = JournalSchemaBase.strict().superRefine((entry, context) =>
  validateJournal(entry, context),
);

function validateJournal(entry: z.infer<typeof JournalSchemaBase>, context: z.RefinementCtx): void {
  validateJournalHashes(entry, context);
  validateArchiveMetadata(entry, context);
  validateCreateMetadata(entry, context);
  validateWorkspaceMetadata(entry, context);
}

function validateWorkspaceMetadata(
  entry: z.infer<typeof JournalSchemaBase>,
  context: z.RefinementCtx,
): void {
  const hasBytes = entry.workspaceBytes !== undefined;
  const hasHash = entry.workspaceHash !== undefined;
  if (hasBytes !== hasHash) {
    context.addIssue({ code: 'custom', message: 'Workspace bytes and hash must be paired' });
    return;
  }
  if (hasBytes && entry.operation !== 'create' && entry.operation !== 'archive') {
    context.addIssue({
      code: 'custom',
      message: 'Only create and archive mutations may have workspace metadata',
    });
  }
  if (entry.workspaceBytes === undefined || entry.workspaceHash === undefined) return;
  if (sha256(entry.workspaceBytes) !== entry.workspaceHash) {
    context.addIssue({ code: 'custom', message: 'Workspace bytes do not match workspace hash' });
  }
  try {
    ProjectWorkspaceSchema.parse(parse(entry.workspaceBytes));
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: `Workspace bytes are invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function validateArchiveMetadata(
  entry: z.infer<typeof JournalSchemaBase>,
  context: z.RefinementCtx,
): void {
  const hasAny =
    entry.archivePath !== undefined ||
    entry.archiveJson !== undefined ||
    entry.archiveJsonHash !== undefined;
  const complete = entry.archivePath && entry.archiveJson && entry.archiveJsonHash;
  if (entry.operation === 'archive' && !complete) {
    context.addIssue({ code: 'custom', message: 'Archive snapshot hash is missing' });
  }
  if (entry.operation !== 'archive' && hasAny) {
    context.addIssue({
      code: 'custom',
      message: 'Only archive mutations may have archive metadata',
    });
  }
  validateArchiveHash(entry, context);
}

function validateArchiveHash(
  entry: z.infer<typeof JournalSchemaBase>,
  context: z.RefinementCtx,
): void {
  if (entry.operation === 'archive' && entry.originalBytes !== entry.intendedBytes) {
    context.addIssue({ code: 'custom', message: 'Archive must retain the original context bytes' });
  }
  if (!entry.archiveJson || !entry.archiveJsonHash) return;
  if (sha256(entry.archiveJson) !== entry.archiveJsonHash) {
    context.addIssue({ code: 'custom', message: 'Archive snapshot bytes do not match hash' });
  }
}

function validateCreateMetadata(
  entry: z.infer<typeof JournalSchemaBase>,
  context: z.RefinementCtx,
): void {
  if (entry.operation === 'create' && !entry.preparedPath) {
    context.addIssue({ code: 'custom', message: 'Create staging path is missing' });
  }
  if (entry.operation === 'create' && entry.originalBytes !== '') {
    context.addIssue({ code: 'custom', message: 'Create cannot replace existing context bytes' });
  }
  if (entry.operation !== 'create' && entry.preparedPath) {
    context.addIssue({ code: 'custom', message: 'Only create mutations may have a staging path' });
  }
}

function validateJournalHashes(
  entry: z.infer<typeof JournalSchemaBase>,
  context: z.RefinementCtx,
): void {
  if (sha256(entry.originalBytes) !== entry.originalHash) {
    context.addIssue({ code: 'custom', message: 'Original bytes do not match original hash' });
  }
  if (sha256(entry.intendedBytes) !== entry.intendedHash) {
    context.addIssue({ code: 'custom', message: 'Intended bytes do not match intended hash' });
  }
}

export type ProjectMutationJournal = z.infer<typeof JournalSchema>;

export interface ProjectRecoveryEntry {
  mutationId: string;
  operation: ProjectMutationJournal['operation'] | 'unknown';
  projectId?: string;
  path: string;
  archivePath?: string;
  state: 'preparing' | 'published' | 'conflict' | 'invalid';
  message: string;
}

export interface ProjectRecoveryReport {
  pendingProjectPaths: string[];
  entries: ProjectRecoveryEntry[];
}

export interface RecoveryDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  db?: Database.Database;
}

export interface RecoveryResult {
  mutationId: string;
  status: 'completed' | 'cancelled';
  operation: ProjectMutationJournal['operation'];
  projectId: string;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function journalDirectory(root: string): string {
  return resolve(root, JOURNAL_DIR);
}

function safeRelative(root: string, path: string): string {
  assertSafeSyntax(path);
  const base = resolve(root);
  assertRealRoot(root);
  assertNoSymlinkComponents(base, path);
  const rel = relative(base, resolve(base, path));
  if (!rel || rel.startsWith('..')) {
    throw new ProjectMutationError(`Unsafe project recovery path: ${path}`);
  }
  return rel;
}

function assertSafeSyntax(path: string): void {
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new ProjectMutationError(`Unsafe project recovery path: ${path}`);
  }
}

function assertNoSymlinkComponents(base: string, path: string): void {
  let current = base;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ProjectMutationError(`Project recovery path contains a symlink: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
}

function assertRealRoot(root: string): void {
  const resolved = resolve(root);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(resolved) !== resolved) {
    throw new ProjectMutationError(`Project root must be a real directory: ${root}`);
  }
}

function journalPath(root: string, mutationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mutationId)) {
    throw new ProjectMutationError(`Unsafe project mutation identity: ${mutationId}`);
  }
  return join(journalDirectory(root), `${mutationId}.yaml`);
}

function flushDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWriteSync(path: string, bytes: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', JOURNAL_FILE_MODE);
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    flushDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function createMutationJournal(input: {
  projectsDir: string;
  operation: ProjectMutationJournal['operation'];
  projectId: string;
  path: string;
  originalBytes: string;
  intendedBytes: string;
  preparedPath?: string;
  archivePath?: string;
  archiveJson?: string;
  workspaceBytes?: string;
}): ProjectMutationJournal {
  const mutationId = randomUUID();
  const journal: ProjectMutationJournal = {
    version: VERSION,
    mutationId,
    operation: input.operation,
    projectId: input.projectId,
    path: safeRelative(input.projectsDir, input.path),
    originalBytes: input.originalBytes,
    intendedBytes: input.intendedBytes,
    originalHash: sha256(input.originalBytes),
    intendedHash: sha256(input.intendedBytes),
    ...(input.preparedPath
      ? { preparedPath: safeRelative(input.projectsDir, input.preparedPath) }
      : {}),
    ...(input.archivePath
      ? { archivePath: safeRelative(input.projectsDir, input.archivePath) }
      : {}),
    ...(input.archiveJson
      ? { archiveJson: input.archiveJson, archiveJsonHash: sha256(input.archiveJson) }
      : {}),
    ...(input.workspaceBytes !== undefined
      ? { workspaceBytes: input.workspaceBytes, workspaceHash: sha256(input.workspaceBytes) }
      : {}),
  };
  JournalSchema.parse(journal);
  assertJournalShape(input.projectsDir, journal);
  mkdirSync(journalDirectory(input.projectsDir), { recursive: true });
  flushDirectory(resolve(input.projectsDir));
  flushDirectory(journalDirectory(input.projectsDir));
  atomicWriteSync(journalPath(input.projectsDir, mutationId), stringify(journal));
  return journal;
}

export function readProjectMutationRecordsSync(projectsDir: string): ProjectMutationJournal[] {
  assertRealRoot(projectsDir);
  const directory = journalDirectory(projectsDir);
  if (!existsSync(directory)) return [];
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new ProjectMutationError('Project mutation journal directory is unsafe');
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.endsWith('.yaml'))
    .map((entry) => {
      if (!entry.isFile())
        throw new ProjectMutationError('Project mutation journal entry is unsafe');
      return readJournalFile(join(directory, entry.name), projectsDir);
    });
}

function readJournalFile(path: string, projectsDir: string): ProjectMutationJournal {
  assertRealRoot(projectsDir);
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  safeRelative(projectsDir, `${JOURNAL_DIR}/${fileName}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProjectMutationError('Project mutation journal entry is unsafe');
  }
  if (
    resolve(path) !==
    resolve(journalPath(projectsDir, path.slice(path.lastIndexOf('/') + 1, -JOURNAL_SUFFIX_LENGTH)))
  ) {
    throw new ProjectMutationError('Project mutation journal path is unsafe');
  }
  const entry = JournalSchema.parse(parse(readFileSync(path, 'utf8')));
  if (journalPath(projectsDir, entry.mutationId) !== path) {
    throw new ProjectMutationError(`Project mutation journal filename does not match identity`);
  }
  safeRelative(projectsDir, entry.path);
  if (entry.preparedPath) safeRelative(projectsDir, entry.preparedPath);
  if (entry.archivePath) safeRelative(projectsDir, entry.archivePath);
  assertJournalShape(projectsDir, entry);
  return entry;
}

function assertJournalShape(root: string, entry: ProjectMutationJournal): void {
  if (entry.operation === 'create') {
    const path = entry.preparedPath;
    if (
      !path ||
      !path.startsWith(PREPARED_PREFIX) ||
      !/^\.project-mutations\/prepared-[A-Za-z0-9-]+$/.test(path)
    ) {
      throw new ProjectMutationError(`Create journal staging path is unsafe`);
    }
  }
  if (entry.operation === 'archive') {
    const path = entry.archivePath;
    if (!path || !path.startsWith(ARCHIVE_PREFIX) || !/^\.archive\/[A-Za-z0-9-]+$/.test(path)) {
      throw new ProjectMutationError(`Archive journal path is unsafe`);
    }
  }
  assertContextIdentity({
    bytes: entry.originalBytes,
    projectId: entry.projectId,
    path: entry.path,
    allowEmpty: true,
  });
  assertContextIdentity({
    bytes: entry.intendedBytes,
    projectId: entry.projectId,
    path: entry.path,
    allowEmpty: false,
  });
  if (entry.archiveJson) assertArchiveIdentity(entry.archiveJson, entry.projectId, entry.path);
  safeRelative(root, entry.path);
}

function assertContextIdentity(input: {
  bytes: string;
  projectId: string;
  path: string;
  allowEmpty: boolean;
}): void {
  if (input.allowEmpty && input.bytes.length === 0) return;
  const definition = readProjectDefinition(input.bytes);
  assertMetadataIdentity(definition.metadata?.id, input.projectId);
  if (!definition.metadata?.id) assertPlainIdentity(input.projectId, input.path);
}

function assertMetadataIdentity(metadataId: string | undefined, projectId: string): void {
  if (metadataId && metadataId !== projectId) {
    throw new ProjectMutationError(`Project mutation context identity conflicts`);
  }
}

function assertPlainIdentity(projectId: string, path: string): void {
  const isSystem = path === 'system' && projectId === 'meta';
  if (projectId !== path && !isSystem) {
    throw new ProjectMutationError(`Plain project mutation identity conflicts`);
  }
}

function assertArchiveIdentity(bytes: string, projectId: string, path: string): void {
  const snapshot = JSON.parse(bytes) as { id?: unknown; fsPath?: unknown };
  if (snapshot.id !== projectId || snapshot.fsPath !== path) {
    throw new ProjectMutationError(`Archived project snapshot identity conflicts`);
  }
}

function contextPath(root: string, path: string): string {
  return join(resolve(root, safeRelative(root, path)), 'context.md');
}

function currentHash(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const bytes = readProjectTextFile(path, MAX_MUTATION_SOURCE_BYTES);
    return bytes === undefined ? undefined : sha256(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function workspaceState(
  path: string,
  expectedHash: string | undefined,
): 'matching' | 'missing' | 'conflict' {
  const workspacePath = join(path, 'project.yaml');
  const present = existsSync(workspacePath);
  const actualHash = currentHash(workspacePath);
  if (expectedHash === undefined) return present ? 'conflict' : 'matching';
  if (actualHash === expectedHash) return 'matching';
  return present ? 'conflict' : 'missing';
}

function directoryState(
  path: string,
  expectedContextHash: string,
  expectedWorkspaceHash?: string,
): 'missing' | 'matching' | 'conflict' {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'conflict';
    return classifyDirectoryContents(path, expectedContextHash, expectedWorkspaceHash);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function classifyDirectoryContents(
  path: string,
  expectedContextHash: string,
  expectedWorkspaceHash?: string,
): 'missing' | 'matching' | 'conflict' {
  const entries = readdirSync(path);
  const allowed =
    expectedWorkspaceHash === undefined ? ['context.md'] : ['context.md', 'project.yaml'];
  if (entries.some((entry) => !allowed.includes(entry))) return 'conflict';
  const contextHash = currentHash(join(path, 'context.md'));
  const workspaceHash =
    expectedWorkspaceHash === undefined ? undefined : currentHash(join(path, 'project.yaml'));
  if (entries.includes('context.md') && contextHash === undefined) return 'conflict';
  if (
    expectedWorkspaceHash !== undefined &&
    entries.includes('project.yaml') &&
    workspaceHash === undefined
  ) {
    return 'conflict';
  }
  return classifyDirectoryHashes({
    contextHash,
    expectedContextHash,
    workspaceHash,
    expectedWorkspaceHash,
  });
}

function classifyDirectoryHashes(input: {
  contextHash: string | undefined;
  expectedContextHash: string;
  workspaceHash: string | undefined;
  expectedWorkspaceHash: string | undefined;
}): 'missing' | 'matching' | 'conflict' {
  if (
    input.contextHash === input.expectedContextHash &&
    input.workspaceHash === input.expectedWorkspaceHash
  ) {
    return 'matching';
  }
  if (
    (input.contextHash !== undefined && input.contextHash !== input.expectedContextHash) ||
    (input.workspaceHash !== undefined && input.workspaceHash !== input.expectedWorkspaceHash)
  ) {
    return 'conflict';
  }
  return 'missing';
}

function classifyJournal(root: string, entry: ProjectMutationJournal): ProjectRecoveryEntry {
  safeRelative(root, entry.path);
  if (entry.operation === 'create') return classifyCreate(root, entry);
  if (entry.operation === 'update') return classifyUpdate(root, entry);
  return classifyArchive(root, entry);
}

function classifyCreate(root: string, entry: ProjectMutationJournal): ProjectRecoveryEntry {
  const source = resolve(root, entry.path);
  const published = directoryState(source, entry.intendedHash, entry.workspaceHash);
  if (published === 'missing' && existsSync(source)) {
    return recoveryEntry(entry, 'conflict', 'published create files are incomplete');
  }
  if (published === 'missing' && entry.preparedPath) {
    safeRelative(root, entry.preparedPath);
    const prepared = directoryState(
      resolve(root, entry.preparedPath),
      entry.intendedHash,
      entry.workspaceHash,
    );
    if (prepared === 'conflict')
      return recoveryEntry(entry, 'conflict', 'create staging conflicts');
  }
  if (published === 'missing') return recoveryEntry(entry, 'preparing', 'create not published');
  return recoveryEntry(entry, published === 'matching' ? 'published' : published, 'create state');
}

function classifyUpdate(root: string, entry: ProjectMutationJournal): ProjectRecoveryEntry {
  const hash = currentHash(contextPath(root, entry.path));
  const state =
    hash === entry.intendedHash
      ? 'published'
      : hash === entry.originalHash
        ? 'preparing'
        : 'conflict';
  return recoveryEntry(entry, state, 'update state');
}

function classifyArchive(root: string, entry: ProjectMutationJournal): ProjectRecoveryEntry {
  if (!entry.archivePath || !entry.archiveJsonHash) {
    return recoveryEntry(entry, 'invalid', 'archive journal metadata is incomplete');
  }
  const sourceHash = currentHash(contextPath(root, entry.path));
  const source = resolve(root, entry.path);
  safeRelative(root, entry.archivePath);
  const archiveDir = resolve(root, entry.archivePath);
  const archiveContext = currentHash(join(archiveDir, 'context.md'));
  const archiveJson = currentHash(join(archiveDir, 'archive.json'));
  const sourceWorkspace = workspaceState(source, entry.workspaceHash);
  if (sourceHash === entry.originalHash && sourceWorkspace !== 'matching') {
    return recoveryEntry(entry, 'conflict', 'source workspace does not match journal');
  }
  if (sourceHash === entry.originalHash && !existsSync(archiveDir)) {
    return recoveryEntry(entry, 'preparing', 'archive has not moved');
  }
  const archiveWorkspace = currentHash(join(archiveDir, 'project.yaml'));
  const archiveState = archiveContentsState(archiveDir, {
    archiveJsonHash: archiveJson,
    expectedArchiveJsonHash: entry.archiveJsonHash,
    workspaceHash: archiveWorkspace,
    expectedWorkspaceHash: entry.workspaceHash,
  });
  if (
    sourceHash === undefined &&
    archiveContext === entry.originalHash &&
    archiveState !== 'conflict'
  ) {
    return recoveryEntry(entry, 'published', 'archive is complete');
  }
  return recoveryEntry(entry, 'conflict', 'archive paths or contents do not match journal');
}

function archiveContentsState(
  path: string,
  input: {
    archiveJsonHash: string | undefined;
    expectedArchiveJsonHash: string | undefined;
    workspaceHash: string | undefined;
    expectedWorkspaceHash: string | undefined;
  },
): 'matching' | 'missing' | 'conflict' {
  try {
    return classifyArchiveContents(readdirSync(path), input);
  } catch {
    return 'conflict';
  }
}

function classifyArchiveContents(
  entries: string[],
  input: {
    archiveJsonHash: string | undefined;
    expectedArchiveJsonHash: string | undefined;
    workspaceHash: string | undefined;
    expectedWorkspaceHash: string | undefined;
  },
): 'matching' | 'missing' | 'conflict' {
  const allowed =
    input.expectedWorkspaceHash === undefined
      ? ['context.md', 'archive.json']
      : ['context.md', 'archive.json', 'project.yaml'];
  if (entries.some((entry) => !allowed.includes(entry))) return 'conflict';
  if (!entries.includes('context.md')) return 'conflict';
  if (input.expectedWorkspaceHash === undefined && input.workspaceHash !== undefined)
    return 'conflict';
  if (
    input.expectedWorkspaceHash !== undefined &&
    input.workspaceHash !== input.expectedWorkspaceHash
  ) {
    return 'conflict';
  }
  if (!entries.includes('archive.json')) return 'missing';
  return input.archiveJsonHash === input.expectedArchiveJsonHash ? 'matching' : 'conflict';
}

function recoveryEntry(
  entry: ProjectMutationJournal,
  state: ProjectRecoveryEntry['state'] | 'missing',
  message: string,
): ProjectRecoveryEntry {
  return {
    mutationId: entry.mutationId,
    operation: entry.operation,
    projectId: entry.projectId,
    path: entry.path,
    archivePath: entry.archivePath,
    state: state === 'missing' ? 'conflict' : state,
    message,
  };
}

export function readProjectRecoveryReport(projectsDir: string): ProjectRecoveryReport {
  const entries: ProjectRecoveryEntry[] = [];
  try {
    assertRealRoot(projectsDir);
  } catch (error) {
    return { pendingProjectPaths: ['.'], entries: [invalidRecoveryEntry('.', String(error))] };
  }
  const directory = journalDirectory(projectsDir);
  if (!existsSync(directory)) return { pendingProjectPaths: [], entries };
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('journal directory is unsafe');
  } catch (error) {
    return { pendingProjectPaths: ['.'], entries: [invalidRecoveryEntry('.', String(error))] };
  }
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (!item.name.endsWith('.yaml')) continue;
    if (!item.isFile()) {
      entries.push(invalidRecoveryEntry(item.name, 'journal entry is not a regular file'));
      continue;
    }
    try {
      entries.push(
        classifyJournal(projectsDir, readJournalFile(join(directory, item.name), projectsDir)),
      );
    } catch (error) {
      entries.push(invalidRecoveryEntry(item.name.slice(0, -JOURNAL_SUFFIX_LENGTH), String(error)));
    }
  }
  const pendingProjectPaths = entries.flatMap((entry) => [
    entry.state === 'invalid' ? '.' : entry.path,
    ...(entry.archivePath ? [entry.archivePath] : []),
  ]);
  return { pendingProjectPaths: [...new Set(pendingProjectPaths)], entries };
}

function invalidRecoveryEntry(mutationId: string, message: string): ProjectRecoveryEntry {
  return {
    mutationId,
    operation: 'unknown',
    path: '.',
    state: 'invalid',
    message,
  };
}

export function removeProjectMutationJournal(projectsDir: string, mutationId: string): void {
  assertRealRoot(projectsDir);
  safeRelative(projectsDir, `${JOURNAL_DIR}/${mutationId}.yaml`);
  const path = journalPath(projectsDir, mutationId);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ProjectMutationError('Project mutation journal entry is unsafe');
    }
    unlinkSync(path);
    flushDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function flushProjectMutationPath(path: string): void {
  flushDirectory(path);
}

async function loadAfterRecovery(deps: RecoveryDeps): Promise<void> {
  await deps.projectRegistry.load(deps.projectsDir);
}

async function cancelCreate(root: string, entry: ProjectMutationJournal): Promise<void> {
  if (!entry.preparedPath) return;
  const path = resolve(root, safeRelative(root, entry.preparedPath));
  const state = directoryState(path, entry.intendedHash, entry.workspaceHash);
  if (state === 'missing') {
    if (existsSync(path)) {
      removeKnownCreateFiles(path, entry.workspaceHash !== undefined);
      flushDirectory(dirname(path));
    }
    return;
  }
  if (state === 'conflict') {
    throw new ProjectMutationError(`Create staging changed during recovery`);
  }
  if (directoryState(path, entry.intendedHash, entry.workspaceHash) !== 'matching') {
    throw new ProjectMutationError(`Create staging changed during recovery`);
  }
  removeKnownCreateFiles(path, entry.workspaceHash !== undefined);
  flushDirectory(dirname(path));
  if (existsSync(path)) throw new ProjectMutationError(`Create staging could not be removed`);
}

function removeKnownCreateFiles(path: string, hasWorkspace: boolean): void {
  const contextPath = join(path, 'context.md');
  if (existsSync(contextPath)) unlinkSync(contextPath);
  const workspacePath = join(path, 'project.yaml');
  if (hasWorkspace && existsSync(workspacePath)) unlinkSync(workspacePath);
  rmdirSync(path);
}

async function recoverCreate(
  deps: RecoveryDeps,
  entry: ProjectMutationJournal,
  state: ProjectRecoveryEntry['state'],
): Promise<'completed' | 'cancelled'> {
  if (state === 'published') {
    removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
    await loadAfterRecovery(deps);
    return 'completed';
  }
  if (state === 'preparing') {
    await cancelCreate(deps.projectsDir, entry);
    removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
    return 'cancelled';
  }
  throw new ProjectMutationError(
    `Project mutation ${entry.mutationId} conflicts with current files`,
  );
}

async function recoverUpdate(
  deps: RecoveryDeps,
  entry: ProjectMutationJournal,
  state: ProjectRecoveryEntry['state'],
): Promise<'completed' | 'cancelled'> {
  if (state === 'published') {
    removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
    await loadAfterRecovery(deps);
    return 'completed';
  }
  if (state === 'preparing') {
    removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
    return 'cancelled';
  }
  throw new ProjectMutationError(
    `Project mutation ${entry.mutationId} conflicts with current files`,
  );
}

function assertArchiveSnapshot(entry: ProjectMutationJournal, archiveDir: string): void {
  if (!entry.archiveJson) {
    throw new ProjectMutationError(`Archived project snapshot is missing`);
  }
  const snapshotPath = join(archiveDir, 'archive.json');
  if (currentHash(snapshotPath) === undefined) {
    const state = archiveContentsState(archiveDir, {
      archiveJsonHash: undefined,
      expectedArchiveJsonHash: entry.archiveJsonHash,
      workspaceHash:
        entry.workspaceHash === undefined
          ? undefined
          : currentHash(join(archiveDir, 'project.yaml')),
      expectedWorkspaceHash: entry.workspaceHash,
    });
    if (state !== 'missing') {
      throw new ProjectMutationError(`Archived project snapshot path is unsafe`);
    }
    atomicWriteSync(snapshotPath, entry.archiveJson);
  }
  assertArchiveJsonSnapshot(entry, snapshotPath);
  assertArchiveWorkspaceSnapshot(entry, archiveDir);
  assertArchiveIdentity(entry.archiveJson, entry.projectId, entry.path);
}

function assertArchiveJsonSnapshot(entry: ProjectMutationJournal, snapshotPath: string): void {
  if (currentHash(snapshotPath) !== entry.archiveJsonHash) {
    throw new ProjectMutationError(`Archived project snapshot is missing or changed`);
  }
  if (readFileSync(snapshotPath, 'utf8') !== entry.archiveJson) {
    throw new ProjectMutationError(`Archived project snapshot bytes changed`);
  }
}

function assertArchiveWorkspaceSnapshot(entry: ProjectMutationJournal, archiveDir: string): void {
  if (entry.workspaceBytes === undefined || entry.workspaceHash === undefined) return;
  const workspacePath = join(archiveDir, 'project.yaml');
  if (currentHash(workspacePath) !== entry.workspaceHash) {
    throw new ProjectMutationError(`Archived project workspace manifest is missing or changed`);
  }
  if (readProjectTextFile(workspacePath, MAX_MUTATION_SOURCE_BYTES) !== entry.workspaceBytes)
    throw new ProjectMutationError(`Archived project workspace manifest is missing or changed`);
}

async function recoverArchive(
  deps: RecoveryDeps,
  entry: ProjectMutationJournal,
  state: ProjectRecoveryEntry['state'],
): Promise<'completed' | 'cancelled'> {
  if (!entry.archivePath) throw new ProjectMutationError('Archive journal path is missing');
  if (state === 'preparing') {
    removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
    return 'cancelled';
  }
  if (state !== 'published')
    throw new ProjectMutationError(`Project archive conflicts with current files`);
  const archiveDir = resolve(deps.projectsDir, safeRelative(deps.projectsDir, entry.archivePath));
  assertArchiveSnapshot(entry, archiveDir);
  if (deps.db && projectReferences(deps.db, entry.projectId).length > 0) {
    throw new ProjectMutationError(`Project gained references during archive; recovery retained`);
  }
  if (deps.db) deps.db.prepare('DELETE FROM projects WHERE id = ?').run(entry.projectId);
  removeProjectMutationJournal(deps.projectsDir, entry.mutationId);
  await loadAfterRecovery(deps);
  return 'completed';
}

export async function recoverProjectMutation(
  deps: RecoveryDeps,
  mutationId: string,
): Promise<RecoveryResult> {
  return withProjectMutation(deps.projectsDir, () => recoverJournal(deps, mutationId));
}

async function recoverJournal(deps: RecoveryDeps, mutationId: string): Promise<RecoveryResult> {
  const entry = readJournalFile(journalPath(deps.projectsDir, mutationId), deps.projectsDir);
  const report = readProjectRecoveryReport(deps.projectsDir);
  const state = report.entries.find((item) => item.mutationId === mutationId)?.state;
  if (!state || state === 'invalid') throw new ProjectMutationError(`Project mutation is invalid`);
  const status =
    entry.operation === 'create'
      ? await recoverCreate(deps, entry, state)
      : entry.operation === 'update'
        ? await recoverUpdate(deps, entry, state)
        : await recoverArchive(deps, entry, state);
  return { mutationId, status, operation: entry.operation, projectId: entry.projectId };
}
