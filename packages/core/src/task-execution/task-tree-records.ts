import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  TaskTreeRecordSchema,
  type ExecutionTask,
  type TaskTree,
  type TaskTreeNode,
} from '@raven/shared';
import {
  assertRecordDirectory,
  atomicWrite,
  listProjectRecordDirectories,
  recoverProjectRecordMoves,
  resolveProjectRecordLocation,
  type ProjectRecordDeps,
  type ProjectRecordLocation,
} from '../project-manager/project-records.ts';
import { assertProjectMutationAllowed } from '../project-manager/project-mutation.ts';

export const TREE_COLLECTION = 'tasks/trees';
export type TaskTreeRecordDeps = ProjectRecordDeps;

export interface TaskTreeRecord extends ProjectRecordLocation {
  tree: TaskTree;
  bytes: string;
}

function parseTree(path: string, bytes: string): TaskTree {
  try {
    return parseTaskTreeDocument(parse(bytes), path);
  } catch (error) {
    throw new Error(
      `Invalid execution tree record ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function parseTaskTreeDocument(document: unknown, path = '<candidate>'): TaskTree {
  try {
    return documentToTree(TaskTreeRecordSchema.parse(document));
  } catch (error) {
    throw new Error(
      `Invalid execution tree record ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function normalizeTaskTree(tree: TaskTree): TaskTree {
  return parseTaskTreeDocument(treeDocument(tree));
}

function documentToTree(document: ReturnType<typeof TaskTreeRecordSchema.parse>): TaskTree {
  assertInterruptionMarkers(document);
  const tasks = new Map<string, ExecutionTask>();
  for (const execution of document.tasks) addExecutionTask(tasks, document.id, execution);
  for (const execution of tasks.values()) validateReferences(tasks, execution);
  assertAcyclic(tasks);
  return {
    id: document.id,
    ...(document.projectId !== undefined && { projectId: document.projectId }),
    ...(document.scheduleId !== undefined && { scheduleId: document.scheduleId }),
    status: document.status,
    ...(document.plan !== undefined && { plan: document.plan }),
    tasks,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    ...(document.interrupted !== undefined && { interrupted: document.interrupted }),
  };
}

function assertInterruptionMarkers(document: ReturnType<typeof TaskTreeRecordSchema.parse>): void {
  if (document.interrupted && document.status !== 'pending_approval') {
    throw new Error('Interrupted execution trees must await pending approval');
  }
  for (const execution of document.tasks) {
    if (execution.interrupted && execution.status !== 'blocked') {
      throw new Error(`Interrupted execution task must be blocked: ${execution.id}`);
    }
  }
}

function addExecutionTask(
  tasks: Map<string, ExecutionTask>,
  treeId: string,
  execution: ExecutionTask,
): void {
  if (execution.id !== execution.node.id)
    throw new Error(`Execution/node ID mismatch: ${execution.id}`);
  if (execution.parentTaskId !== treeId)
    throw new Error(`Execution task has wrong tree owner: ${execution.id}`);
  if (tasks.has(execution.id)) throw new Error(`Duplicate execution task ID: ${execution.id}`);
  tasks.set(execution.id, execution);
}

function validateReferences(tasks: Map<string, ExecutionTask>, execution: ExecutionTask): void {
  for (const dependency of execution.node.blockedBy) {
    if (!tasks.has(dependency)) throw new Error(`Missing execution dependency ${dependency}`);
  }
  for (const target of conditionTargets(execution.node)) {
    if (!tasks.has(target)) throw new Error(`Missing condition target ${target}`);
  }
}

function conditionTargets(node: TaskTreeNode): string[] {
  const expressions = [node.runIf];
  if (node.type === 'condition') expressions.push(node.expression);
  const targets: string[] = [];
  for (const expression of expressions) {
    if (!expression) continue;
    for (const match of expression.matchAll(/\{\{\s*([\w-]+)\./g)) {
      const target = match[1];
      if (target) targets.push(target);
    }
  }
  return targets;
}

function assertAcyclic(tasks: Map<string, ExecutionTask>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Execution dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)?.node.blockedBy ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function readTreeEntry(
  location: { projectId: string; fsPath: string; directory: string; system: boolean },
  entry: Dirent,
  deps: TaskTreeRecordDeps,
): TaskTreeRecord | undefined {
  if (!entry.name.endsWith('.yaml')) return undefined;
  const id = entry.name.slice(0, -'.yaml'.length);
  const expected = resolveProjectRecordLocation({
    deps,
    collection: TREE_COLLECTION,
    projectId: location.projectId,
    recordId: id,
  });
  const bytes = readFileSync(join(location.directory, entry.name), 'utf8');
  const tree = parseTree(expected.filePath, bytes);
  if (tree.id !== id)
    throw new Error(`Tree filename does not match document id: ${expected.filePath}`);
  if (tree.projectId !== undefined && tree.projectId !== location.projectId) {
    if (!(location.system && tree.projectId === 'meta')) {
      throw new Error(`Tree project ownership mismatch: ${expected.filePath}`);
    }
  }
  if (tree.projectId === undefined && !location.system) {
    throw new Error(`Projectless tree must be stored in the system project: ${expected.filePath}`);
  }
  return { ...expected, tree, bytes };
}

function readDirectory(
  location: { projectId: string; fsPath: string; directory: string; system: boolean },
  deps: TaskTreeRecordDeps,
): TaskTreeRecord[] {
  assertRecordDirectory(deps.projectsDir, location.directory);
  if (!existsSync(location.directory)) return [];
  const records: TaskTreeRecord[] = [];
  for (const entry of readdirSync(location.directory, { withFileTypes: true })) {
    const path = join(location.directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Tree record path must not be a symlink: ${path}`);
    if (!entry.isFile()) continue;
    const record = readTreeEntry(location, entry, deps);
    if (record) records.push(record);
  }
  return records;
}

export function readTaskTreeRecords(deps: TaskTreeRecordDeps, recover = true): TaskTreeRecord[] {
  if (recover) recoverProjectRecordMoves(deps, TREE_COLLECTION);
  const records: TaskTreeRecord[] = [];
  for (const location of listProjectRecordDirectories(deps, TREE_COLLECTION)) {
    records.push(...readDirectory(location, deps));
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.tree.id)) throw new Error(`Duplicate execution tree ID: ${record.tree.id}`);
    seen.add(record.tree.id);
  }
  return records;
}

export function treeLocation(
  deps: TaskTreeRecordDeps,
  projectId: string | undefined,
  treeId: string,
): ProjectRecordLocation {
  return resolveProjectRecordLocation({
    deps,
    collection: TREE_COLLECTION,
    projectId,
    recordId: treeId,
  });
}

export function treeDocument(tree: TaskTree): Record<string, unknown> {
  return {
    id: tree.id,
    ...(tree.projectId !== undefined && { projectId: tree.projectId }),
    ...(tree.scheduleId !== undefined && { scheduleId: tree.scheduleId }),
    status: tree.status,
    ...(tree.plan !== undefined && { plan: tree.plan }),
    tasks: [...tree.tasks.values()],
    createdAt: tree.createdAt,
    updatedAt: tree.updatedAt,
    ...(tree.interrupted !== undefined && { interrupted: tree.interrupted }),
  };
}

export function writeTaskTreeRecord(
  deps: TaskTreeRecordDeps,
  location: ProjectRecordLocation,
  tree: TaskTree,
): string {
  assertProjectMutationAllowed(deps.projectsDir);
  const bytes = stringify(treeDocument(tree), { sortMapEntries: false });
  atomicWrite(deps.projectsDir, location.filePath, bytes);
  return bytes;
}
