import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createLogger,
  generateId,
  type DatabaseInterface,
  type EventBusInterface,
  type TaskTree,
  type TaskTreeNode,
  type TaskTreeStatus,
  type ExecutionTask,
  type ExecutionTaskStatus,
  type TaskArtifact,
} from '@raven/shared';
import { findReadyTasks } from './dependency-resolver.ts';
import {
  validateTaskResult,
  buildRetryPrompt,
  type ValidationDeps,
} from './validation-pipeline.ts';

const execFileAsync = promisify(execFileCb);

const log = createLogger('task-execution-engine');

// ── Magic number constants ──────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

// ── Duration parser ─────────────────────────────────────────────────────

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: MS_PER_SECOND,
  m: MS_PER_SECOND * SECONDS_PER_MINUTE,
  h: MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR,
  d: MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY,
};

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  return value * (DURATION_UNITS[unit] ?? MS_PER_SECOND);
}

// ── DB row types ────────────────────────────────────────────────────────

interface TaskTreeRow {
  id: string;
  project_id: string | null;
  status: string;
  plan: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionTaskRow {
  id: string;
  parent_task_id: string;
  node_json: string;
  status: string;
  agent_task_id: string | null;
  artifacts_json: string;
  summary: string | null;
  retry_count: number;
  last_error: string | null;
  needs_replan: number;
  validation_result_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Row mapping ─────────────────────────────────────────────────────────

function rowToExecutionTask(row: ExecutionTaskRow): ExecutionTask {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    node: JSON.parse(row.node_json) as TaskTreeNode,
    status: row.status as ExecutionTaskStatus,
    ...(row.agent_task_id !== null && { agentTaskId: row.agent_task_id }),
    artifacts: JSON.parse(row.artifacts_json) as TaskArtifact[],
    ...(row.summary !== null && { summary: row.summary }),
    retryCount: row.retry_count,
    ...(row.last_error !== null && { lastError: row.last_error }),
    ...(row.needs_replan === 1 && { needsReplan: true }),
    ...(row.validation_result_json !== null && {
      validationResult: JSON.parse(row.validation_result_json) as ExecutionTask['validationResult'],
    }),
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.completed_at !== null && { completedAt: row.completed_at }),
  };
}

function rowToTaskTree(treeRow: TaskTreeRow, taskRows: ExecutionTaskRow[]): TaskTree {
  const tasks = new Map<string, ExecutionTask>();
  for (const row of taskRows) {
    tasks.set(row.id, rowToExecutionTask(row));
  }
  return {
    id: treeRow.id,
    ...(treeRow.project_id !== null && { projectId: treeRow.project_id }),
    status: treeRow.status as TaskTreeStatus,
    tasks,
    ...(treeRow.plan !== null && { plan: treeRow.plan }),
    createdAt: treeRow.created_at,
    updatedAt: treeRow.updated_at,
  };
}

// ── Create tree options ─────────────────────────────────────────────────

export interface CreateTreeOptions {
  id: string;
  projectId?: string;
  plan?: string;
  tasks: TaskTreeNode[];
}

// ── Engine deps ─────────────────────────────────────────────────────────

export interface TaskExecutionEngineDeps {
  db: DatabaseInterface;
  eventBus: EventBusInterface;
  validationDeps?: ValidationDeps;
}

// ── Condition evaluator ─────────────────────────────────────────────────

