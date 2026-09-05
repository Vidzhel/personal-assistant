import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId, TaskTreeNodeSchema, TaskArtifactSchema } from '@raven/shared';
import type { ExecutionTask, TaskTree } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';
import type { TaskExecutionEngine } from '../../task-execution/task-execution-engine.ts';

const MAX_PROGRESS = 100;

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const ClassifyRequestSchema = {
  mode: z.enum(['direct', 'delegated', 'planned']),
  reason: z.string(),
};

function buildClassifyRequest(): SdkMcpToolDefinition<typeof ClassifyRequestSchema> {
  return tool(
    'classify_request',
    'Classify a user request as direct, delegated, or planned execution mode.',
    ClassifyRequestSchema,
    async (args) => ok({ ack: true, mode: args.mode, reason: args.reason }),
  );
}

const CreateTaskTreeSchema = {
  plan: z.string(),
  tasks: z.array(TaskTreeNodeSchema),
  autoApprove: z.boolean(),
};

function buildCreateTaskTree(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof CreateTaskTreeSchema> {
  return tool(
    'create_task_tree',
    'Create a task tree from a plan with optional auto-approval to start execution immediately.',
    CreateTaskTreeSchema,
    async (args) => {
      if (!deps.executionEngine) return err('executionEngine not available');
      const treeId = generateId();
      const tree = deps.executionEngine.createTree({
        id: treeId,
        projectId: scope.projectId,
        plan: args.plan,
        tasks: args.tasks,
      });
      if (args.autoApprove) await deps.executionEngine.startTree(treeId);
      return ok({
        treeId: tree.id,
        status: deps.executionEngine.getTree(treeId)?.status ?? tree.status,
      });
    },
  );
}

const GetTaskContextSchema = {
  include: z.array(z.enum(['parent', 'dependencies', 'siblings'])).optional(),
};

function buildGetTaskContext(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof GetTaskContextSchema> {
  return tool(
    'get_task_context',
    'Get current task details including optional parent, dependencies, and sibling context.',
    GetTaskContextSchema,
    async (args) => {
      if (!scope.treeId || !scope.taskId) return err('scope missing treeId or taskId');
      if (!deps.executionEngine) return err('executionEngine not available');
      const tree = deps.executionEngine.getTree(scope.treeId);
      if (!tree || tree.projectId !== scope.projectId)
        return err(`Tree not found in this project: ${scope.treeId}`);
      const task = tree.tasks.get(scope.taskId);
      if (!task) return err(`Task not found: ${scope.taskId}`);
      return ok({
        taskId: task.id,
        title: task.node.title,
        status: task.status,
        prompt: task.node.type === 'agent' ? task.node.prompt : undefined,
        summary: task.summary,
        artifacts: task.artifacts,
        plan: tree.plan,
        ...relatedContext(tree, task, args.include ?? []),
      });
    },
  );
}

function relatedContext(
  tree: TaskTree,
  task: ExecutionTask,
  include: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (include.includes('parent'))
    result.parent = { id: tree.id, plan: tree.plan, status: tree.status };
  if (include.includes('dependencies'))
    result.dependencies = task.node.blockedBy.map((id) => tree.tasks.get(id));
  if (include.includes('siblings'))
    result.siblings = [...tree.tasks.values()].filter((sibling) => sibling.id !== task.id);
  return result;
}

interface CurrentAttempt {
  engine: TaskExecutionEngine;
  treeId: string;
  taskId: string;
  agentTaskId: string;
  task: ExecutionTask;
}

function isActiveAttempt(tree: TaskTree, task: ExecutionTask, agentTaskId: string): boolean {
  return (
    tree.status === 'running' && task.status === 'in_progress' && task.agentTaskId === agentTaskId
  );
}

function currentAttempt(deps: RavenMcpDeps, scope: ScopeContext): CurrentAttempt | string {
  if (!scope.taskId) return 'scope missing taskId';
  if (!scope.treeId) return 'scope missing treeId';
  if (!scope.agentTaskId) return 'scope missing agentTaskId';
  const engine = deps.executionEngine;
  if (!engine) return 'executionEngine not available';
  const tree = engine.getTree(scope.treeId);
  if (!tree || tree.projectId !== scope.projectId) return 'Tree not found in this project';
  const task = tree.tasks.get(scope.taskId);
  if (!task) return 'Task not found';
  if (!isActiveAttempt(tree, task, scope.agentTaskId))
    return 'This execution attempt is no longer active';
  return {
    engine,
    treeId: scope.treeId,
    taskId: scope.taskId,
    agentTaskId: scope.agentTaskId,
    task,
  };
}

const CompleteTaskSchema = {
  summary: z.string(),
  artifacts: z.array(TaskArtifactSchema).optional(),
};

function buildCompleteTask(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof CompleteTaskSchema> {
  return tool(
    'complete_task',
    'Mark the current task as completed with a summary and optional artifacts.',
    CompleteTaskSchema,
    async (args) => {
      const attempt = currentAttempt(deps, scope);
      if (typeof attempt === 'string') return err(attempt);
      await attempt.engine.onTaskCompleted({
        treeId: attempt.treeId,
        taskId: attempt.taskId,
        agentTaskId: scope.agentTaskId,
        summary: args.summary,
        artifacts: args.artifacts ?? [],
      });
      return ok({ ack: true });
    },
  );
}

const FailTaskSchema = { error: z.string(), retryable: z.boolean() };

function buildFailTask(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof FailTaskSchema> {
  return tool(
    'fail_task',
    'Mark the current task as failed/blocked with an error message.',
    FailTaskSchema,
    async (args) => {
      const attempt = currentAttempt(deps, scope);
      if (typeof attempt === 'string') return err(attempt);
      const { engine, treeId, taskId } = attempt;
      const failure = { reason: args.error, agentTaskId: scope.agentTaskId };
      if (args.retryable) await engine.onTaskFailed(treeId, taskId, failure);
      else await engine.onTaskBlocked(treeId, taskId, failure);
      const updated = engine.getTree(treeId)?.tasks.get(taskId);
      const willRetry =
        !!updated &&
        updated.retryCount > attempt.task.retryCount &&
        (updated.status === 'todo' || updated.status === 'in_progress');
      return ok({ ack: true, status: updated?.status, willRetry });
    },
  );
}

const UpdateTaskProgressSchema = {
  progress: z.number().min(0).max(MAX_PROGRESS),
  statusText: z.string(),
};

function buildUpdateTaskProgress(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof UpdateTaskProgressSchema> {
  return tool(
    'update_task_progress',
    'Emit a progress update for the current task (0-100).',
    UpdateTaskProgressSchema,
    async (args) => {
      const attempt = currentAttempt(deps, scope);
      if (typeof attempt === 'string') return err(attempt);
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:progress',
        payload: {
          taskId: scope.taskId,
          treeId: scope.treeId,
          agentTaskId: scope.agentTaskId,
          ...args,
        },
      });
      return ok({ ack: true });
    },
  );
}

// Heterogeneous collection: each builder above keeps its own concrete,
// zod-inferred schema type (no `any`); only this array — which must hold
// tools with different schemas side by side, and whose elements are called
// with per-tool concrete args in the test suite via `.find()` — needs the
// erasure, matching the SDK's own `Array<SdkMcpToolDefinition<any>>` field
// on `createSdkMcpServer`. `AnyZodRawShape` was tried and rejected: it
// makes `InferShape` resolve to `{[x: string]: never}`, which breaks every
// concrete-args `.handler()` call in the existing tool test suites.
export function buildTaskLifecycleTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure at heterogeneous tool collection (see comment above)
): Array<SdkMcpToolDefinition<any>> {
  return [
    buildClassifyRequest(),
    buildCreateTaskTree(deps, scope),
    buildGetTaskContext(deps, scope),
    buildCompleteTask(deps, scope),
    buildFailTask(deps, scope),
    buildUpdateTaskProgress(deps, scope),
  ];
}
