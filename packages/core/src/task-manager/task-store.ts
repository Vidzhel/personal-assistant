import {
  createLogger,
  generateId,
  type EventBusInterface,
  type RavenTask,
  type TaskCreateInput,
  type TaskStatus,
  type TaskUpdateInput,
} from '@raven/shared';
import {
  assertSafeRecordId,
  type ProjectRecordLocation,
} from '../project-manager/project-records.ts';
import {
  moveTaskRecord,
  readTaskRecords,
  taskLocation,
  writeTaskRecord,
  type TaskRecord,
  type TaskRecordDeps,
} from './task-records.ts';
import {
  parseCreateInput,
  parseUpdateInput,
  TaskStoreError,
  taskOwner,
  taskRecord,
  validateCompletionArtifacts,
  validateTaskRecords,
} from './task-validation.ts';

const log = createLogger('task-store');
const DEFAULT_QUERY_LIMIT = 50;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const ARCHIVE_THRESHOLD_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export interface TaskQueryFilters {
  status?: TaskStatus;
  projectId?: string;
  assignedAgentId?: string;
  parentTaskId?: string;
  source?: string;
  scheduleId?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface TaskStore {
  createTask: (input: TaskCreateInput) => RavenTask;
  updateTask: (id: string, input: TaskUpdateInput) => RavenTask;
  completeTask: (id: string, artifacts?: string[]) => RavenTask;
  archiveCompletedTasks: () => number;
  getTask: (id: string) => RavenTask | undefined;
  getSubtasks: (parentId: string) => RavenTask[];
  queryTasks: (filters: TaskQueryFilters) => RavenTask[];
  getTaskCountsByStatus: (projectId?: string) => Record<TaskStatus, number>;
}

export interface TaskStoreDeps extends TaskRecordDeps {
  eventBus: EventBusInterface;
}

type TaskEvent = 'task:created' | 'task:updated' | 'task:completed' | 'task:archived';

function emitTaskEvent(options: {
  eventBus: EventBusInterface;
  type: TaskEvent;
  task: RavenTask;
  extra?: Record<string, unknown>;
}): void {
  const { eventBus, type, task, extra } = options;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'task-manager',
    projectId: task.projectId,
    type,
    payload: { taskId: task.id, title: task.title, ...extra },
  });
}

function loadRecords(deps: TaskStoreDeps): TaskRecord[] {
  const records = readTaskRecords(deps);
  validateTaskRecords(records);
  return records;
}

function findRecord(records: TaskRecord[], id: string): TaskRecord | undefined {
  return records.find((record) => record.task.id === id);
}

function notFound(id: string): never {
  throw new TaskStoreError(`Task not found: ${id}`, 'not-found');
}

function assertTaskId(id: string): void {
  try {
    assertSafeRecordId(id);
  } catch (error) {
    throw new TaskStoreError(error instanceof Error ? error.message : String(error), 'bad-request');
  }
}

function applyPatch(task: RavenTask, input: TaskUpdateInput): RavenTask {
  let next = { ...task };
  for (const key of [
    'title',
    'description',
    'prompt',
    'assignedAgentId',
    'projectId',
    'pipelineId',
    'scheduleId',
    'parentTaskId',
  ] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) {
      next = Object.fromEntries(
        Object.entries(next).filter(([name]) => name !== key),
      ) as unknown as RavenTask;
    } else next[key] = value;
  }
  if (input.artifacts !== undefined) next.artifacts = [...input.artifacts];
  if (input.status !== undefined) next.status = input.status;
  return next;
}

function applyCompletion(task: RavenTask, artifacts: string[] | undefined, now: string): RavenTask {
  const merged = [...task.artifacts];
  for (const artifact of artifacts ?? []) {
    if (!merged.includes(artifact)) merged.push(artifact);
  }
  return {
    ...task,
    status: 'completed',
    artifacts: merged,
    completedAt: task.status === 'completed' && task.completedAt ? task.completedAt : now,
    updatedAt:
      task.status === 'completed' && merged.length === task.artifacts.length ? task.updatedAt : now,
  };
}

function validateNext(options: {
  records: TaskRecord[];
  current: TaskRecord;
  next: RavenTask;
  location: ProjectRecordLocation;
}): void {
  const { records, current, next, location } = options;
  const nextRecords = records.map((record) =>
    record.task.id === current.task.id ? taskRecord(next, location) : record,
  );
  validateTaskRecords(nextRecords);
}