function evaluateCondition(expression: string, tasks: Map<string, ExecutionTask>): boolean {
  // Replace {{ taskId.result }} references
  const resolved = expression.replace(
    /\{\{\s*([\w-]+)\.result\s*\}\}/g,
    (_match, taskId: string) => {
      const task = tasks.get(taskId);
      if (!task) return 'false';
      const dataArt = task.artifacts.find((a) => a.type === 'data');
      if (dataArt?.data?.['result'] !== undefined) {
        return String(dataArt.data['result']);
      }
      return String(task.status === 'completed');
    },
  );

  // Replace {{ taskId.artifacts.data.field }} references
  const fullyResolved = resolved.replace(
    /\{\{\s*([\w-]+)\.artifacts\.data\.([\w.]+)\s*\}\}/g,
    (_match, taskId: string, field: string) => {
      const task = tasks.get(taskId);
      if (!task) return 'undefined';
      const dataArt = task.artifacts.find((a) => a.type === 'data');
      if (!dataArt?.data) return 'undefined';
      const value = dataArt.data[field];
      return value === undefined ? 'undefined' : JSON.stringify(value);
    },
  );

  // Simple comparisons
  if (fullyResolved === 'true') return true;
  if (fullyResolved === 'false') return false;

  // Handle simple comparison patterns
  const COMP_RIGHT_GROUP = 3;
  const compMatch = fullyResolved.match(/^(.+?)\s*(===|!==|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    return evaluateComparison(
      compMatch[1].trim(),
      compMatch[2],
      compMatch[COMP_RIGHT_GROUP].trim(),
    );
  }

  // Default: truthy check
  return fullyResolved !== 'undefined' && fullyResolved !== '0' && fullyResolved !== '';
}

type ComparisonFn = (a: number | string, b: number | string) => boolean;

const COMPARATORS: Record<string, ComparisonFn> = {
  '===': (a, b) => a === b,
  '!==': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
};

function evaluateComparison(left: string, op: string, right: string): boolean {
  const comparator = COMPARATORS[op];
  if (!comparator) return false;

  const leftNum = Number(left);
  const rightNum = Number(right);
  const useNum = !isNaN(leftNum) && !isNaN(rightNum);

  return useNum ? comparator(leftNum, rightNum) : comparator(left, right);
}

// ── Terminal status check ───────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<ExecutionTaskStatus>([
  'completed',
  'skipped',
  'failed',
  'cancelled',
]);

