import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { META_PROJECT_ID, type AgentTask } from '@raven/shared';
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

export const RUN_COLLECTION = 'tasks/runs';
export type ExecutionRunRecordDeps = ProjectRecordDeps;

const AgentTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
]);

export const ExecutionRunRecordSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    skillName: z.string().min(1),
    actionName: z.string().min(1).optional(),
    prompt: z.string().min(1),
    status: AgentTaskStatusSchema,
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    result: z.string().optional(),
    durationMs: z.number().int().min(0).optional(),
    errors: z.array(z.string()).optional(),
    blocked: z.boolean(),
    createdAt: z.string().pipe(z.iso.datetime({ offset: true })),
    startedAt: z
      .string()
      .pipe(z.iso.datetime({ offset: true }))
      .optional(),
    completedAt: z
      .string()
      .pipe(z.iso.datetime({ offset: true }))
      .optional(),
    treeId: z.string().min(1).optional(),
    executionTaskId: z.string().min(1).optional(),
    namedAgentId: z.string().min(1).optional(),
    interrupted: z.boolean().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const terminal = ['completed', 'failed', 'blocked', 'cancelled'].includes(record.status);
    if (record.status === 'running' && record.startedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'Running records need startedAt',
      });
    }
    if (terminal && record.completedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Terminal records need completedAt',
      });
    }
    if (!terminal && record.completedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Nonterminal records cannot have completedAt',
      });
    }
    if (record.blocked !== (record.status === 'blocked')) {
      context.addIssue({ code: 'custom', path: ['blocked'], message: 'blocked must match status' });
    }
    if (record.interrupted === true && record.status !== 'failed') {
      context.addIssue({
        code: 'custom',
        path: ['interrupted'],
        message: 'Only failed records can be interrupted',
      });
    }
  });

export type ExecutionRunRecord = z.infer<typeof ExecutionRunRecordSchema>;

export interface ExecutionRunLocation extends ProjectRecordLocation {
  recordId: string;
}

function epochToIso(epoch: number | undefined): string | undefined {
  return epoch === undefined ? undefined : new Date(epoch).toISOString();
}

function optionalField(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

export function agentTaskToRunRecord(task: AgentTask): ExecutionRunRecord {
  const startedAt = epochToIso(task.startedAt);
  const completedAt = epochToIso(task.completedAt);
  const record = {
    id: task.id,
    skillName: task.skillName,
    prompt: task.prompt,
    status: task.status,
    priority: task.priority,
    blocked: task.status === 'blocked',
    createdAt: new Date(task.createdAt).toISOString(),
  };
  Object.assign(
    record,
    optionalField('sessionId', task.sessionId),
    optionalField('projectId', task.projectId),
    optionalField('actionName', task.actionName),
    optionalField('result', task.result),
    optionalField('durationMs', task.durationMs),
    optionalField('errors', task.errors),
    optionalField('startedAt', startedAt),
    optionalField('completedAt', completedAt),
    optionalField('treeId', task.treeId),
    optionalField('executionTaskId', task.executionTaskId),
    optionalField('namedAgentId', task.namedAgentId),
  );
  return ExecutionRunRecordSchema.parse(record);
}

export function runLocation(
  deps: ExecutionRunRecordDeps,
  projectId: string | undefined,
  recordId: string,
): ExecutionRunLocation {
  return {
    ...resolveProjectRecordLocation({
      deps,
      collection: RUN_COLLECTION,
      projectId,
      recordId,
    }),
    recordId,
  };
}

function parseRun(path: string, bytes: string): ExecutionRunRecord {
  try {
    return ExecutionRunRecordSchema.parse(parse(bytes));
  } catch (error) {
    throw new Error(
      `Invalid agent run record ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertRecordOwnership(
  location: { projectId: string; system: boolean },
  record: ExecutionRunRecord,
  path: string,
): void {
  if (record.projectId === undefined && !location.system) {
    throw new Error(`Projectless agent run must be stored in the system project: ${path}`);
  }
  if (record.projectId !== undefined && record.projectId !== location.projectId) {
    if (!(location.system && record.projectId === META_PROJECT_ID)) {
      throw new Error(`Agent run project ownership mismatch: ${path}`);
    }
  }
}

function readRunEntry(
  location: { projectId: string; directory: string; system: boolean },
  entry: Dirent,
  deps: ExecutionRunRecordDeps,
): ExecutionRunRecordWithBytes | undefined {
  if (!entry.name.endsWith('.yaml')) return undefined;
  const id = entry.name.slice(0, -'.yaml'.length);
  const expected = runLocation(deps, location.projectId, id);
  const path = join(location.directory, entry.name);
  const bytes = readFileSync(path, 'utf8');
  const record = parseRun(expected.filePath, bytes);
  if (record.id !== id) throw new Error(`Agent run filename does not match document id: ${path}`);
  assertRecordOwnership(location, record, path);
  return { location: expected, record, bytes };
}

export interface ExecutionRunRecordWithBytes {
  location: ExecutionRunLocation;
  record: ExecutionRunRecord;
  bytes: string;
}

function readRunDirectory(
  location: { projectId: string; directory: string; system: boolean },
  deps: ExecutionRunRecordDeps,
): ExecutionRunRecordWithBytes[] {
  assertRecordDirectory(deps.projectsDir, location.directory);
  let entries: Dirent[];
  try {
    entries = readdirSync(location.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: ExecutionRunRecordWithBytes[] = [];
  for (const entry of entries) {
    const path = join(location.directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Agent run path must not be a symlink: ${path}`);
    if (!entry.isFile()) continue;
    const record = readRunEntry(location, entry, deps);
    if (record) records.push(record);
  }
  return records;
}

export function readExecutionRunRecords(
  deps: ExecutionRunRecordDeps,
): ExecutionRunRecordWithBytes[] {
  recoverProjectRecordMoves(deps, RUN_COLLECTION);
  const records: ExecutionRunRecordWithBytes[] = [];
  for (const location of listProjectRecordDirectories(deps, RUN_COLLECTION)) {
    records.push(...readRunDirectory(location, deps));
  }
  const seen = new Set<string>();
  for (const item of records) {
    if (seen.has(item.record.id))
      throw new Error(`Duplicate agent run record id: ${item.record.id}`);
    seen.add(item.record.id);
  }
  return records;
}

export function writeExecutionRunRecord(
  deps: ExecutionRunRecordDeps,
  location: ExecutionRunLocation,
  record: ExecutionRunRecord,
): string {
  const validated = ExecutionRunRecordSchema.parse(record);
  assertProjectMutationAllowed(deps.projectsDir);
  if (location.recordId !== validated.id) {
    throw new Error(`Agent run location does not match document id: ${validated.id}`);
  }
  const canonical = runLocation(deps, validated.projectId, validated.id);
  if (
    location.projectId !== canonical.projectId ||
    location.fsPath !== canonical.fsPath ||
    location.directory !== canonical.directory ||
    location.filePath !== canonical.filePath ||
    location.system !== canonical.system
  ) {
    throw new Error(`Agent run location does not match project ownership: ${validated.id}`);
  }
  assertRecordOwnership(canonical, validated, canonical.filePath);
  const bytes = stringify(validated, { sortMapEntries: false });
  atomicWrite(deps.projectsDir, location.filePath, bytes);
  return bytes;
}