function assertParentMoveAllowed(
  records: TaskRecord[],
  current: TaskRecord,
  destination: string,
): void {
  for (const child of records) {
    if (child.task.parentTaskId === current.task.id && taskOwner(child) !== destination) {
      throw new TaskStoreError(
        `Cannot move parent task while child remains in another project: ${child.task.id}`,
        'conflict',
      );
    }
  }
}

function queryMatches(task: RavenTask, filters: TaskQueryFilters): boolean {
  const term = filters.search?.toLowerCase();
  const searchable = term === undefined || searchMatches(task, term);
  return [
    filters.includeArchived || task.status !== 'archived',
    filters.status === undefined || task.status === filters.status,
    filters.projectId === undefined || task.projectId === filters.projectId,
    filters.assignedAgentId === undefined || task.assignedAgentId === filters.assignedAgentId,
    filters.parentTaskId === undefined || task.parentTaskId === filters.parentTaskId,
    filters.source === undefined || task.source === filters.source,
    filters.scheduleId === undefined || task.scheduleId === filters.scheduleId,
    searchable,
  ].every(Boolean);
}

function searchMatches(task: RavenTask, term: string): boolean {
  return (
    task.title.toLowerCase().includes(term) ||
    (task.description?.toLowerCase().includes(term) ?? false)
  );
}

function byCreatedDesc(a: TaskRecord, b: TaskRecord): number {
  return (
    Date.parse(b.task.createdAt) - Date.parse(a.task.createdAt) ||
    a.task.id.localeCompare(b.task.id)
  );
}

function byCreatedAsc(a: TaskRecord, b: TaskRecord): number {
  return (
    Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt) ||
    a.task.id.localeCompare(b.task.id)
  );
}

function locate(
  deps: TaskStoreDeps,
  projectId: string | undefined,
  id: string,
): ProjectRecordLocation {
  try {
    return taskLocation(deps, projectId, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unknown project') || message.startsWith('Invalid record id')) {
      throw new TaskStoreError(message, 'bad-request');
    }
    throw error;
  }
}

function getRecord(deps: TaskStoreDeps, id: string): TaskRecord {
  assertTaskId(id);
  return findRecord(loadRecords(deps), id) ?? notFound(id);
}

function createTask(deps: TaskStoreDeps, input: TaskCreateInput): RavenTask {
  const parsed = parseCreateInput(input);
  const records = loadRecords(deps);
  const now = new Date().toISOString();
  const task: RavenTask = {
    id: generateId(),
    title: parsed.title,
    status: parsed.status,
    source: parsed.source,
    artifacts: [...parsed.artifacts],
    createdAt: now,
    updatedAt: now,
    ...(parsed.status === 'completed' && { completedAt: now }),
    ...(parsed.description !== undefined && { description: parsed.description }),
    ...(parsed.prompt !== undefined && { prompt: parsed.prompt }),
    ...(parsed.assignedAgentId !== undefined && { assignedAgentId: parsed.assignedAgentId }),
    ...(parsed.projectId !== undefined && { projectId: parsed.projectId }),
    ...(parsed.pipelineId !== undefined && { pipelineId: parsed.pipelineId }),
    ...(parsed.scheduleId !== undefined && { scheduleId: parsed.scheduleId }),
    ...(parsed.parentTaskId !== undefined && { parentTaskId: parsed.parentTaskId }),
    ...(parsed.externalId !== undefined && { externalId: parsed.externalId }),
  };
  const location = locate(deps, task.projectId, task.id);
  const candidate = { ...location, task, bytes: '' };
  validateTaskRecords([...records, candidate]);
  writeTaskRecord(deps, location, task);
  log.info(`Task created: ${task.id} "${task.title}"`);
  emitTaskEvent({
    eventBus: deps.eventBus,
    type: 'task:created',
    task,
    extra: {
      source: task.source,
      assignedAgentId: task.assignedAgentId,
      parentTaskId: task.parentTaskId,
    },
  });
  return task;
}

