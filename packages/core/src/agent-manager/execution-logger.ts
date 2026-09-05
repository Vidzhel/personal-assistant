import { createLogger } from '@raven/shared';
import type { AgentTask } from '@raven/shared';
import { runAfterProjectMutations } from '../project-manager/project-mutation.ts';
import type { ProjectRecordProject } from '../project-manager/project-records.ts';
import {
  agentTaskToRunRecord,
  readExecutionRunRecords,
  runLocation,
  writeExecutionRunRecord,
  type ExecutionRunRecord,
  type ExecutionRunRecordDeps,
  type ExecutionRunRecordWithBytes,
} from './execution-run-records.ts';

const log = createLogger('execution-logger');
const DEFAULT_QUERY_LIMIT = 50;
const PERCENT = 100;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const INTERRUPTED_REASON =
  'Agent run was not durably finalized before process restart; prior execution outcome is unknown';

export interface TaskRecord {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: string;
  priority: string;
  result?: string;
  durationMs?: number;
  errors?: string[];
  blocked: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  treeId?: string;
  executionTaskId?: string;
  namedAgentId?: string;
  interrupted?: boolean;
}

export interface TaskQueryOpts {
  skillName?: string;
  status?: string;
  sessionId?: string;
  projectId?: string;
  createdSinceMs?: number;
  completedSinceMs?: number;
  limit?: number | null;
  offset?: number;
}

export interface TaskStats {
  total1h: number;
  succeeded1h: number;
  failed1h: number;
  avgDurationMs: number | null;
  lastTaskAt: string | null;
}

