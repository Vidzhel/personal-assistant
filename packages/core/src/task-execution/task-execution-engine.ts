import {
  generateId,
  type EventBusInterface,
  type ExecutionTask,
  type ExecutionTaskStatus,
  type TaskArtifact,
  type TaskTree,
  type TaskTreeNode,
  type TaskTreeStatus,
  TaskTreeNodeSchema,
} from '@raven/shared';
import type { ProjectRecordProject } from '../project-manager/project-records.ts';
import { runAfterProjectMutations } from '../project-manager/project-mutation.ts';
import { findReadyTasks } from './dependency-resolver.ts';
import { runCodeProcess } from './run-code-process.ts';
import {
  readTaskTreeRecords,
  treeLocation,
  normalizeTaskTree,
  writeTaskTreeRecord,
  type TaskTreeRecord,
  type TaskTreeRecordDeps,
} from './task-tree-records.ts';
import {
  validateTaskResult,
  type ValidationDeps,
  type ValidationResult,
} from './validation-pipeline.ts';

const TREE_LIMIT = 50;
const ONE_MILLISECOND = 1;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const THIRD_CAPTURE = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const INTERRUPTED_REASON = 'Execution interrupted by process restart; deliberate resume required';

const DURATION_UNITS: Record<string, number> = {
  ms: ONE_MILLISECOND,
  s: MILLISECONDS_PER_SECOND,
  m: SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
  h: MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
  d: HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
};

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration format: ${duration}`);
  const milliseconds = Number(match[1]) * (DURATION_UNITS[match[2]] ?? MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new Error(`Duration exceeds supported timer limit: ${duration}`);
  }
  return milliseconds;
}

function resolveResultReferences(expression: string, tasks: Map<string, ExecutionTask>): string {
  return expression.replace(/\{\{\s*([\w-]+)\.result\s*\}\}/g, (_match, taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) return 'false';
    const artifact = task.artifacts.find((candidate) => candidate.type === 'data');
    return artifact?.data?.['result'] !== undefined
      ? String(artifact.data['result'])
      : String(task.status === 'completed');
  });
}

function resolveDataReferences(expression: string, tasks: Map<string, ExecutionTask>): string {
  return expression.replace(
    /\{\{\s*([\w-]+)\.artifacts\.data\.([\w.]+)\s*\}\}/g,
    (_match, taskId: string, field: string) => {
      const data = tasks
        .get(taskId)
        ?.artifacts.find((candidate) => candidate.type === 'data')?.data;
      return data?.[field] === undefined ? 'undefined' : JSON.stringify(data[field]);
    },
  );
}

function evaluateCondition(expression: string, tasks: Map<string, ExecutionTask>): boolean {
  const fullyResolved = resolveDataReferences(resolveResultReferences(expression, tasks), tasks);
  if (fullyResolved === 'true') return true;
  if (fullyResolved === 'false') return false;
  const match = fullyResolved.match(/^(.+?)\s*(===|!==|>=|<=|>|<)\s*(.+)$/);
  if (!match) return isTruthyExpression(fullyResolved);
  return compareValues(match[1].trim(), match[2], match[THIRD_CAPTURE].trim());
}

function isTruthyExpression(expression: string): boolean {
  return expression !== 'undefined' && expression !== '0' && expression !== '';
}

function compareValues(leftText: string, operator: string, rightText: string): boolean {
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  const left: number | string = Number.isNaN(leftNumber) ? leftText : leftNumber;
  const right: number | string = Number.isNaN(rightNumber) ? rightText : rightNumber;
  switch (operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '>':
      return left > right;
    case '<':
      return left < right;
    case '>=':
      return left >= right;
    case '<=':
      return left <= right;
    default:
      return false;
  }
}

const TERMINAL_STATUSES = new Set<ExecutionTaskStatus>([
  'completed',
  'skipped',
  'failed',
  'cancelled',
]);

function isTerminal(status: ExecutionTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function cloneTask(task: ExecutionTask): ExecutionTask {
  return structuredClone(task);
}

function cloneTree(tree: TaskTree): TaskTree {
  return {
    ...tree,
    tasks: new Map([...tree.tasks].map(([id, task]) => [id, cloneTask(task)])),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface CreateTreeOptions {
  id: string;
  projectId?: string;
  scheduleId?: string;
  plan?: string;
  tasks: TaskTreeNode[];
}

export interface TaskExecutionEngineDeps {
  projectsDir: string;
  projects: () => ProjectRecordProject[];
  eventBus: EventBusInterface;
  validationDeps?: ValidationDeps;
}

interface LifetimeState {
  generation: number;
  admissionStopped: boolean;
  transitionsClosed: boolean;
  stopped: boolean;
}

export class TaskExecutionEngine {
  private readonly recordDeps: TaskTreeRecordDeps;
  private readonly eventBus: EventBusInterface;
  private readonly validationDeps?: ValidationDeps;
  private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly codeControllers = new Map<string, AbortController>();
  private readonly validationControllers = new Map<string, AbortController>();
  private readonly localWork = new Set<Promise<unknown>>();
  private readonly lifetime: LifetimeState = {
    generation: 0,
    admissionStopped: false,
    transitionsClosed: false,
    stopped: false,
  };
  private initialized = false;
  private stopPromise: Promise<void> | undefined;

  constructor(deps: TaskExecutionEngineDeps) {
    this.recordDeps = {
      projectsDir: deps.projectsDir,
      projects: deps.projects,
    };
    this.eventBus = deps.eventBus;
    this.validationDeps = deps.validationDeps;
  }

  createTree(opts: CreateTreeOptions): TaskTree {
    this.assertAdmission();
    this.initialize();
    const now = new Date().toISOString();
    const tasks = new Map<string, ExecutionTask>();
    for (const candidate of opts.tasks) {
      const node = TaskTreeNodeSchema.parse(candidate);
      if (tasks.has(node.id)) throw new Error(`Duplicate execution task ID: ${node.id}`);
      tasks.set(node.id, {
        id: node.id,
        parentTaskId: opts.id,
        node: structuredClone(node),
        status: 'todo',
        artifacts: [],
        retryCount: 0,
      });
    }
    const tree: TaskTree = {
      id: opts.id,
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
      ...(opts.scheduleId !== undefined && { scheduleId: opts.scheduleId }),
      status: 'pending_approval',
      tasks,
      ...(opts.plan !== undefined && { plan: opts.plan }),
      createdAt: now,
      updatedAt: now,
    };
    this.validateCandidate(tree);
    const location = treeLocation(this.recordDeps, tree.projectId, tree.id);
    if (this.findRecord(tree.id)) throw new Error(`Task tree already exists: ${tree.id}`);
    writeTaskTreeRecord(this.recordDeps, location, tree);
    return cloneTree(tree);
  }

  startTree(treeId: string): Promise<void> {
    if (!this.admitTransition())
      return Promise.reject(new Error('Task execution engine is stopping'));
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record) throw new Error(`Tree not found: ${treeId}`);
      if (record.tree.status !== 'pending_approval') {
        throw new Error(`Tree is not pending approval (status: ${record.tree.status})`);
      }
      const tree = record.tree;
      for (const task of tree.tasks.values()) {
        if (task.interrupted && task.status === 'blocked') {
          task.status = 'todo';
          task.lastError = undefined;
          task.interrupted = undefined;
        }
      }
      tree.interrupted = undefined;
      tree.status = 'running';
      const status = this.persistTransition(tree, record.bytes);
      if (status) this.emitEvent('execution:tree:completed', { treeId, status });
      else this.processReadyTasks(tree);
    });
    this.track(work);
    return work;
  }

  onTaskCompleted(opts: {
    treeId: string;
    taskId: string;
    summary: string;
    artifacts: TaskArtifact[];
    agentTaskId?: string;
  }): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = this.completeTask(opts);
    this.track(work);
    return work;
  }

  private async completeTask(opts: {
    treeId: string;
    taskId: string;
    summary: string;
    artifacts: TaskArtifact[];
    agentTaskId?: string;
  }): Promise<void> {
    const validation = await runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(opts.treeId);
      if (!record || this.lifetime.stopped) return undefined;
      const task = record.tree.tasks.get(opts.taskId);
      if (!task || task.status !== 'in_progress' || !this.ownsAttempt(task, opts.agentTaskId))
        return undefined;
      const attempt = task.agentTaskId;
      task.summary = opts.summary;
      task.artifacts = structuredClone(opts.artifacts);
      if (task.node.type !== 'agent' || !task.node.validation) {
        this.markTaskCompleted({ tree: record.tree, task, expectedBytes: record.bytes });
        return undefined;
      }
      task.status = 'validating';
      this.touch(record.tree);
      this.persist(record.tree, record.bytes);
      return { attempt, taskSnapshot: stableJson(task) };
    });
    if (validation) {
      const work = this.runValidation({
        treeId: opts.treeId,
        taskId: opts.taskId,
        attempt: validation.attempt,
        taskSnapshot: validation.taskSnapshot,
      });
      this.track(work);
      await work;
    }
  }

  onTaskBlocked(
    treeId: string,
    taskId: string,
    reason: string | { reason: string; agentTaskId?: string },
  ): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return;
      const task = record.tree.tasks.get(taskId);
      const attempt = typeof reason === 'string' ? undefined : reason.agentTaskId;
      const message = typeof reason === 'string' ? reason : reason.reason;
      if (!task || isTerminal(task.status) || !this.ownsAttempt(task, attempt)) return;
      task.status = 'blocked';
      task.lastError = message;
      this.touch(record.tree);
      this.persist(record.tree, record.bytes);
      this.emitEvent('execution:task:blocked', { treeId, taskId, reason: message });
    });
    this.track(work);
    return work;
  }

  onTaskCancelled(treeId: string, taskId: string, agentTaskId?: string): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return;
      const task = record.tree.tasks.get(taskId);
      if (!task || isTerminal(task.status) || !this.ownsAttempt(task, agentTaskId)) return;
      task.status = 'cancelled';
      task.interrupted = undefined;
      this.cancelDependents(record.tree, taskId);
      const treeStatus = this.persistTransition(record.tree, record.bytes);
      if (treeStatus) {
        this.emitEvent('execution:tree:completed', { treeId, status: treeStatus });
      }
    });
    this.track(work);
    return work;
  }

  onTaskFailed(
    treeId: string,
    taskId: string,
    error: string | { reason: string; agentTaskId?: string },
  ): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return;
      const task = record.tree.tasks.get(taskId);
      const attempt = typeof error === 'string' ? undefined : error.agentTaskId;
      const message = typeof error === 'string' ? error : error.reason;
      if (!task || isTerminal(task.status) || !this.ownsAttempt(task, attempt)) return;
      if (this.retryFailedTask(record, task, message)) return;
      this.failTask({ tree: record.tree, task, error: message, expectedBytes: record.bytes });
    });
    this.track(work);
    return work;
  }

  private retryFailedTask(record: TaskTreeRecord, task: ExecutionTask, error: string): boolean {
    const maxRetries = task.node.type === 'agent' ? (task.node.validation?.maxRetries ?? 2) : 2;
    if (task.retryCount >= maxRetries || this.lifetime.admissionStopped) return false;
    task.retryCount += 1;
    task.lastError = error;
    task.status = 'todo';
    task.agentTaskId = undefined;
    this.touch(record.tree);
    this.persist(record.tree, record.bytes);
    this.scheduleRetry(record.tree.id, task.id, this.retryBackoff(task));
    return true;
  }

  private retryBackoff(task: ExecutionTask): number {
    return task.node.type === 'agent' ? (task.node.validation?.retryBackoffMs ?? 0) : 0;
  }

  private scheduleRetry(treeId: string, taskId: string, delayMs: number): void {
    const key = `${treeId}:${taskId}`;
    const previous = this.delayTimers.get(key);
    if (previous) clearTimeout(previous);
    const generation = this.lifetime.generation;
    if (delayMs <= 0) {
      const record = this.loadRecord(treeId);
      if (record?.tree.tasks.get(taskId)?.status === 'todo') this.processReadyTasks(record.tree);
      return;
    }
    const timer = setTimeout(() => {
      const retry = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
        if (this.delayTimers.get(key) !== timer || !this.isLifetimeCurrent(generation)) return;
        this.delayTimers.delete(key);
        const record = this.loadRecord(treeId);
        if (record?.tree.tasks.get(taskId)?.status === 'todo') this.processReadyTasks(record.tree);
      });
      this.track(retry);
    }, delayMs);
    this.delayTimers.set(key, timer);
  }

  async setAgentTaskId(treeId: string, taskId: string, agentTaskId: string): Promise<boolean> {
    if (!this.admitTransition()) return false;
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return false;
      const task = record.tree.tasks.get(taskId);
      if (!task || task.status !== 'in_progress' || task.agentTaskId !== undefined) return false;
      task.agentTaskId = agentTaskId;
      this.touch(record.tree);
      this.persist(record.tree, record.bytes);
      return true;
    });
    this.track(work);
    return work;
  }

  onApprovalGranted(treeId: string, taskId: string): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return;
      const task = record.tree.tasks.get(taskId);
      if (!task || task.status !== 'pending_approval') return;
      this.markTaskCompleted({ tree: record.tree, task, expectedBytes: record.bytes });
    });
    this.track(work);
    return work;
  }

  cancelTree(treeId: string): Promise<void> {
    if (!this.admitCompletion()) return Promise.resolve();
    const work = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      const record = this.loadRecord(treeId);
      if (!record || this.lifetime.stopped) return;
      const tree = record.tree;
      if (tree.status === 'cancelled' || tree.status === 'completed' || tree.status === 'failed')
        return;
      for (const task of tree.tasks.values()) {
        if (!isTerminal(task.status)) task.status = 'cancelled';
        task.interrupted = undefined;
      }
      tree.interrupted = undefined;
      tree.status = 'cancelled';
      this.touch(tree);
      this.persist(tree, record.bytes);
      this.clearTreeWork(treeId);
      this.emitEvent('execution:tree:cancelled', { treeId });
      this.emitEvent('execution:tree:completed', { treeId, status: 'cancelled' });
    });
    this.track(work);
    return work;
  }

  getTree(treeId: string): TaskTree | undefined {
    const record = this.loadRecord(treeId);
    return record ? cloneTree(record.tree) : undefined;
  }

  getActiveTrees(): TaskTree[] {
    return this.queryTrees().filter(
      (tree) => tree.status === 'pending_approval' || tree.status === 'running',
    );
  }

  getAllTrees(): TaskTree[] {
    return this.queryTrees().slice(0, TREE_LIMIT);
  }

  queryTrees(): TaskTree[] {
    if (!this.lifetime.stopped) this.initialize();
    return readTaskTreeRecords(this.recordDeps, !this.lifetime.stopped)
      .sort(
        (a, b) =>
          Date.parse(b.tree.createdAt) - Date.parse(a.tree.createdAt) ||
          a.tree.id.localeCompare(b.tree.id),
      )
      .map((record) => cloneTree(record.tree));
  }

  stopAdmission(): void {
    this.lifetime.admissionStopped = true;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.drainStop();
    return this.stopPromise;
  }

  private async drainStop(): Promise<void> {
    if (this.lifetime.stopped) return;
    this.stopAdmission();
    this.lifetime.transitionsClosed = true;
    this.lifetime.generation += 1;
    for (const timer of this.delayTimers.values()) clearTimeout(timer);
    this.delayTimers.clear();
    for (const controller of this.codeControllers.values()) controller.abort();
    for (const controller of this.validationControllers.values()) controller.abort();
    while (this.localWork.size > 0) {
      await Promise.allSettled([...this.localWork]);
    }
    this.lifetime.stopped = true;
    this.codeControllers.clear();
    this.validationControllers.clear();
  }

  private assertAdmission(): void {
    if (this.lifetime.stopped || this.lifetime.admissionStopped) {
      throw new Error('Task execution engine is stopping');
    }
  }

  private admitTransition(): boolean {
    return (
      !this.lifetime.admissionStopped && !this.lifetime.transitionsClosed && !this.lifetime.stopped
    );
  }

  private admitCompletion(): boolean {
    return !this.lifetime.transitionsClosed && !this.lifetime.stopped;
  }

  private ownsAttempt(task: ExecutionTask, agentTaskId?: string): boolean {
    return task.agentTaskId === undefined
      ? agentTaskId === undefined
      : task.agentTaskId === agentTaskId;
  }

  private initialize(): void {
    if (this.initialized || this.lifetime.stopped) return;
    for (const record of readTaskTreeRecords(this.recordDeps)) {
      if (record.tree.status !== 'running') continue;
      for (const task of record.tree.tasks.values()) {
        if (task.status !== 'in_progress' && task.status !== 'validating') continue;
        task.status = 'blocked';
        task.lastError = INTERRUPTED_REASON;
        task.interrupted = true;
        task.agentTaskId = undefined;
      }
      record.tree.interrupted = true;
      record.tree.status = 'pending_approval';
      this.touch(record.tree);
      writeTaskTreeRecord(
        this.recordDeps,
        treeLocation(this.recordDeps, record.tree.projectId, record.tree.id),
        record.tree,
      );
    }
    this.initialized = true;
  }

  private findRecord(treeId: string): TaskTreeRecord | undefined {
    return readTaskTreeRecords(this.recordDeps, !this.lifetime.stopped).find(
      (record) => record.tree.id === treeId,
    );
  }

  private loadRecord(treeId: string): TaskTreeRecord | undefined {
    this.initialize();
    const record = this.findRecord(treeId);
    return record;
  }

  private persist(tree: TaskTree, expectedBytes: string): string {
    this.validateCandidate(tree);
    if (this.findRecord(tree.id)?.bytes !== expectedBytes) {
      throw new Error(`Execution tree changed on disk: ${tree.id}`);
    }
    const location = treeLocation(this.recordDeps, tree.projectId, tree.id);
    return writeTaskTreeRecord(this.recordDeps, location, tree);
  }

  private validateCandidate(tree: TaskTree): void {
    const normalized = normalizeTaskTree(tree);
    tree.tasks = normalized.tasks;
  }

  private touch(tree: TaskTree): void {
    tree.updatedAt = new Date().toISOString();
  }

  private processReadyTasks(tree: TaskTree): void {
    if (this.lifetime.stopped || this.lifetime.admissionStopped) return;
    for (const taskId of findReadyTasks(tree.tasks)) {
      if (this.delayTimers.has(`${tree.id}:${taskId}`)) continue;
      const task = tree.tasks.get(taskId);
      if (task) this.executeTask(tree.id, taskId);
    }
  }

  private executeTask(treeId: string, taskId: string): void {
    const record = this.loadRecord(treeId);
    if (!record || record.tree.status !== 'running' || this.lifetime.stopped) return;
    const task = record.tree.tasks.get(taskId);
    if (!task || task.status !== 'todo') return;
    if (this.skipConditionalTask(record, task)) return;
    this.dispatchTask(record, taskId);
  }

  private skipConditionalTask(record: TaskTreeRecord, task: ExecutionTask): boolean {
    if (!task.node.runIf || evaluateCondition(task.node.runIf, record.tree.tasks)) return false;
    task.status = 'skipped';
    const treeStatus = this.persistTransition(record.tree, record.bytes);
    if (treeStatus)
      this.emitEvent('execution:tree:completed', { treeId: record.tree.id, status: treeStatus });
    this.processReadyTasks(record.tree);
    return true;
  }

  private dispatchTask(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task) return;
    switch (task.node.type) {
      case 'agent':
        this.executeAgent(record, taskId);
        break;
      case 'code':
        this.executeCode(record, taskId);
        break;
      case 'condition':
        this.executeCondition(record, taskId);
        break;
      case 'notify':
        this.executeNotify(record, taskId);
        break;
      case 'delay':
        this.executeDelay(record, taskId);
        break;
      case 'approval':
        this.executeApproval(record, taskId);
        break;
    }
  }

  private executeAgent(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'agent' || task.status !== 'todo') return;
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    this.touch(record.tree);
    this.persist(record.tree, record.bytes);
    const retryFeedback = task.retryCount > 0 && task.lastError ? task.lastError : undefined;
    this.emitEvent('execution:task:run-agent', {
      treeId: record.tree.id,
      taskId: task.id,
      agent: task.node.agent,
      prompt: task.node.prompt,
      parentTaskId: task.parentTaskId,
      projectId: record.tree.projectId,
      retryCount: task.retryCount,
      ...(retryFeedback !== undefined && { retryFeedback }),
    });
  }

  private executeCode(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'code') return;
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    this.touch(record.tree);
    this.persist(record.tree, record.bytes);
    const key = `${record.tree.id}:${task.id}`;
    const controller = new AbortController();
    this.codeControllers.set(key, controller);
    const generation = this.lifetime.generation;
    const work = runCodeProcess(task.node.script, task.node.args, { signal: controller.signal })
      .then(({ stdout }) => this.finishCodeTask({ record, task, stdout, generation, controller }))
      .catch((error: unknown) => this.failCodeTask({ record, task, error, generation, controller }))
      .finally(() => {
        if (this.codeControllers.get(key) === controller) this.codeControllers.delete(key);
      });
    this.track(work);
  }

  private async finishCodeTask(options: {
    record: TaskTreeRecord;
    task: ExecutionTask;
    stdout: string;
    generation: number;
    controller: AbortController;
  }): Promise<void> {
    const { record, task, stdout, generation, controller } = options;
    if (
      !this.isCurrentWork({
        generation,
        treeId: record.tree.id,
        taskId: task.id,
        status: 'in_progress',
        controller,
        taskSnapshot: stableJson(task),
      })
    )
      return;
    await runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      if (
        !this.isCurrentWork({
          generation,
          treeId: record.tree.id,
          taskId: task.id,
          status: 'in_progress',
          controller,
          taskSnapshot: stableJson(task),
        })
      )
        return;
      const current = this.loadRecord(record.tree.id);
      const currentTask = current?.tree.tasks.get(task.id);
      if (!current || !currentTask || currentTask.status !== 'in_progress') return;
      currentTask.summary = stdout.trim();
      currentTask.artifacts = [{ type: 'data', label: 'stdout', data: { output: stdout.trim() } }];
      this.markTaskCompleted({
        tree: current.tree,
        task: currentTask,
        expectedBytes: current.bytes,
      });
    });
  }

  private failCodeTask(options: {
    record: TaskTreeRecord;
    task: ExecutionTask;
    error: unknown;
    generation: number;
    controller: AbortController;
  }): void {
    const { record, task, error, generation, controller } = options;
    if (
      !this.isCurrentWork({
        generation,
        treeId: record.tree.id,
        taskId: task.id,
        status: 'in_progress',
        controller,
        taskSnapshot: stableJson(task),
      })
    )
      return;
    void this.onTaskFailed(
      record.tree.id,
      task.id,
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
  }

  private executeCondition(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'condition') return;
    task.summary = `Condition evaluated to ${String(evaluateCondition(task.node.expression, record.tree.tasks))}`;
    task.artifacts = [
      {
        type: 'data',
        label: 'condition-result',
        data: { result: evaluateCondition(task.node.expression, record.tree.tasks) },
      },
    ];
    this.markTaskCompleted({ tree: record.tree, task, expectedBytes: record.bytes });
  }

  private executeNotify(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'notify') return;
    const node = task.node;
    task.summary = `Notification requested for ${task.node.channel}`;
    this.markTaskCompleted({
      tree: record.tree,
      task,
      expectedBytes: record.bytes,
      beforeEvents: () => {
        this.emitEvent('notification', {
          channel: node.channel,
          title: node.title,
          body: node.message,
          destination: record.tree.projectId
            ? { kind: 'project', projectId: record.tree.projectId }
            : { kind: 'global', topic: 'general' },
          urgencyTier: 'green',
          deliveryMode: 'tell-now',
        });
      },
    });
  }

  private executeDelay(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'delay') return;
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    this.touch(record.tree);
    this.persist(record.tree, record.bytes);
    const key = `${record.tree.id}:${task.id}`;
    const generation = this.lifetime.generation;
    const timer = setTimeout(() => {
      if (this.delayTimers.get(key) !== timer) return;
      this.delayTimers.delete(key);
      if (!this.isLifetimeCurrent(generation)) return;
      const completion = runAfterProjectMutations(this.recordDeps.projectsDir, () => {
        if (
          !this.isCurrentWork({
            generation,
            treeId: record.tree.id,
            taskId: task.id,
            status: 'in_progress',
            taskSnapshot: stableJson(task),
          })
        )
          return;
        const current = this.loadRecord(record.tree.id);
        const currentTask = current?.tree.tasks.get(task.id);
        if (!current || !currentTask || currentTask.status !== 'in_progress') return;
        currentTask.summary = `Delayed ${task.node.type === 'delay' ? task.node.duration : ''}`;
        this.markTaskCompleted({
          tree: current.tree,
          task: currentTask,
          expectedBytes: current.bytes,
        });
      });
      this.track(completion);
    }, parseDuration(task.node.duration));
    this.delayTimers.set(key, timer);
  }

  private executeApproval(record: TaskTreeRecord, taskId: string): void {
    const task = record.tree.tasks.get(taskId);
    if (!task || task.node.type !== 'approval') return;
    task.status = 'pending_approval';
    this.touch(record.tree);
    this.persist(record.tree, record.bytes);
    this.emitEvent('execution:task:approval-needed', {
      treeId: record.tree.id,
      taskId: task.id,
      message: task.node.message,
    });
  }

  private async runValidation(options: {
    treeId: string;
    taskId: string;
    attempt?: string;
    taskSnapshot: string;
  }): Promise<void> {
    const { treeId, taskId, attempt, taskSnapshot } = options;
    const record = this.loadRecord(treeId);
    const task = record?.tree.tasks.get(taskId);
    if (!record || !task || task.status !== 'validating' || this.lifetime.stopped) return;
    const controller = new AbortController();
    const key = `${treeId}:${taskId}`;
    this.validationControllers.set(key, controller);
    const generation = this.lifetime.generation;
    const guard = { generation, treeId, taskId, attempt, controller, taskSnapshot };
    try {
      const result = await this.performValidation({
        tree: record.tree,
        task,
        treeId,
        taskId,
        controller,
      });
      if (!this.validationStillCurrent(guard)) return;
      await this.applyValidationResult({
        treeId,
        taskId,
        result,
        generation,
        attempt,
        controller,
        taskSnapshot,
      });
    } catch (error) {
      if (!this.validationStillCurrent(guard)) return;
      await this.applyValidationFailure({
        treeId,
        taskId,
        error,
        generation,
        attempt,
        controller,
        taskSnapshot,
      });
    } finally {
      if (this.validationControllers.get(key) === controller)
        this.validationControllers.delete(key);
    }
  }

  private validationStillCurrent(options: {
    generation: number;
    treeId: string;
    taskId: string;
    attempt?: string;
    controller: AbortController;
    taskSnapshot: string;
  }): boolean {
    return this.isCurrentWork({ ...options, status: 'validating' });
  }

  private async performValidation(options: {
    tree: TaskTree;
    task: ExecutionTask;
    treeId: string;
    taskId: string;
    controller: AbortController;
  }): Promise<ValidationResult> {
    const { tree, task, treeId, taskId, controller } = options;
    if (!this.validationDeps) {
      return {
        passed: false,
        gate1Passed: false,
        gate2Reason: 'Validation dependencies unavailable',
      };
    }
    return validateTaskResult(task, task.node.type === 'agent' ? task.node.validation : undefined, {
      deps: this.validationDeps,
      signal: controller.signal,
      treeId,
      taskId,
      projectId: tree.projectId,
    });
  }

  private async applyValidationResult(options: {
    treeId: string;
    taskId: string;
    result: ValidationResult;
    generation: number;
    attempt?: string;
    controller: AbortController;
    taskSnapshot: string;
  }): Promise<void> {
    const { treeId, taskId, result, ...guard } = options;
    await runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      if (!this.validationStillCurrent({ treeId, taskId, ...guard })) return;
      const current = this.loadRecord(treeId);
      const task = current?.tree.tasks.get(taskId);
      if (!current || !task || task.status !== 'validating') return;
      task.validationResult = {
        gate1Passed: result.gate1Passed,
        gate2Passed: result.gate2Passed,
        gate2Reason: result.gate2Reason,
        gate3Passed: result.gate3Passed,
        gate3Score: result.gate3Score,
        gate3Feedback: result.gate3Feedback,
      };
      if (result.passed) {
        this.markTaskCompleted({ tree: current.tree, task, expectedBytes: current.bytes });
      } else {
        this.handleValidationFailure({
          record: current,
          task,
          result,
          expectedBytes: current.bytes,
        });
      }
    });
  }

  private async applyValidationFailure(options: {
    treeId: string;
    taskId: string;
    error: unknown;
    generation: number;
    attempt?: string;
    controller: AbortController;
    taskSnapshot: string;
  }): Promise<void> {
    const { treeId, taskId, error, ...guard } = options;
    await runAfterProjectMutations(this.recordDeps.projectsDir, () => {
      if (!this.validationStillCurrent({ treeId, taskId, ...guard })) return;
      const current = this.loadRecord(treeId);
      const task = current?.tree.tasks.get(taskId);
      if (!current || !task || task.status !== 'validating') return;
      this.handleValidationFailure({
        record: current,
        task,
        result: {
          passed: false,
          gate1Passed: false,
          gate2Reason: error instanceof Error ? error.message : String(error),
        },
        expectedBytes: current.bytes,
      });
    });
  }

  private handleValidationFailure(options: {
    record: TaskTreeRecord;
    task: ExecutionTask;
    result: ValidationResult;
    expectedBytes: string;
  }): void {
    const { record, task, result, expectedBytes } = options;
    const error = result.gate2Reason ?? result.gate3Feedback ?? 'Validation failed';
    if (this.retryValidation({ record, task, error, expectedBytes })) return;
    if (this.validationFailureMode(task) !== 'skip') {
      this.failTask({ tree: record.tree, task, error, expectedBytes });
      return;
    }
    task.lastError = error;
    task.status = 'skipped';
    const treeStatus = this.persistTransition(record.tree, expectedBytes);
    if (treeStatus)
      this.emitEvent('execution:tree:completed', { treeId: record.tree.id, status: treeStatus });
    this.processReadyTasks(record.tree);
  }

  private validationFailureMode(task: ExecutionTask): 'fail' | 'escalate' | 'skip' {
    if (task.node.type !== 'agent') return 'escalate';
    return task.node.validation?.onMaxRetriesFailed ?? 'escalate';
  }

  private retryValidation(options: {
    record: TaskTreeRecord;
    task: ExecutionTask;
    error: string;
    expectedBytes: string;
  }): boolean {
    const { record, task, error, expectedBytes } = options;
    const maxRetries = task.node.type === 'agent' ? (task.node.validation?.maxRetries ?? 2) : 2;
    if (task.retryCount >= maxRetries || this.lifetime.admissionStopped) return false;
    task.retryCount += 1;
    task.lastError = error;
    task.status = 'todo';
    task.agentTaskId = undefined;
    this.touch(record.tree);
    this.persist(record.tree, expectedBytes);
    this.scheduleRetry(record.tree.id, task.id, this.retryBackoff(task));
    return true;
  }

  private failTask(options: {
    tree: TaskTree;
    task: ExecutionTask;
    error: string;
    expectedBytes: string;
  }): void {
    const { tree, task, error, expectedBytes } = options;
    task.status = 'failed';
    task.lastError = error;
    this.skipDependentsForFailure(tree, task.id, error);
    if (this.validationFailureMode(task) === 'fail') this.cancelRemainingTasks(tree);
    const treeStatus = this.persistTransition(tree, expectedBytes);
    if (treeStatus) this.clearTreeWork(tree.id);
    this.emitEvent('execution:task:failed', { treeId: tree.id, taskId: task.id, error });
    if (treeStatus)
      this.emitEvent('execution:tree:completed', { treeId: tree.id, status: treeStatus });
  }

  private cancelRemainingTasks(tree: TaskTree): void {
    for (const task of tree.tasks.values()) {
      if (isTerminal(task.status)) continue;
      task.status = 'cancelled';
      task.interrupted = undefined;
      task.lastError = 'Execution stopped after a required task failed';
    }
    tree.interrupted = undefined;
  }

  private markTaskCompleted(options: {
    tree: TaskTree;
    task: ExecutionTask;
    expectedBytes: string;
    beforeEvents?: () => void;
  }): void {
    const { tree, task, expectedBytes, beforeEvents } = options;
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    this.touch(tree);
    const treeCompleted = this.terminalTreeStatus(tree);
    if (treeCompleted) tree.status = treeCompleted;
    this.persist(tree, expectedBytes);
    beforeEvents?.();
    this.emitEvent('execution:task:completed', {
      treeId: tree.id,
      taskId: task.id,
      summary: task.summary,
      artifacts: task.artifacts,
    });
    if (treeCompleted)
      this.emitEvent('execution:tree:completed', { treeId: tree.id, status: treeCompleted });
    if (!treeCompleted) this.processReadyTasks(tree);
  }

  private persistTransition(tree: TaskTree, expectedBytes: string): TaskTreeStatus | undefined {
    const status = this.terminalTreeStatus(tree);
    if (status) {
      tree.status = status;
      tree.interrupted = undefined;
    }
    this.touch(tree);
    this.persist(tree, expectedBytes);
    return status;
  }

  private terminalTreeStatus(tree: TaskTree): TaskTreeStatus | undefined {
    if (![...tree.tasks.values()].every((task) => isTerminal(task.status))) return undefined;
    if ([...tree.tasks.values()].some((task) => task.status === 'failed')) return 'failed';
    if ([...tree.tasks.values()].some((task) => task.status === 'cancelled')) return 'cancelled';
    return 'completed';
  }

  private skipDependentsForFailure(tree: TaskTree, taskId: string, error: string): void {
    for (const task of tree.tasks.values()) {
      if (isTerminal(task.status) || !task.node.blockedBy.includes(taskId)) continue;
      task.status = 'skipped';
      task.lastError = `Dependency failed: ${error}`;
      this.skipDependentsForFailure(tree, task.id, error);
    }
  }

  private cancelDependents(tree: TaskTree, taskId: string): void {
    for (const task of tree.tasks.values()) {
      if (isTerminal(task.status) || !task.node.blockedBy.includes(taskId)) continue;
      task.status = 'cancelled';
      task.interrupted = undefined;
      this.cancelDependents(tree, task.id);
    }
  }

  private clearTreeWork(treeId: string): void {
    for (const [key, timer] of this.delayTimers) {
      if (key.startsWith(`${treeId}:`)) {
        clearTimeout(timer);
        this.delayTimers.delete(key);
      }
    }
    for (const [key, controller] of this.codeControllers) {
      if (key.startsWith(`${treeId}:`)) controller.abort();
    }
    for (const [key, controller] of this.validationControllers) {
      if (key.startsWith(`${treeId}:`)) controller.abort();
    }
  }

  private isCurrentWork(options: {
    generation: number;
    treeId: string;
    taskId: string;
    status: ExecutionTaskStatus;
    attempt?: string;
    controller?: AbortController;
    taskSnapshot?: string;
  }): boolean {
    const { generation, treeId, taskId, status, attempt, controller, taskSnapshot } = options;
    if (!this.isLifetimeCurrent(generation) || !this.ownsController(treeId, taskId, controller))
      return false;
    const task = this.loadRecord(treeId)?.tree.tasks.get(taskId);
    return this.matchesWork({ task, status, attempt, taskSnapshot });
  }

  private isLifetimeCurrent(generation: number): boolean {
    return generation === this.lifetime.generation && !this.lifetime.stopped;
  }

  private ownsController(treeId: string, taskId: string, controller?: AbortController): boolean {
    if (!controller) return true;
    const owner =
      this.codeControllers.get(`${treeId}:${taskId}`) ??
      this.validationControllers.get(`${treeId}:${taskId}`);
    return owner === controller;
  }

  private matchesWork(options: {
    task: ExecutionTask | undefined;
    status: ExecutionTaskStatus;
    attempt?: string;
    taskSnapshot?: string;
  }): boolean {
    const { task, status, attempt, taskSnapshot } = options;
    return (
      !!task &&
      task.status === status &&
      (attempt === undefined || task.agentTaskId === attempt) &&
      (taskSnapshot === undefined || stableJson(task) === taskSnapshot)
    );
  }

  private track(work: Promise<unknown>): void {
    this.localWork.add(work);
    void work.finally(() => this.localWork.delete(work)).catch(() => undefined);
  }

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