function updateTask(deps: TaskStoreDeps, id: string, input: TaskUpdateInput): RavenTask {
  assertTaskId(id);
  const parsed = parseUpdateInput(input);
  const records = loadRecords(deps);
  const current = findRecord(records, id) ?? notFound(id);
  if (Object.keys(parsed).length === 0) return current.task;
  const next = applyPatch(current.task, parsed);
  const now = new Date().toISOString();
  next.updatedAt = now;
  if (next.status === 'completed' && current.task.status !== 'completed') next.completedAt = now;
  if (next.status !== 'completed' && next.status !== 'archived') delete next.completedAt;
  const location = locate(deps, next.projectId, id);
  const destination = location.system ? 'system' : location.fsPath;
  if (location.filePath !== current.filePath) {
    assertParentMoveAllowed(records, current, destination);
    validateNext({ records, current, next, location });
    moveTaskRecord({ deps, source: current, destination: location, task: next });
  } else {
    validateNext({ records, current, next, location });
    writeTaskRecord(deps, location, next);
  }
  const changes = Object.keys(parsed);
  log.info(`Task updated: ${id} [${changes.join(', ')}]`);
  emitTaskEvent({ eventBus: deps.eventBus, type: 'task:updated', task: next, extra: { changes } });
  return next;
}

function completeTask(deps: TaskStoreDeps, id: string, artifacts?: string[]): RavenTask {
  const additional = validateCompletionArtifacts(artifacts);
  const current = getRecord(deps, id);
  const records = loadRecords(deps);
  const next = applyCompletion(current.task, additional, new Date().toISOString());
  if (
    current.task.status === 'completed' &&
    next.completedAt === current.task.completedAt &&
    next.artifacts.length === current.task.artifacts.length
  ) {
    return current.task;
  }
  validateNext({ records, current, next, location: current });
  writeTaskRecord(deps, current, next);
  log.info(`Task completed: ${id} "${next.title}"`);
  emitTaskEvent({
    eventBus: deps.eventBus,
    type: 'task:completed',
    task: next,
    extra: {
      artifacts: next.artifacts,
      assignedAgentId: next.assignedAgentId,
      projectId: next.projectId,
    },
  });
  return next;
}

function archiveCompletedTasks(deps: TaskStoreDeps): number {
  const cutoff = new Date(Date.now() - ARCHIVE_THRESHOLD_MS).toISOString();
  const records = loadRecords(deps);
  const toArchive = records.filter(
    (record) =>
      record.task.status === 'completed' &&
      record.task.completedAt !== undefined &&
      Date.parse(record.task.completedAt) <= Date.parse(cutoff),
  );
  const now = new Date().toISOString();
  for (const record of toArchive) {
    const next = { ...record.task, status: 'archived' as const, updatedAt: now };
    validateNext({ records, current: record, next, location: record });
    writeTaskRecord(deps, record, next);
    emitTaskEvent({
      eventBus: deps.eventBus,
      type: 'task:archived',
      task: {
        ...record.task,
        status: 'archived',
        updatedAt: now,
      },
    });
  }
  if (toArchive.length > 0) log.info(`Archived ${toArchive.length} completed tasks`);
  return toArchive.length;
}

function getTask(deps: TaskStoreDeps, id: string): RavenTask | undefined {
  assertTaskId(id);
  return findRecord(loadRecords(deps), id)?.task;
}

function getSubtasks(deps: TaskStoreDeps, parentId: string): RavenTask[] {
  assertTaskId(parentId);
  return loadRecords(deps)
    .filter((record) => record.task.parentTaskId === parentId)
    .sort(byCreatedAsc)
    .map((record) => record.task);
}

function queryTasks(deps: TaskStoreDeps, filters: TaskQueryFilters): RavenTask[] {
  const limit = filters.limit ?? DEFAULT_QUERY_LIMIT;
  const offset = filters.offset ?? 0;
  return loadRecords(deps)
    .filter((record) => queryMatches(record.task, filters))
    .sort(byCreatedDesc)
    .slice(offset, offset + limit)
    .map((record) => record.task);
}

function getTaskCountsByStatus(
  deps: TaskStoreDeps,
  projectId?: string,
): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending_approval: 0,
    todo: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    archived: 0,
  };
  for (const record of loadRecords(deps)) {
    if (projectId !== undefined && record.task.projectId !== projectId) continue;
    counts[record.task.status]++;
  }
  return counts;
}

export function createTaskStore(deps: TaskStoreDeps): TaskStore {
  return {
    createTask: (input) => createTask(deps, input),
    updateTask: (id, input) => updateTask(deps, id, input),
    completeTask: (id, artifacts) => completeTask(deps, id, artifacts),
    archiveCompletedTasks: () => archiveCompletedTasks(deps),
    getTask: (id) => getTask(deps, id),
    getSubtasks: (parentId) => getSubtasks(deps, parentId),
    queryTasks: (filters) => queryTasks(deps, filters),
    getTaskCountsByStatus: (projectId) => getTaskCountsByStatus(deps, projectId),
  };
}
