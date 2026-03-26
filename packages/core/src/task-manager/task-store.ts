import {
  createLogger,
  generateId,
  type DatabaseInterface,
  type EventBusInterface,
  type RavenTask,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TaskStatus,
} from '@raven/shared';

const log = createLogger('task-store');

const DEFAULT_QUERY_LIMIT = 50;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const ARCHIVE_THRESHOLD_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface TaskQueryFilters {
  status?: TaskStatus;
  projectId?: string;
  assignedAgentId?: string;
  parentTaskId?: string;
  source?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  prompt: string | null;
  status: string;
  assigned_agent_id: string | null;
  project_id: string | null;
  pipeline_id: string | null;
  schedule_id: string | null;
  parent_task_id: string | null;
  source: string;
  external_id: string | null;
  artifacts: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// eslint-disable-next-line complexity -- one conditional spread per optional column field
function rowToTask(row: TaskRow): RavenTask {
  return {
    id: row.id,
    title: row.title,
    ...(row.description !== null && { description: row.description }),
    ...(row.prompt !== null && { prompt: row.prompt }),
    status: row.status as TaskStatus,
    ...(row.assigned_agent_id !== null && { assignedAgentId: row.assigned_agent_id }),
    ...(row.project_id !== null && { projectId: row.project_id }),
    ...(row.pipeline_id !== null && { pipelineId: row.pipeline_id }),
    ...(row.schedule_id !== null && { scheduleId: row.schedule_id }),
    ...(row.parent_task_id !== null && { parentTaskId: row.parent_task_id }),
    source: row.source as RavenTask['source'],
    ...(row.external_id !== null && { externalId: row.external_id }),
    artifacts: row.artifacts ? (JSON.parse(row.artifacts) as string[]) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null && { completedAt: row.completed_at }),
  };
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

// eslint-disable-next-line max-lines-per-function -- factory initializing all store methods
export function createTaskStore(deps: {
  db: DatabaseInterface;
  eventBus: EventBusInterface;
}): TaskStore {
  const { db, eventBus } = deps;

  function emitTaskEvent(
    type: 'task:created' | 'task:updated' | 'task:completed' | 'task:archived',
    task: RavenTask,
    extra?: Record<string, unknown>,
  ): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'task-manager',
      projectId: task.projectId,
      type,
      payload: { taskId: task.id, title: task.title, ...extra },
    });
  }

  return {
    // eslint-disable-next-line complexity -- many optional fields mapped from input with null coalescing
    createTask(input: TaskCreateInput): RavenTask {
      const id = generateId();
      const now = new Date().toISOString();
      const artifacts = JSON.stringify(input.artifacts ?? []);

      db.run(
        `INSERT INTO tasks (id, title, description, prompt, status, assigned_agent_id, project_id,
         pipeline_id, schedule_id, parent_task_id, source, external_id, artifacts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.title,
        input.description ?? null,
        input.prompt ?? null,
        input.status ?? 'todo',
        input.assignedAgentId ?? null,
        input.projectId ?? null,
        input.pipelineId ?? null,
        input.scheduleId ?? null,
        input.parentTaskId ?? null,
        input.source ?? 'manual',
        input.externalId ?? null,
        artifacts,
        now,
        now,
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed to exist after successful INSERT/UPDATE
      const task = this.getTask(id)!;
      log.info(`Task created: ${task.id} "${task.title}"`);
      emitTaskEvent('task:created', task, {
        source: task.source,
        assignedAgentId: task.assignedAgentId,
        parentTaskId: task.parentTaskId,
      });
      return task;
    },

    updateTask(id: string, input: TaskUpdateInput): RavenTask {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`Task not found: ${id}`);

      const sets: string[] = [];
      const params: unknown[] = [];
      const changes: string[] = [];

      const fields: Array<[keyof TaskUpdateInput, string]> = [
        ['title', 'title'],
        ['description', 'description'],
        ['prompt', 'prompt'],
        ['status', 'status'],
        ['assignedAgentId', 'assigned_agent_id'],
        ['projectId', 'project_id'],
        ['pipelineId', 'pipeline_id'],
        ['scheduleId', 'schedule_id'],
        ['parentTaskId', 'parent_task_id'],
      ];

      for (const [key, col] of fields) {
        if (key in input) {
          sets.push(`${col} = ?`);
          params.push(input[key] ?? null);
          changes.push(key);
        }
      }

      if (input.artifacts !== undefined) {
        sets.push('artifacts = ?');
        params.push(JSON.stringify(input.artifacts));
        changes.push('artifacts');
      }

      if (sets.length === 0) return existing;

      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed to exist after successful INSERT/UPDATE
      const task = this.getTask(id)!;
      log.info(`Task updated: ${id} [${changes.join(', ')}]`);
      emitTaskEvent('task:updated', task, { changes });
      return task;
    },

    completeTask(id: string, artifacts?: string[]): RavenTask {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`Task not found: ${id}`);

      const now = new Date().toISOString();
      const mergedArtifacts = [...existing.artifacts, ...(artifacts ?? [])];

      db.run(
        `UPDATE tasks SET status = 'completed', completed_at = ?, artifacts = ?, updated_at = ? WHERE id = ?`,
        now,
        JSON.stringify(mergedArtifacts),
        now,
        id,
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed to exist after successful INSERT/UPDATE
      const task = this.getTask(id)!;
      log.info(`Task completed: ${id} "${task.title}"`);
      emitTaskEvent('task:completed', task, {
        artifacts: task.artifacts,
        assignedAgentId: task.assignedAgentId,
        projectId: task.projectId,
      });
      return task;
    },

    archiveCompletedTasks(): number {
      const cutoff = new Date(Date.now() - ARCHIVE_THRESHOLD_MS).toISOString();
      const now = new Date().toISOString();

      // Get tasks to archive for event emission
      const toArchive = db.all<TaskRow>(
        `SELECT * FROM tasks WHERE status = 'completed' AND completed_at <= ?`,
        cutoff,
      );

      if (toArchive.length === 0) return 0;

      db.run(
        `UPDATE tasks SET status = 'archived', updated_at = ? WHERE status = 'completed' AND completed_at <= ?`,
        now,
        cutoff,
      );

      for (const row of toArchive) {
        const task = rowToTask(row);
        emitTaskEvent('task:archived', task);
      }

      log.info(`Archived ${toArchive.length} completed tasks`);
      return toArchive.length;
    },

    getTask(id: string): RavenTask | undefined {
      const row = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
      return row ? rowToTask(row) : undefined;
    },

    getSubtasks(parentId: string): RavenTask[] {
      const rows = db.all<TaskRow>(
        'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
        parentId,
      );
      return rows.map(rowToTask);
    },

    // eslint-disable-next-line complexity -- dynamic query builder with one branch per filter field
    queryTasks(filters: TaskQueryFilters): RavenTask[] {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (!filters.includeArchived) {
        conditions.push("status != 'archived'");
      }

      if (filters.status) {
        conditions.push('status = ?');
        params.push(filters.status);
      }

      if (filters.projectId) {
        conditions.push('project_id = ?');
        params.push(filters.projectId);
      }

      if (filters.assignedAgentId) {
        conditions.push('assigned_agent_id = ?');
        params.push(filters.assignedAgentId);
      }

      if (filters.parentTaskId) {
        conditions.push('parent_task_id = ?');
        params.push(filters.parentTaskId);
      }

      if (filters.source) {
        conditions.push('source = ?');
        params.push(filters.source);
      }

      if (filters.search) {
        conditions.push('(title LIKE ? OR description LIKE ?)');
        const term = `%${filters.search}%`;
        params.push(term, term);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = filters.limit ?? DEFAULT_QUERY_LIMIT;
      const offset = filters.offset ?? 0;

      const rows = db.all<TaskRow>(
        `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );

      return rows.map(rowToTask);
    },

    getTaskCountsByStatus(projectId?: string): Record<TaskStatus, number> {
      const condition = projectId ? 'WHERE project_id = ?' : '';
      const params = projectId ? [projectId] : [];

      const rows = db.all<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM tasks ${condition} GROUP BY status`,
        ...params,
      );

      const counts: Record<TaskStatus, number> = {
        todo: 0,
        in_progress: 0,
        completed: 0,
        archived: 0,
      };

      for (const row of rows) {
        counts[row.status as TaskStatus] = row.count;
      }

      return counts;
    },
  };
}