function isTerminal(status: ExecutionTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ── TaskExecutionEngine ─────────────────────────────────────────────────

export class TaskExecutionEngine {
  private readonly db: DatabaseInterface;
  private readonly eventBus: EventBusInterface;
  private readonly validationDeps: ValidationDeps;
  private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly trees = new Map<string, TaskTree>();

  constructor(deps: TaskExecutionEngineDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.validationDeps = deps.validationDeps ?? {
      runEvaluator: async () => ({ passed: true, reason: 'no evaluator configured' }),
      runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
    };
  }

  // ── Public API ──────────────────────────────────────────────────────

  createTree(opts: CreateTreeOptions): TaskTree {
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO task_trees (id, project_id, status, plan, created_at, updated_at)
       VALUES (?, ?, 'pending_approval', ?, ?, ?)`,
      opts.id,
      opts.projectId ?? null,
      opts.plan ?? null,
      now,
      now,
    );

    const tasks = new Map<string, ExecutionTask>();
    for (const node of opts.tasks) {
      this.insertExecutionTask(opts.id, node, now);
      tasks.set(node.id, {
        id: node.id,
        parentTaskId: opts.id,
        node,
        status: 'todo',
        artifacts: [],
        retryCount: 0,
      });
    }

    const tree: TaskTree = {
      id: opts.id,
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
      status: 'pending_approval',
      tasks,
      ...(opts.plan !== undefined && { plan: opts.plan }),
      createdAt: now,
      updatedAt: now,
    };

    this.trees.set(opts.id, tree);
    return tree;
  }

  async startTree(treeId: string): Promise<void> {
    const tree = this.loadTree(treeId);
    if (!tree) throw new Error(`Tree not found: ${treeId}`);

    this.updateTreeStatus(tree, 'running');
    this.processReadyTasks(tree);
  }

  async onTaskCompleted(opts: {
    treeId: string;
    taskId: string;
    summary: string;
    artifacts: TaskArtifact[];
  }): Promise<void> {
    const tree = this.loadTree(opts.treeId);
    if (!tree) return;

    const task = tree.tasks.get(opts.taskId);
    if (!task) return;

    task.summary = opts.summary;
    task.artifacts = opts.artifacts;

    if (task.node.type === 'agent' && task.node.validation) {
      await this.runValidation(tree, task);
    } else {
      this.markTaskCompleted(tree, task);
    }
  }

  onTaskBlocked(treeId: string, taskId: string, reason: string): void {
    const tree = this.loadTree(treeId);
    if (!tree) return;

    const task = tree.tasks.get(taskId);
    if (!task) return;

    this.updateTaskStatus(tree, task, 'blocked');
    task.lastError = reason;
    this.saveTask(tree.id, task);

    this.emitEvent('execution:task:blocked', { treeId, taskId, reason });
  }

  async onApprovalGranted(treeId: string, taskId: string): Promise<void> {
    const tree = this.loadTree(treeId);
    if (!tree) return;

    const task = tree.tasks.get(taskId);
    if (!task) return;

    this.markTaskCompleted(tree, task);
  }

  cancelTree(treeId: string): void {
    const tree = this.loadTree(treeId);
    if (!tree) return;

    for (const [, task] of tree.tasks) {
      if (!isTerminal(task.status)) {
        this.updateTaskStatus(tree, task, 'cancelled');
        this.saveTask(tree.id, task);
      }
    }

    // Clear any delay timers
    for (const [key, timer] of this.delayTimers) {
      if (key.startsWith(treeId)) {
        clearTimeout(timer);
        this.delayTimers.delete(key);
      }
    }

    this.updateTreeStatus(tree, 'cancelled');
  }

  getTree(treeId: string): TaskTree | undefined {
    return this.loadTree(treeId);
  }

  getActiveTrees(): TaskTree[] {
    const rows = this.db.all<TaskTreeRow>(
      `SELECT * FROM task_trees WHERE status IN ('pending_approval', 'running')`,
    );
    return rows.map((row) => this.loadTreeFromRow(row)).filter(Boolean) as TaskTree[];
  }

  // ── Private: task processing ────────────────────────────────────────

  private processReadyTasks(tree: TaskTree): void {
    const readyIds = findReadyTasks(tree.tasks);
    for (const taskId of readyIds) {
      const task = tree.tasks.get(taskId);
      if (task) {
        this.executeTask(tree, task);
      }
    }
  }

  private executeTask(tree: TaskTree, task: ExecutionTask): void {
    // Check runIf condition
    if (task.node.runIf) {
      const shouldRun = evaluateCondition(task.node.runIf, tree.tasks);
      if (!shouldRun) {
        this.updateTaskStatus(tree, task, 'skipped');
        this.saveTask(tree.id, task);
        this.checkTreeCompletion(tree);
        this.processReadyTasks(tree);
        return;
      }
    }

    switch (task.node.type) {
      case 'agent':
        this.executeAgentTask(tree, task);
        break;
      case 'code':
        this.executeCodeTask(tree, task);
        break;
      case 'condition':
        this.executeConditionTask(tree, task);
        break;
      case 'notify':
        this.executeNotifyTask(tree, task);
        break;
      case 'delay':
        this.executeDelayTask(tree, task);
        break;
      case 'approval':
        this.executeApprovalTask(tree, task);
        break;
    }
  }

  private executeAgentTask(tree: TaskTree, task: ExecutionTask): void {
    this.updateTaskStatus(tree, task, 'in_progress');
    task.startedAt = new Date().toISOString();
    this.saveTask(tree.id, task);

    const retryFeedback =
      task.retryCount > 0 && task.lastError
        ? buildRetryPrompt(
            task.node.type === 'agent' ? task.node.prompt : task.node.title,
            task.lastError,
            task.retryCount,
          )
        : undefined;

    this.emitEvent('execution:task:run-agent', {
      treeId: tree.id,
      taskId: task.id,
      agent: task.node.type === 'agent' ? task.node.agent : undefined,
      prompt: task.node.type === 'agent' ? task.node.prompt : task.node.title,
      parentTaskId: task.parentTaskId,
      ...(retryFeedback !== undefined && { retryFeedback }),
    });
  }

  private executeCodeTask(tree: TaskTree, task: ExecutionTask): void {
    this.updateTaskStatus(tree, task, 'in_progress');
    task.startedAt = new Date().toISOString();
    this.saveTask(tree.id, task);

    if (task.node.type !== 'code') return;

    const { script, args } = task.node;

    execFileAsync(script, args)
      .then(({ stdout }) => {
        const artifact: TaskArtifact = {
          type: 'data',
          label: 'stdout',
          data: { output: stdout.trim() },
        };
        task.summary = stdout.trim();
        task.artifacts = [artifact];
        this.markTaskCompleted(tree, task);
      })
      .catch((err: Error) => {
        this.handleTaskFailure(tree, task, err.message);
      });
  }

  private executeConditionTask(tree: TaskTree, task: ExecutionTask): void {
    if (task.node.type !== 'condition') return;

    const result = evaluateCondition(task.node.expression, tree.tasks);
    const artifact: TaskArtifact = {
      type: 'data',
      label: 'condition-result',
      data: { result },
    };

    task.artifacts = [artifact];
    task.summary = `Condition evaluated to ${String(result)}`;
    this.markTaskCompleted(tree, task);
  }

  private executeNotifyTask(tree: TaskTree, task: ExecutionTask): void {
    if (task.node.type !== 'notify') return;

    this.emitEvent('notification:deliver', {
      channel: task.node.channel,
      title: task.node.title,
      body: task.node.message,
    });

    task.summary = `Notification sent to ${task.node.channel}`;
    this.markTaskCompleted(tree, task);
  }

  private executeDelayTask(tree: TaskTree, task: ExecutionTask): void {
    if (task.node.type !== 'delay') return;

    this.updateTaskStatus(tree, task, 'in_progress');
    task.startedAt = new Date().toISOString();
    this.saveTask(tree.id, task);

    const ms = parseDuration(task.node.duration);
    const timerKey = `${tree.id}:${task.id}`;

    const timer = setTimeout(() => {
      this.delayTimers.delete(timerKey);
      task.summary = `Delayed ${task.node.type === 'delay' ? task.node.duration : ''}`;
      this.markTaskCompleted(tree, task);
    }, ms);

    this.delayTimers.set(timerKey, timer);
  }

  private executeApprovalTask(tree: TaskTree, task: ExecutionTask): void {
    if (task.node.type !== 'approval') return;

    this.updateTaskStatus(tree, task, 'pending_approval');
    this.saveTask(tree.id, task);

    this.emitEvent('execution:task:approval-needed', {
      treeId: tree.id,
      taskId: task.id,
      message: task.node.message,
    });
  }

  // ── Private: validation ─────────────────────────────────────────────

  private async runValidation(tree: TaskTree, task: ExecutionTask): Promise<void> {
    this.updateTaskStatus(tree, task, 'validating');
    this.saveTask(tree.id, task);

    const config = task.node.validation;
    const result = await validateTaskResult(task, config, this.validationDeps);

    task.validationResult = {
      gate1Passed: result.gate1Passed,
      gate2Passed: result.gate2Passed,
      gate2Reason: result.gate2Reason,
      gate3Passed: result.gate3Passed,
      gate3Score: result.gate3Score,
      gate3Feedback: result.gate3Feedback,
    };

    if (result.passed) {
      this.markTaskCompleted(tree, task);
      return;
    }

    this.handleValidationFailure(tree, task, result);
  }

  // eslint-disable-next-line complexity -- branching on retry/maxRetries/onMaxRetriesFailed
  private handleValidationFailure(
    tree: TaskTree,
    task: ExecutionTask,
    result: { gate2Reason?: string; gate3Feedback?: string },
  ): void {
    const config = task.node.validation;
    const maxRetries = config?.maxRetries ?? 2;
    const errorMsg = result.gate2Reason ?? result.gate3Feedback ?? 'Validation failed';

    if (task.retryCount < maxRetries) {
      task.retryCount += 1;
      task.lastError = errorMsg;
      this.updateTaskStatus(tree, task, 'todo');
      this.saveTask(tree.id, task);
      this.processReadyTasks(tree);
      return;
    }

    const onFail = config?.onMaxRetriesFailed ?? 'escalate';
    task.lastError = errorMsg;

    switch (onFail) {
      case 'escalate':
        this.updateTaskStatus(tree, task, 'failed');
        this.saveTask(tree.id, task);
        this.emitEvent('execution:task:failed', {
          treeId: tree.id,
          taskId: task.id,
          error: errorMsg,
        });
        this.checkTreeCompletion(tree);
        break;
      case 'skip':
        this.updateTaskStatus(tree, task, 'skipped');
        this.saveTask(tree.id, task);
        this.checkTreeCompletion(tree);
        this.processReadyTasks(tree);
        break;
      case 'fail':
        this.updateTaskStatus(tree, task, 'failed');
        this.saveTask(tree.id, task);
        this.emitEvent('execution:task:failed', {
          treeId: tree.id,
          taskId: task.id,
          error: errorMsg,
        });
        this.updateTreeStatus(tree, 'failed');
        break;
    }
  }

  private handleTaskFailure(tree: TaskTree, task: ExecutionTask, error: string): void {
    this.updateTaskStatus(tree, task, 'failed');
    task.lastError = error;
    this.saveTask(tree.id, task);
    this.emitEvent('execution:task:failed', {
      treeId: tree.id,
      taskId: task.id,
      error,
    });
    this.checkTreeCompletion(tree);
  }

  // ── Private: state transitions ──────────────────────────────────────

  private markTaskCompleted(tree: TaskTree, task: ExecutionTask): void {
    this.updateTaskStatus(tree, task, 'completed');
    task.completedAt = new Date().toISOString();
    this.saveTask(tree.id, task);

    this.emitEvent('execution:task:completed', {
      treeId: tree.id,
      taskId: task.id,
      summary: task.summary,
      artifacts: task.artifacts,
    });

    this.checkTreeCompletion(tree);
    this.processReadyTasks(tree);
  }

  private updateTaskStatus(tree: TaskTree, task: ExecutionTask, status: ExecutionTaskStatus): void {
    log.debug(`Task ${task.id} status: ${task.status} -> ${status}`);
    task.status = status;
  }

  private updateTreeStatus(tree: TaskTree, status: TaskTreeStatus): void {
    log.info(`Tree ${tree.id} status: ${tree.status} -> ${status}`);
    tree.status = status;
    tree.updatedAt = new Date().toISOString();
    this.db.run(
      `UPDATE task_trees SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      tree.updatedAt,
      tree.id,
    );
    this.trees.set(tree.id, tree);

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.emitEvent('execution:tree:completed', {
        treeId: tree.id,
        status,
      });
    }
  }

  private checkTreeCompletion(tree: TaskTree): void {
    const allTerminal = [...tree.tasks.values()].every((t) => isTerminal(t.status));
    if (!allTerminal) return;

    const anyFailed = [...tree.tasks.values()].some((t) => t.status === 'failed');
    const newStatus: TaskTreeStatus = anyFailed ? 'failed' : 'completed';
    this.updateTreeStatus(tree, newStatus);
  }

  // ── Private: DB persistence ─────────────────────────────────────────

  private insertExecutionTask(treeId: string, node: TaskTreeNode, now: string): void {
    this.db.run(
      `INSERT INTO execution_tasks
       (id, parent_task_id, node_json, status, artifacts_json, retry_count, needs_replan, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', '[]', 0, 0, ?, ?)`,
      node.id,
      treeId,
      JSON.stringify(node),
      now,
      now,
    );
  }

  private saveTask(treeId: string, task: ExecutionTask): void {
    this.db.run(
      `UPDATE execution_tasks SET
       status = ?, agent_task_id = ?, artifacts_json = ?, summary = ?,
       retry_count = ?, last_error = ?, needs_replan = ?,
       validation_result_json = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND parent_task_id = ?`,
      task.status,
      task.agentTaskId ?? null,
      JSON.stringify(task.artifacts),
      task.summary ?? null,
      task.retryCount,
      task.lastError ?? null,
      task.needsReplan ? 1 : 0,
      task.validationResult ? JSON.stringify(task.validationResult) : null,
      task.startedAt ?? null,
      task.completedAt ?? null,
      new Date().toISOString(),
      task.id,
      treeId,
    );
  }

  private loadTree(treeId: string): TaskTree | undefined {
    // Check cache first
    const cached = this.trees.get(treeId);
    if (cached) return cached;

    const treeRow = this.db.get<TaskTreeRow>(`SELECT * FROM task_trees WHERE id = ?`, treeId);
    if (!treeRow) return undefined;

    return this.loadTreeFromRow(treeRow);
  }

  private loadTreeFromRow(treeRow: TaskTreeRow): TaskTree {
    const taskRows = this.db.all<ExecutionTaskRow>(
      `SELECT * FROM execution_tasks WHERE parent_task_id = ?`,
      treeRow.id,
    );

    const tree = rowToTaskTree(treeRow, taskRows);
    this.trees.set(tree.id, tree);
    return tree;
  }

  // ── Private: event emission ─────────────────────────────────────────

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'task-execution-engine',
      type,
      payload,
    });
  }
}