export interface PerSkillStats {
  skillName: string;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface ExecutionLogger {
  logTaskStart: (task: AgentTask) => Promise<void>;
  logTaskComplete: (task: AgentTask) => Promise<void>;
  queryTasks: (opts: TaskQueryOpts) => TaskRecord[];
  getTaskById: (id: string) => TaskRecord | undefined;
  getTaskStats: (sinceMs: number) => TaskStats;
  getPerSkillStats: (sinceMs: number) => PerSkillStats[];
}

function toTaskRecord(record: ExecutionRunRecord): TaskRecord {
  return { ...record };
}

function epoch(iso: string | undefined): number | undefined {
  return iso === undefined ? undefined : Date.parse(iso);
}

function sortNewest(a: TaskRecord, b: TaskRecord): number {
  return (epoch(b.createdAt) ?? 0) - (epoch(a.createdAt) ?? 0) || a.id.localeCompare(b.id);
}

function sameArray(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function sameTerminalPayload(existing: ExecutionRunRecord, incoming: ExecutionRunRecord): boolean {
  return (
    existing.status === incoming.status &&
    existing.result === incoming.result &&
    existing.durationMs === incoming.durationMs &&
    existing.blocked === incoming.blocked &&
    sameArray(existing.errors, incoming.errors)
  );
}

function mergeCompletion(
  existing: ExecutionRunRecord,
  incoming: ExecutionRunRecord,
): ExecutionRunRecord {
  if (TERMINAL_STATUSES.has(existing.status)) {
    if (!sameTerminalPayload(existing, incoming)) {
      throw new Error(`Conflicting terminal update for agent run: ${existing.id}`);
    }
    return existing;
  }
  if (!TERMINAL_STATUSES.has(incoming.status)) {
    throw new Error(`Agent run completion must be terminal: ${incoming.id}`);
  }
  return {
    ...existing,
    status: incoming.status,
    ...(incoming.result !== undefined && { result: incoming.result }),
    ...(incoming.durationMs !== undefined && { durationMs: incoming.durationMs }),
    ...(incoming.errors !== undefined && { errors: incoming.errors }),
    blocked: incoming.blocked,
    ...(incoming.completedAt !== undefined && { completedAt: incoming.completedAt }),
  };
}

function assertSameIdentity(existing: ExecutionRunRecord, incoming: ExecutionRunRecord): void {
  const fields: Array<keyof ExecutionRunRecord> = [
    'projectId',
    'sessionId',
    'skillName',
    'actionName',
    'prompt',
    'priority',
    'createdAt',
    'startedAt',
    'treeId',
    'executionTaskId',
    'namedAgentId',
  ];
  for (const field of fields) {
    const same =
      field === 'createdAt'
        ? Date.parse(existing.createdAt) === Date.parse(incoming.createdAt)
        : field === 'startedAt'
          ? epoch(existing.startedAt) === epoch(incoming.startedAt)
          : existing[field] === incoming[field];
    if (!same) {
      throw new Error(`Agent run identity changed: ${existing.id}`);
    }
  }
}

function selectRecords(records: TaskRecord[], opts: TaskQueryOpts): TaskRecord[] {
  const filtered = records
    .filter((record) => opts.skillName === undefined || record.skillName === opts.skillName)
    .filter((record) => opts.status === undefined || record.status === opts.status)
    .filter((record) => opts.sessionId === undefined || record.sessionId === opts.sessionId)
    .filter((record) => opts.projectId === undefined || record.projectId === opts.projectId)
    .filter(
      (record) =>
        opts.createdSinceMs === undefined || (epoch(record.createdAt) ?? 0) >= opts.createdSinceMs,
    )
    .filter(
      (record) =>
        opts.completedSinceMs === undefined ||
        (epoch(record.completedAt) ?? Number.NEGATIVE_INFINITY) >= opts.completedSinceMs,
    )
    .sort(sortNewest);
  const offset = opts.offset ?? 0;
  const limit = opts.limit === undefined ? DEFAULT_QUERY_LIMIT : opts.limit;
  return limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
}

function aggregateStats(records: TaskRecord[], sinceMs: number): TaskStats {
  const cutoff = Date.now() - sinceMs;
  const recent = records.filter(
    (record) =>
      record.completedAt !== undefined &&
      (epoch(record.completedAt) ?? Number.NEGATIVE_INFINITY) >= cutoff,
  );
  const durations = recent.flatMap((record) =>
    record.durationMs === undefined ? [] : [record.durationMs],
  );
  const completed = recent.filter((record) => record.status === 'completed');
  const failed = recent.filter((record) => record.status === 'failed');
  const latest = recent.reduce<string | undefined>((latestAt, record) => {
    if (record.completedAt === undefined) return latestAt;
    if (latestAt === undefined || (epoch(record.completedAt) ?? 0) > (epoch(latestAt) ?? 0)) {
      return record.completedAt;
    }
    return latestAt;
  }, undefined);
  return {
    total1h: recent.length,
    succeeded1h: completed.length,
    failed1h: failed.length,
    avgDurationMs:
      durations.length === 0
        ? null
        : Math.round(durations.reduce((total, value) => total + value, 0) / durations.length),
    lastTaskAt: latest ?? null,
  };
}

function aggregatePerSkill(records: TaskRecord[], sinceMs: number): PerSkillStats[] {
  const cutoff = Date.now() - sinceMs;
  const groups = new Map<string, TaskRecord[]>();
  for (const record of records) {
    if (
      record.completedAt === undefined ||
      (epoch(record.completedAt) ?? Number.NEGATIVE_INFINITY) < cutoff
    )
      continue;
    const group = groups.get(record.skillName) ?? [];
    group.push(record);
    groups.set(record.skillName, group);
  }
  return [...groups]
    .map(([skillName, group]) => {
      const succeeded = group.filter((record) => record.status === 'completed').length;
      const failed = group.filter((record) => record.status === 'failed').length;
      const durations = group.flatMap((record) =>
        record.durationMs === undefined ? [] : [record.durationMs],
      );
      return {
        skillName,
        total: group.length,
        succeeded,
        failed,
        successRate: group.length > 0 ? Math.round((succeeded / group.length) * PERCENT) : 0,
        avgDurationMs:
          durations.length === 0
            ? null
            : Math.round(durations.reduce((total, value) => total + value, 0) / durations.length),
      };
    })
    .sort(
      (left, right) => right.total - left.total || left.skillName.localeCompare(right.skillName),
    );
}

function assertExpectedBytes(
  expectedBytes: string | undefined,
  current: ExecutionRunRecordWithBytes,
): void {
  if (expectedBytes !== undefined && current.bytes !== expectedBytes) {
    throw new Error(`Agent run changed on disk: ${current.record.id}`);
  }
}

function interruptRecord(record: ExecutionRunRecord): ExecutionRunRecord {
  if (TERMINAL_STATUSES.has(record.status)) return record;
  return {
    ...record,
    status: 'failed',
    interrupted: true,
    errors: [...(record.errors ?? []), INTERRUPTED_REASON],
    completedAt: new Date().toISOString(),
    blocked: false,
  };
}

function initializeRecords(deps: ExecutionRunRecordDeps, expectedBytes: Map<string, string>): void {
  for (const item of readExecutionRunRecords(deps)) {
    const recovered = interruptRecord(item.record);
    const bytes =
      recovered === item.record
        ? item.bytes
        : writeExecutionRunRecord(deps, item.location, recovered);
    expectedBytes.set(recovered.id, bytes);
  }
}

interface LoggerState {
  deps: ExecutionRunRecordDeps;
  expectedBytes: Map<string, string>;
}

function readLoggerRecords(state: LoggerState): ExecutionRunRecordWithBytes[] {
  const records = readExecutionRunRecords(state.deps);
  for (const item of records) {
    if (!state.expectedBytes.has(item.record.id))
      state.expectedBytes.set(item.record.id, item.bytes);
  }
  return records;
}

function readFreshRecords(state: LoggerState): ExecutionRunRecordWithBytes[] {
  return readExecutionRunRecords(state.deps);
}

async function logStart(state: LoggerState, task: AgentTask): Promise<void> {
  const snapshot = agentTaskToRunRecord(task);
  if (snapshot.status !== 'queued' && snapshot.status !== 'running') {
    throw new Error(`Agent run start must be queued or running: ${snapshot.id}`);
  }
  await runAfterProjectMutations(state.deps.projectsDir, () => {
    const existing = readFreshRecords(state).find((item) => item.record.id === snapshot.id);
    if (existing) throw new Error(`Agent run already exists: ${snapshot.id}`);
    const location = runLocation(state.deps, snapshot.projectId, snapshot.id);
    const bytes = writeExecutionRunRecord(state.deps, location, snapshot);
    state.expectedBytes.set(snapshot.id, bytes);
  });
  log.debug(`Logged agent run start: ${snapshot.id}`);
}

async function logComplete(state: LoggerState, task: AgentTask): Promise<void> {
  const snapshot = agentTaskToRunRecord(task);
  if (!TERMINAL_STATUSES.has(snapshot.status)) {
    throw new Error(`Agent run completion must be terminal: ${snapshot.id}`);
  }
  await runAfterProjectMutations(state.deps.projectsDir, () => {
    const existing = readFreshRecords(state).find((item) => item.record.id === snapshot.id);
    if (!existing) {
      if (state.expectedBytes.has(snapshot.id)) {
        throw new Error(`Agent run changed on disk: ${snapshot.id}`);
      }
      if (snapshot.status !== 'cancelled' || snapshot.startedAt !== undefined) {
        throw new Error(`Agent run completion has no start record: ${snapshot.id}`);
      }
      const location = runLocation(state.deps, snapshot.projectId, snapshot.id);
      const bytes = writeExecutionRunRecord(state.deps, location, snapshot);
      state.expectedBytes.set(snapshot.id, bytes);
      return;
    }
    assertExpectedBytes(state.expectedBytes.get(snapshot.id), existing);
    assertSameIdentity(existing.record, snapshot);
    const merged = mergeCompletion(existing.record, snapshot);
    if (merged === existing.record) {
      state.expectedBytes.set(snapshot.id, existing.bytes);
      return;
    }
    const bytes = writeExecutionRunRecord(state.deps, existing.location, merged);
    state.expectedBytes.set(snapshot.id, bytes);
  });
  log.debug(`Logged agent run completion: ${snapshot.id} (${snapshot.status})`);
}

export function createExecutionLogger(deps: {
  projectsDir: string;
  projects: () => ProjectRecordProject[];
}): ExecutionLogger {
  const state: LoggerState = { deps, expectedBytes: new Map<string, string>() };
  initializeRecords(state.deps, state.expectedBytes);

  return {
    logTaskStart: (task) => logStart(state, task),
    logTaskComplete: (task) => logComplete(state, task),

    queryTasks(opts: TaskQueryOpts): TaskRecord[] {
      return selectRecords(
        readLoggerRecords(state).map((item) => toTaskRecord(item.record)),
        opts,
      );
    },

    getTaskById(id: string): TaskRecord | undefined {
      const record = readLoggerRecords(state).find((item) => item.record.id === id)?.record;
      return record === undefined ? undefined : toTaskRecord(record);
    },

    getTaskStats(sinceMs: number): TaskStats {
      return aggregateStats(
        readLoggerRecords(state).map((item) => toTaskRecord(item.record)),
        sinceMs,
      );
    },

    getPerSkillStats(sinceMs: number): PerSkillStats[] {
      return aggregatePerSkill(
        readLoggerRecords(state).map((item) => toTaskRecord(item.record)),
        sinceMs,
      );
    },
  };
}
