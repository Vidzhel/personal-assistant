import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { TaskRecordSchema, type RavenTask } from '@raven/shared';
import {
  atomicWrite,
  assertRecordDirectory,
  listProjectRecordDirectories,
  moveProjectRecord,
  recoverProjectRecordMoves,
  resolveProjectRecordLocation,
  type ProjectRecordDeps,
  type ProjectRecordLocation,
} from '../project-manager/project-records.ts';
import { assertProjectMutationAllowed } from '../project-manager/project-mutation.ts';

const COLLECTION = 'tasks/board';

export interface TaskRecord extends ProjectRecordLocation {
  task: RavenTask;
  bytes: string;
}

export type TaskRecordDeps = ProjectRecordDeps;

function parseTask(path: string, bytes: string): RavenTask {
  try {
    return TaskRecordSchema.parse(parse(bytes));
  } catch (error) {
    throw new Error(
      `Invalid task record ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readTaskEntry(
  location: { projectId: string; fsPath: string; directory: string; system: boolean },
  entry: Dirent,
  deps: TaskRecordDeps,
): TaskRecord | undefined {
  if (!entry.name.endsWith('.yaml')) return undefined;
  const path = join(location.directory, entry.name);
  const id = entry.name.slice(0, -'.yaml'.length);
  const expected = resolveProjectRecordLocation({
    deps,
    collection: COLLECTION,
    projectId: location.projectId,
    recordId: id,
  });
  const bytes = readFileSync(path, 'utf8');
  const task = parseTask(path, bytes);
  if (task.id !== id) throw new Error(`Task record filename does not match document id: ${path}`);
  if (task.projectId !== undefined && task.projectId !== location.projectId) {
    if (!(location.system && task.projectId === 'meta')) {
      throw new Error(`Task record project ownership mismatch: ${path}`);
    }
  }
  if (task.projectId === undefined && !location.system) {
    throw new Error(`Projectless task must be stored in the system project: ${path}`);
  }
  return { ...expected, task, bytes };
}

function readDirectory(
  location: {
    projectId: string;
    fsPath: string;
    directory: string;
    system: boolean;
  },
  deps: TaskRecordDeps,
): TaskRecord[] {
  assertRecordDirectory(deps.projectsDir, location.directory);
  if (!existsSync(location.directory)) return [];
  const records: TaskRecord[] = [];
  for (const entry of readdirSync(location.directory, { withFileTypes: true })) {
    const path = join(location.directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Task record path must not be a symlink: ${path}`);
    if (!entry.isFile()) continue;
    const record = readTaskEntry(location, entry, deps);
    if (record) records.push(record);
  }
  return records;
}

export function readTaskRecords(deps: TaskRecordDeps): TaskRecord[] {
  recoverProjectRecordMoves(deps, COLLECTION);
  const records: TaskRecord[] = [];
  for (const location of listProjectRecordDirectories(deps, COLLECTION)) {
    records.push(...readDirectory(location, deps));
  }
  return records;
}

export function taskLocation(
  deps: TaskRecordDeps,
  projectId: string | undefined,
  taskId: string,
): ProjectRecordLocation {
  return resolveProjectRecordLocation({
    deps,
    collection: COLLECTION,
    projectId,
    recordId: taskId,
  });
}

export function writeTaskRecord(
  deps: TaskRecordDeps,
  location: ProjectRecordLocation,
  task: RavenTask,
): string {
  assertProjectMutationAllowed(deps.projectsDir);
  const bytes = stringify(task, { sortMapEntries: false });
  atomicWrite(deps.projectsDir, location.filePath, bytes);
  return bytes;
}

export function moveTaskRecord(options: {
  deps: TaskRecordDeps;
  source: ProjectRecordLocation;
  destination: ProjectRecordLocation;
  task: RavenTask;
}): string {
  const { deps, source, destination, task } = options;
  const bytes = stringify(task, { sortMapEntries: false });
  moveProjectRecord({
    deps,
    sourcePath: source.filePath,
    destinationPath: destination.filePath,
    destinationBytes: bytes,
    collection: COLLECTION,
  });
  return bytes;
}
