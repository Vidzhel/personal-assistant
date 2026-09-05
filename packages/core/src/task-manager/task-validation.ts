import {
  TaskCreateInputSchema,
  TaskRecordSchema,
  TaskUpdateInputSchema,
  type RavenTask,
} from '@raven/shared';
import type { ProjectRecordLocation } from '../project-manager/project-records.ts';
import type { TaskRecord } from './task-records.ts';

export class TaskStoreError extends Error {
  readonly kind: 'bad-request' | 'not-found' | 'conflict' | 'storage';

  constructor(message: string, kind: 'bad-request' | 'not-found' | 'conflict' | 'storage') {
    super(message);
    this.name = 'TaskStoreError';
    this.kind = kind;
  }
}

export function parseCreateInput(input: unknown): ReturnType<typeof TaskCreateInputSchema.parse> {
  const result = TaskCreateInputSchema.safeParse(input);
  if (!result.success)
    throw new TaskStoreError(`Invalid task input: ${result.error.message}`, 'bad-request');
  return result.data;
}

export function parseUpdateInput(input: unknown): ReturnType<typeof TaskUpdateInputSchema.parse> {
  const result = TaskUpdateInputSchema.safeParse(input);
  if (!result.success)
    throw new TaskStoreError(`Invalid task update: ${result.error.message}`, 'bad-request');
  return result.data;
}

export function validateCompletionArtifacts(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  const result = TaskRecordSchema.shape.artifacts.safeParse(input);
  if (!result.success) {
    throw new TaskStoreError(
      `Invalid completion artifacts: ${result.error.message}`,
      'bad-request',
    );
  }
  return result.data;
}

function physicalOwner(record: TaskRecord): string {
  return record.system ? 'system' : record.fsPath;
}

function indexRecords(records: TaskRecord[]): Map<string, TaskRecord> {
  const byId = new Map<string, TaskRecord>();
  const external = new Set<string>();
  for (const record of records) {
    const parsed = TaskRecordSchema.safeParse(record.task);
    if (!parsed.success) {
      throw new TaskStoreError(
        `Invalid task ${record.task.id}: ${parsed.error.message}`,
        'bad-request',
      );
    }
    if (byId.has(record.task.id)) {
      throw new TaskStoreError(`Duplicate task record id: ${record.task.id}`, 'conflict');
    }
    byId.set(record.task.id, record);
    if (record.task.externalId !== undefined) {
      const key = `${record.task.source}\0${record.task.externalId}`;
      if (external.has(key)) {
        throw new TaskStoreError(`Duplicate source/externalId: ${key}`, 'conflict');
      }
      external.add(key);
    }
  }
  return byId;
}

function validateRelationships(records: TaskRecord[], byId: Map<string, TaskRecord>): void {
  for (const record of records) {
    const parentId = record.task.parentTaskId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) throw new TaskStoreError(`Unknown parent task: ${parentId}`, 'bad-request');
    if (physicalOwner(parent) !== physicalOwner(record)) {
      throw new TaskStoreError(
        `Parent task must be in the same project: ${record.task.id}`,
        'conflict',
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TaskStoreError(`Task parent cycle includes: ${id}`, 'conflict');
    visiting.add(id);
    const parent = byId.get(id)?.task.parentTaskId;
    if (parent) visit(parent);
    visiting.delete(id);
    visited.add(id);
  }
  for (const record of records) visit(record.task.id);
}

export function validateTaskRecords(records: TaskRecord[]): void {
  validateRelationships(records, indexRecords(records));
}

export function taskOwner(record: TaskRecord): string {
  return physicalOwner(record);
}

export function taskRecord(task: RavenTask, location: ProjectRecordLocation): TaskRecord {
  return { ...location, task, bytes: '' };
}
