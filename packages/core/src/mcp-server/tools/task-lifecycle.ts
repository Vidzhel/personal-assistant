import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

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

export function buildTaskLifecycleTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const classifyRequest = tool(
    'classify_request',
    'Classify a user request as direct, delegated, or planned execution mode.',
    {
      mode: z.enum(['direct', 'delegated', 'planned']),
      reason: z.string(),
    },
    async (args) => ok({ ack: true, mode: args.mode, reason: args.reason }),
  );

  const createTaskTree = tool(
    'create_task_tree',
    'Create a task tree from a plan with optional auto-approval to start execution immediately.',
    {
      plan: z.string(),
      tasks: z.array(TaskNodeSchema),
      autoApprove: z.boolean(),
    },
    async (args) => {
      if (!deps.executionEngine) {
        return err('executionEngine not available');
      }
      const treeId = generateId();
      const tree = deps.executionEngine.createTree({
        id: treeId,
        projectId: scope.projectId,
        plan: args.plan,
        tasks: args.tasks as Parameters<typeof deps.executionEngine.createTree>[0]['tasks'],
      });
      if (args.autoApprove) {
        await deps.executionEngine.startTree(treeId);
      }
      return ok({ treeId: tree.id, status: tree.status });
    },
  );

  const getTaskContext = tool(
    'get_task_context',
    'Get current task details including optional parent, dependencies, and sibling context.',
    {
      include: z.array(z.enum(['parent', 'dependencies', 'siblings'])).optional(),
    },
    async () => {
      if (!scope.treeId || !scope.taskId) {
        return err('scope missing treeId or taskId');
      }
      if (!deps.executionEngine) {
        return err('executionEngine not available');
      }
      const tree = deps.executionEngine.getTree(scope.treeId);
      if (!tree) {
        return err(`Tree not found: ${scope.treeId}`);
      }
      const task = tree.tasks.get(scope.taskId);
      if (!task) {
        return err(`Task not found: ${scope.taskId}`);
      }
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

  const completeTask = tool(
    'complete_task',
    'Mark the current task as completed with a summary and optional artifacts.',
    {
      summary: z.string(),
      artifacts: z.array(ArtifactSchema).optional(),
    },
    async (args) => {
      if (!scope.taskId) {
        return err('scope missing taskId');
      }
      if (!scope.treeId) {
        return err('scope missing treeId');
      }
      if (!deps.executionEngine) {
        return err('executionEngine not available');
      }
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

  const failTask = tool(
    'fail_task',
    'Mark the current task as failed/blocked with an error message.',
    {
      error: z.string(),
      retryable: z.boolean(),
    },
    async (args) => {
      if (!scope.taskId) {
        return err('scope missing taskId');
      }
      if (!scope.treeId) {
        return err('scope missing treeId');
      }
      if (!deps.executionEngine) {
        return err('executionEngine not available');
      }
      deps.executionEngine.onTaskBlocked(scope.treeId, scope.taskId, args.error);
      return ok({ ack: true, willRetry: args.retryable });
    },
  );

  const updateTaskProgress = tool(
    'update_task_progress',
    'Emit a progress update for the current task (0-100).',
    {
      progress: z.number().min(0).max(100),
      statusText: z.string(),
    },
    async (args) => {
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:progress',
        payload: {
          taskId: scope.taskId,
          treeId: scope.treeId,
          progress: args.progress,
          statusText: args.statusText,
        },
      });
      return ok({ ack: true });
    },
  );

  const saveArtifact = tool(
    'save_artifact',
    'Save an artifact produced during task execution.',
    {
      name: z.string(),
      content: z.string(),
      type: z.string(),
    },
    async (args) => {
      const artifactId = generateId();
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:artifact-saved',
        payload: {
          artifactId,
          taskId: scope.taskId,
          treeId: scope.treeId,
          name: args.name,
          content: args.content,
          type: args.type,
        },
      });
      return ok({ artifactId });
    },
  );

  return [
    classifyRequest,
    createTaskTree,
    getTaskContext,
    completeTask,
    failTask,
    updateTaskProgress,
    saveArtifact,
  ];
}
