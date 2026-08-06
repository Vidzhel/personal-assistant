import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const MAX_PROGRESS = 100;

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TaskNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['agent', 'code', 'condition', 'notify', 'delay', 'approval']),
  title: z.string(),
  prompt: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  agent: z.string().optional(),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
  expression: z.string().optional(),
  channel: z.string().optional(),
  message: z.string().optional(),
  duration: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  runIf: z.string().optional(),
});

const ArtifactSchema = z.object({
  type: z.enum(['file', 'data', 'reference']),
  label: z.string(),
  filePath: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  referenceId: z.string().optional(),
});

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
  tasks: z.array(TaskNodeSchema),
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
        tasks: args.tasks as Parameters<typeof deps.executionEngine.createTree>[0]['tasks'],
      });
      if (args.autoApprove) await deps.executionEngine.startTree(treeId);
      return ok({ treeId: tree.id, status: tree.status });
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
    async () => {
      if (!scope.treeId || !scope.taskId) return err('scope missing treeId or taskId');
      if (!deps.executionEngine) return err('executionEngine not available');
      const tree = deps.executionEngine.getTree(scope.treeId);
      if (!tree) return err(`Tree not found: ${scope.treeId}`);
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
      });
    },
  );
}

const CompleteTaskSchema = {
  summary: z.string(),
  artifacts: z.array(ArtifactSchema).optional(),
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
      if (!scope.taskId) return err('scope missing taskId');
      if (!scope.treeId) return err('scope missing treeId');
      if (!deps.executionEngine) return err('executionEngine not available');
      await deps.executionEngine.onTaskCompleted({
        treeId: scope.treeId,
        taskId: scope.taskId,
        summary: args.summary,
        artifacts: (args.artifacts ?? []) as Parameters<
          typeof deps.executionEngine.onTaskCompleted
        >[0]['artifacts'],
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
      if (!scope.taskId) return err('scope missing taskId');
      if (!scope.treeId) return err('scope missing treeId');
      if (!deps.executionEngine) return err('executionEngine not available');
      deps.executionEngine.onTaskBlocked(scope.treeId, scope.taskId, args.error);
      return ok({ ack: true, willRetry: args.retryable });
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
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:progress',
        payload: { taskId: scope.taskId, treeId: scope.treeId, ...args },
      });
      return ok({ ack: true });
    },
  );
}

const SaveArtifactSchema = { name: z.string(), content: z.string(), type: z.string() };

function buildSaveArtifact(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof SaveArtifactSchema> {
  return tool(
    'save_artifact',
    'Save an artifact produced during task execution.',
    SaveArtifactSchema,
    async (args) => {
      const artifactId = generateId();
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:progress',
        payload: { artifactId, taskId: scope.taskId, treeId: scope.treeId, artifact: args },
      });
      return ok({ artifactId });
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
    buildSaveArtifact(deps, scope),
  ];
}
