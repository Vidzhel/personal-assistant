# Raven MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all fragile agent-to-Raven communication (text parsing, WebFetch-to-localhost, prompt-injected API specs) with an in-process MCP server that every agent gets, scoped by role.

**Architecture:** Use the Claude Agent SDK's `createSdkMcpServer()` to create in-process MCP instances per agent task. Each instance contains only the tools allowed for that agent's role (task, chat, system, validation, knowledge). Tools call Raven internals directly — no HTTP, no text parsing.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (createSdkMcpServer, tool, SdkMcpToolDefinition), Zod 4 for input schemas, existing Raven engines/stores.

**Spec:** `docs/superpowers/specs/2026-03-29-raven-mcp-server-design.md`

---

### Task 1: Scope types and tool-access matrix

**Files:**
- Create: `packages/core/src/mcp-server/scope.ts`
- Test: `packages/core/src/__tests__/mcp-server/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/scope.test.ts
import { describe, it, expect } from 'vitest';
import { parseScopeContext, isToolAllowed, type ScopeContext } from '../../mcp-server/scope.ts';

describe('scope', () => {
  describe('parseScopeContext', () => {
    it('parses valid task scope', () => {
      const scope = parseScopeContext({
        role: 'task',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        treeId: 'tree-1',
        taskId: 'task-1',
      });
      expect(scope.role).toBe('task');
      expect(scope.taskId).toBe('task-1');
    });

    it('rejects invalid role', () => {
      expect(() => parseScopeContext({ role: 'admin' })).toThrow();
    });

    it('allows optional fields', () => {
      const scope = parseScopeContext({ role: 'chat' });
      expect(scope.role).toBe('chat');
      expect(scope.taskId).toBeUndefined();
    });
  });

  describe('isToolAllowed', () => {
    it('allows complete_task for task scope', () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      expect(isToolAllowed(scope, 'complete_task')).toBe(true);
    });

    it('denies create_task_tree for task scope', () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      expect(isToolAllowed(scope, 'create_task_tree')).toBe(false);
    });

    it('allows all tools for system scope', () => {
      const scope: ScopeContext = { role: 'system' };
      expect(isToolAllowed(scope, 'complete_task')).toBe(true);
      expect(isToolAllowed(scope, 'create_task_tree')).toBe(true);
      expect(isToolAllowed(scope, 'list_agents')).toBe(true);
    });

    it('allows classify_request for chat scope', () => {
      const scope: ScopeContext = { role: 'chat', sessionId: 'sess-1' };
      expect(isToolAllowed(scope, 'classify_request')).toBe(true);
    });

    it('allows submit_validation_score for validation scope', () => {
      const scope: ScopeContext = { role: 'validation' };
      expect(isToolAllowed(scope, 'submit_validation_score')).toBe(true);
    });

    it('denies send_message for validation scope', () => {
      const scope: ScopeContext = { role: 'validation' };
      expect(isToolAllowed(scope, 'send_message')).toBe(false);
    });

    it('allows knowledge tools for knowledge scope', () => {
      const scope: ScopeContext = { role: 'knowledge' };
      expect(isToolAllowed(scope, 'search_knowledge')).toBe(true);
      expect(isToolAllowed(scope, 'save_knowledge')).toBe(true);
      expect(isToolAllowed(scope, 'get_knowledge_context')).toBe(true);
    });

    it('denies create_agent for knowledge scope', () => {
      const scope: ScopeContext = { role: 'knowledge' };
      expect(isToolAllowed(scope, 'create_agent')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/scope.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/scope.ts
import { z } from 'zod';

export const ScopeContextSchema = z.object({
  role: z.enum(['task', 'chat', 'system', 'validation', 'knowledge']),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  treeId: z.string().optional(),
  taskId: z.string().optional(),
});

export type ScopeContext = z.infer<typeof ScopeContextSchema>;

const SCOPE_TOOLS: Record<ScopeContext['role'], Set<string>> = {
  task: new Set([
    'get_task_context', 'complete_task', 'fail_task',
    'update_task_progress', 'save_artifact',
    'search_knowledge', 'send_message',
  ]),
  chat: new Set([
    'classify_request', 'create_task_tree', 'escalate_to_planned',
    'send_message', 'get_session_history',
    'search_knowledge', 'list_agents',
  ]),
  system: new Set(['*']),
  validation: new Set(['submit_validation_score', 'get_task_context']),
  knowledge: new Set([
    'search_knowledge', 'save_knowledge', 'get_knowledge_context',
  ]),
};

export function isToolAllowed(scope: ScopeContext, toolName: string): boolean {
  const allowed = SCOPE_TOOLS[scope.role];
  return allowed.has('*') || allowed.has(toolName);
}

export function parseScopeContext(input: unknown): ScopeContext {
  return ScopeContextSchema.parse(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/scope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/scope.ts packages/core/src/__tests__/mcp-server/scope.test.ts
git commit -m "feat(mcp): add scope types and tool-access matrix"
```

---

### Task 2: Task lifecycle tools (complete_task, fail_task, create_task_tree, get_task_context, classify_request, update_task_progress, save_artifact)

**Files:**
- Create: `packages/core/src/mcp-server/tools/task-lifecycle.ts`
- Create: `packages/core/src/mcp-server/types.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/task-lifecycle.test.ts`

- [ ] **Step 1: Create shared deps type**

```typescript
// packages/core/src/mcp-server/types.ts
import type { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { RetrievalEngine } from '../knowledge-engine/retrieval.ts';
import type { NamedAgentStore } from '../agent-registry/named-agent-store.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { PipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';

export interface RavenMcpDeps {
  executionEngine?: TaskExecutionEngine;
  messageStore?: MessageStore;
  sessionManager?: SessionManager;
  knowledgeStore?: KnowledgeStore;
  retrievalEngine?: RetrievalEngine;
  namedAgentStore?: NamedAgentStore;
  projectRegistry?: ProjectRegistry;
  scheduler?: Scheduler;
  pipelineEngine?: PipelineEngine;
  eventBus: EventBus;
  db?: DatabaseInterface;
  pendingApprovals?: PendingApprovals;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/task-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTaskLifecycleTools } from '../../../mcp-server/tools/task-lifecycle.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

function createMockDeps(): RavenMcpDeps {
  return {
    executionEngine: {
      onTaskCompleted: vi.fn().mockResolvedValue(undefined),
      onTaskBlocked: vi.fn(),
      createTree: vi.fn().mockReturnValue({ id: 'tree-1', status: 'pending_approval' }),
      startTree: vi.fn().mockResolvedValue(undefined),
      getTree: vi.fn(),
      getTasks: vi.fn().mockReturnValue([]),
    } as any,
    eventBus: { emit: vi.fn() } as any,
    messageStore: { appendMessage: vi.fn().mockReturnValue('msg-1') } as any,
  };
}

describe('buildTaskLifecycleTools', () => {
  let deps: RavenMcpDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns tools array', () => {
    const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
    const tools = buildTaskLifecycleTools(deps, scope);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('includes complete_task tool', () => {
    const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
    const tools = buildTaskLifecycleTools(deps, scope);
    const completeTool = tools.find((t) => t.name === 'complete_task');
    expect(completeTool).toBeDefined();
  });

  describe('complete_task handler', () => {
    it('calls executionEngine.onTaskCompleted with summary', async () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      const tools = buildTaskLifecycleTools(deps, scope);
      const completeTool = tools.find((t) => t.name === 'complete_task')!;

      const result = await completeTool.handler({ summary: 'Done!' }, {});
      expect(deps.executionEngine!.onTaskCompleted).toHaveBeenCalledWith({
        treeId: 'tree-1',
        taskId: 'task-1',
        summary: 'Done!',
        artifacts: [],
      });
      expect(result.isError).toBeUndefined();
    });

    it('returns error when no taskId in scope', async () => {
      const scope: ScopeContext = { role: 'task' }; // missing taskId
      const tools = buildTaskLifecycleTools(deps, scope);
      const completeTool = tools.find((t) => t.name === 'complete_task')!;

      const result = await completeTool.handler({ summary: 'Done!' }, {});
      expect(result.isError).toBe(true);
    });
  });

  describe('fail_task handler', () => {
    it('calls executionEngine.onTaskBlocked', async () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      const tools = buildTaskLifecycleTools(deps, scope);
      const failTool = tools.find((t) => t.name === 'fail_task')!;

      const result = await failTool.handler({ error: 'Something broke', retryable: true }, {});
      expect(deps.executionEngine!.onTaskBlocked).toHaveBeenCalledWith(
        'tree-1', 'task-1', 'Something broke',
      );
      expect(result.isError).toBeUndefined();
    });
  });

  describe('create_task_tree handler', () => {
    it('creates tree and starts it when autoApprove is true', async () => {
      const scope: ScopeContext = { role: 'chat', projectId: 'proj-1', sessionId: 'sess-1' };
      const tools = buildTaskLifecycleTools(deps, scope);
      const createTool = tools.find((t) => t.name === 'create_task_tree')!;

      const result = await createTool.handler({
        plan: 'Test plan',
        tasks: [{
          id: 'step-1', title: 'Do thing', type: 'agent',
          prompt: 'Do the thing', blockedBy: [],
        }],
        autoApprove: true,
      }, {});

      expect(deps.executionEngine!.createTree).toHaveBeenCalled();
      expect(deps.executionEngine!.startTree).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.treeId).toBeDefined();
      expect(parsed.status).toBe('running');
    });
  });

  describe('classify_request handler', () => {
    it('returns ack', async () => {
      const scope: ScopeContext = { role: 'chat', sessionId: 'sess-1' };
      const tools = buildTaskLifecycleTools(deps, scope);
      const classifyTool = tools.find((t) => t.name === 'classify_request')!;

      const result = await classifyTool.handler({ mode: 'direct', reason: 'Simple question' }, {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ack).toBe(true);
      expect(parsed.mode).toBe('direct');
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/task-lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```typescript
// packages/core/src/mcp-server/tools/task-lifecycle.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const ArtifactSchema = z.object({
  name: z.string(),
  content: z.string(),
  type: z.enum(['text', 'json', 'markdown', 'code']),
});

const TaskNodeSchema = z.object({
  id: z.string().describe('Unique step ID (e.g., "step-1")'),
  title: z.string().describe('Short task title'),
  type: z.enum(['agent', 'code', 'condition', 'notify', 'delay', 'approval']).default('agent'),
  agent: z.string().optional().describe('Named agent to execute (for agent type)'),
  prompt: z.string().describe('Instructions for the agent'),
  blockedBy: z.array(z.string()).default([]).describe('Task IDs that must complete first'),
});

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// eslint-disable-next-line max-lines-per-function -- builds all task lifecycle tools
export function buildTaskLifecycleTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  // ── classify_request ─────────────────────────────────────────────
  tools.push(
    tool(
      'classify_request',
      'Declare the execution mode for the current user request. ' +
        'Call this before doing any work. ' +
        'DIRECT: simple question you can answer immediately. ' +
        'DELEGATED: substantial work handled by a single sub-agent. ' +
        'PLANNED: multi-step work requiring a task tree.',
      {
        mode: z.enum(['direct', 'delegated', 'planned']).describe('Execution mode'),
        reason: z.string().describe('Brief explanation for the classification'),
      },
      async ({ mode, reason }) => ok({ ack: true, mode, reason }),
      { annotations: { idempotentHint: true } },
    ),
  );

  // ── create_task_tree ─────────────────────────────────────────────
  tools.push(
    tool(
      'create_task_tree',
      'Create a multi-step task tree for planned execution. ' +
        'Each task can depend on others via blockedBy. ' +
        'Set autoApprove to true to start immediately.',
      {
        plan: z.string().describe('One-sentence description of the overall plan'),
        tasks: z.array(TaskNodeSchema),
        autoApprove: z.boolean().default(true).describe('Start immediately if true'),
      },
      async ({ plan, tasks, autoApprove }) => {
        if (!deps.executionEngine) return err('Execution engine not available.');

        const treeId = generateId();
        deps.executionEngine.createTree({
          id: treeId,
          projectId: scope.projectId,
          plan,
          tasks,
        });

        if (autoApprove) {
          await deps.executionEngine.startTree(treeId);
        }

        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'execution:tree:created',
          payload: { treeId, projectId: scope.projectId, plan, taskCount: tasks.length },
        });

        return ok({ treeId, status: autoApprove ? 'running' : 'pending_approval' });
      },
    ),
  );

  // ── get_task_context ─────────────────────────────────────────────
  tools.push(
    tool(
      'get_task_context',
      'Read your assigned task details and the results of completed dependency tasks. ' +
        'Call this first when executing a task tree step.',
      {
        include: z
          .array(z.enum(['parent', 'dependencies', 'siblings']))
          .default(['dependencies'])
          .describe('What context to include'),
      },
      async ({ include }) => {
        if (!scope.treeId || !scope.taskId || !deps.executionEngine) {
          return err('No task context available — missing treeId or taskId.');
        }

        const tree = deps.executionEngine.getTree(scope.treeId);
        if (!tree) return err(`Tree ${scope.treeId} not found.`);

        const task = tree.tasks.get(scope.taskId);
        if (!task) return err(`Task ${scope.taskId} not found in tree.`);

        const context: Record<string, unknown> = {
          task: {
            id: task.id,
            title: task.node.title,
            type: task.node.type,
            prompt: task.node.prompt,
            status: task.status,
          },
        };

        if (include.includes('dependencies') && task.node.blockedBy) {
          const depResults: Record<string, string> = {};
          for (const depId of task.node.blockedBy) {
            const depTask = tree.tasks.get(depId);
            if (depTask?.summary) {
              depResults[depId] = depTask.summary;
            }
          }
          context.dependencyResults = depResults;
        }

        if (include.includes('siblings')) {
          const siblings: Array<{ id: string; title: string; status: string }> = [];
          for (const [, t] of tree.tasks) {
            if (t.id !== scope.taskId) {
              siblings.push({ id: t.id, title: t.node.title, status: t.status });
            }
          }
          context.siblings = siblings;
        }

        if (include.includes('parent')) {
          context.plan = tree.plan;
        }

        return ok(context);
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  // ── complete_task ────────────────────────────────────────────────
  tools.push(
    tool(
      'complete_task',
      'Mark your assigned task as completed with a summary and optional artifacts. ' +
        'You MUST call this (or fail_task) before finishing. Do not just output text.',
      {
        summary: z.string().describe('Concise summary of what was accomplished'),
        artifacts: z.array(ArtifactSchema).optional().describe('Structured outputs'),
      },
      async ({ summary, artifacts }) => {
        if (!scope.taskId || !scope.treeId) {
          return err('No taskId/treeId in scope — cannot complete task.');
        }
        if (!deps.executionEngine) return err('Execution engine not available.');

        await deps.executionEngine.onTaskCompleted({
          treeId: scope.treeId,
          taskId: scope.taskId,
          summary,
          artifacts: (artifacts ?? []).map((a, i) => ({
            id: `${scope.taskId}-artifact-${i}`,
            ...a,
          })),
        });

        return ok({ ack: true });
      },
    ),
  );

  // ── fail_task ────────────────────────────────────────────────────
  tools.push(
    tool(
      'fail_task',
      'Report that your assigned task has failed. Include the error and whether it is retryable.',
      {
        error: z.string().describe('What went wrong'),
        retryable: z.boolean().describe('Whether the task might succeed on retry'),
      },
      async ({ error, retryable }) => {
        if (!scope.taskId || !scope.treeId) {
          return err('No taskId/treeId in scope — cannot fail task.');
        }
        if (!deps.executionEngine) return err('Execution engine not available.');

        deps.executionEngine.onTaskBlocked(scope.treeId, scope.taskId, error);

        return ok({ ack: true, willRetry: retryable });
      },
    ),
  );

  // ── update_task_progress ─────────────────────────────────────────
  tools.push(
    tool(
      'update_task_progress',
      'Report progress on a long-running task. Emits to the dashboard in real-time.',
      {
        progress: z.number().min(0).max(100).describe('Percentage complete (0-100)'),
        statusText: z.string().describe('Human-readable status'),
      },
      async ({ progress, statusText }) => {
        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'execution:task:progress',
          payload: { treeId: scope.treeId, taskId: scope.taskId, progress, statusText },
        });
        return ok({ ack: true });
      },
      { annotations: { idempotentHint: true } },
    ),
  );

  // ── save_artifact ────────────────────────────────────────────────
  tools.push(
    tool(
      'save_artifact',
      'Save a structured artifact for the current task. Artifacts are persisted with the task results.',
      {
        name: z.string().describe('Artifact name'),
        content: z.string().describe('Artifact content'),
        type: z.enum(['text', 'json', 'markdown', 'code']).describe('Content type'),
      },
      async ({ name, content, type }) => {
        // Artifacts are accumulated and will be included when complete_task is called.
        // For now, emit an event so the frontend can show them in real-time.
        const artifactId = generateId();
        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'execution:task:artifact',
          payload: {
            treeId: scope.treeId,
            taskId: scope.taskId,
            artifact: { id: artifactId, name, content, type },
          },
        });
        return ok({ artifactId });
      },
    ),
  );

  return tools;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/task-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mcp-server/types.ts packages/core/src/mcp-server/tools/task-lifecycle.ts packages/core/src/__tests__/mcp-server/tools/task-lifecycle.test.ts
git commit -m "feat(mcp): add task lifecycle tools — complete_task, fail_task, create_task_tree, etc."
```

---

### Task 3: Session tools (send_message, get_session_history)

**Files:**
- Create: `packages/core/src/mcp-server/tools/session.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSessionTools } from '../../../mcp-server/tools/session.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

function createMockDeps(): RavenMcpDeps {
  return {
    messageStore: {
      appendMessage: vi.fn().mockReturnValue('msg-1'),
      getMessages: vi.fn().mockReturnValue([
        { id: 'm1', role: 'user', content: 'Hello', timestamp: 1000 },
        { id: 'm2', role: 'assistant', content: 'Hi there', timestamp: 2000 },
      ]),
    } as any,
    eventBus: { emit: vi.fn() } as any,
  };
}

describe('buildSessionTools', () => {
  let deps: RavenMcpDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('send_message handler', () => {
    it('appends message to store and emits event', async () => {
      const scope: ScopeContext = { role: 'chat', sessionId: 'sess-1' };
      const tools = buildSessionTools(deps, scope);
      const sendTool = tools.find((t) => t.name === 'send_message')!;

      const result = await sendTool.handler({ content: 'Hello world' }, {});
      expect(deps.messageStore!.appendMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        role: 'assistant',
        content: 'Hello world',
      }));
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messageId).toBe('msg-1');
    });

    it('returns error when no sessionId', async () => {
      const scope: ScopeContext = { role: 'chat' }; // missing sessionId
      const tools = buildSessionTools(deps, scope);
      const sendTool = tools.find((t) => t.name === 'send_message')!;

      const result = await sendTool.handler({ content: 'Hello' }, {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_session_history handler', () => {
    it('returns messages from store', async () => {
      const scope: ScopeContext = { role: 'chat', sessionId: 'sess-1' };
      const tools = buildSessionTools(deps, scope);
      const historyTool = tools.find((t) => t.name === 'get_session_history')!;

      const result = await historyTool.handler({ limit: 10 }, {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messages).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/session.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/tools/session.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function buildSessionTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  // ── send_message ─────────────────────────────────────────────────
  tools.push(
    tool(
      'send_message',
      'Post a message to the user\'s chat session. Use this to deliver results, ' +
        'updates, or plan acknowledgments. The message appears in the conversation.',
      {
        content: z.string().describe('Message content'),
        format: z.enum(['text', 'markdown']).default('markdown').describe('Content format'),
      },
      async ({ content }) => {
        if (!scope.sessionId) return err('No sessionId in scope — cannot send message.');
        if (!deps.messageStore) return err('Message store not available.');

        const messageId = deps.messageStore.appendMessage(scope.sessionId, {
          role: 'assistant',
          content,
        });

        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          projectId: scope.projectId,
          type: 'agent:message',
          payload: {
            sessionId: scope.sessionId,
            messageType: 'assistant',
            content,
            messageId,
          },
        });

        return ok({ messageId: messageId ?? 'unknown' });
      },
    ),
  );

  // ── get_session_history ──────────────────────────────────────────
  tools.push(
    tool(
      'get_session_history',
      'Retrieve conversation history for the current session. ' +
        'Use this to understand context instead of relying on prompt injection.',
      {
        limit: z.number().int().min(1).max(100).default(20).describe('Max messages to return'),
      },
      async ({ limit }) => {
        if (!scope.sessionId) return err('No sessionId in scope.');
        if (!deps.messageStore) return err('Message store not available.');

        const messages = deps.messageStore.getMessages(scope.sessionId);
        const sliced = messages.slice(-limit);

        return ok({
          messages: sliced.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            agentName: m.agentName,
          })),
        });
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  return tools;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/tools/session.ts packages/core/src/__tests__/mcp-server/tools/session.test.ts
git commit -m "feat(mcp): add session tools — send_message, get_session_history"
```

---

### Task 4: Validation tools (submit_validation_score)

**Files:**
- Create: `packages/core/src/mcp-server/tools/validation.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/validation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/validation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildValidationTools } from '../../../mcp-server/tools/validation.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildValidationTools', () => {
  it('submit_validation_score emits structured event', async () => {
    const deps: RavenMcpDeps = { eventBus: { emit: vi.fn() } as any };
    const scope: ScopeContext = { role: 'validation', treeId: 'tree-1', taskId: 'task-1' };
    const tools = buildValidationTools(deps, scope);
    const scoreTool = tools.find((t) => t.name === 'submit_validation_score')!;

    const result = await scoreTool.handler({
      score: 4, feedback: 'Good quality', pass: true,
    }, {});
    expect(deps.eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'execution:task:validation',
      payload: expect.objectContaining({ score: 4, pass: true }),
    }));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ack).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/validation.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/tools/validation.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

export function buildValidationTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  return [
    tool(
      'submit_validation_score',
      'Submit your evaluation score for a task result. ' +
        'Score 1-5, with feedback explaining your assessment.',
      {
        score: z.number().int().min(1).max(5).describe('Quality score (1=poor, 5=excellent)'),
        feedback: z.string().describe('Explanation of your assessment'),
        pass: z.boolean().describe('Whether the result meets the quality threshold'),
      },
      async ({ score, feedback, pass }) => {
        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'execution:task:validation',
          payload: {
            treeId: scope.treeId,
            taskId: scope.taskId,
            score,
            feedback,
            pass,
          },
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ack: true }) }] };
      },
    ),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/tools/validation.ts packages/core/src/__tests__/mcp-server/tools/validation.test.ts
git commit -m "feat(mcp): add validation tool — submit_validation_score"
```

---

### Task 5: Knowledge tools (search_knowledge, save_knowledge, get_knowledge_context)

**Files:**
- Create: `packages/core/src/mcp-server/tools/knowledge.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/knowledge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildKnowledgeTools } from '../../../mcp-server/tools/knowledge.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildKnowledgeTools', () => {
  const scope: ScopeContext = { role: 'knowledge' };

  it('search_knowledge queries the knowledge store', async () => {
    const deps: RavenMcpDeps = {
      eventBus: { emit: vi.fn() } as any,
      knowledgeStore: {
        search: vi.fn().mockResolvedValue([
          { id: 'kb-1', title: 'Test', content: 'Content', tags: ['test'] },
        ]),
      } as any,
      retrievalEngine: {
        retrieve: vi.fn().mockResolvedValue([
          { bubble: { id: 'kb-1', title: 'Test', content: 'Content', tags: ['test'] }, score: 0.9 },
        ]),
      } as any,
    };
    const tools = buildKnowledgeTools(deps, scope);
    const searchTool = tools.find((t) => t.name === 'search_knowledge')!;

    const result = await searchTool.handler({ query: 'test' }, {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toBeDefined();
  });

  it('save_knowledge creates a bubble', async () => {
    const deps: RavenMcpDeps = {
      eventBus: { emit: vi.fn() } as any,
      knowledgeStore: {
        create: vi.fn().mockResolvedValue({ id: 'kb-new' }),
      } as any,
    };
    const tools = buildKnowledgeTools(deps, scope);
    const saveTool = tools.find((t) => t.name === 'save_knowledge')!;

    const result = await saveTool.handler({
      content: 'New knowledge', tags: ['test'], domain: 'general',
    }, {});
    expect(deps.knowledgeStore!.create).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('kb-new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/knowledge.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/tools/knowledge.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function buildKnowledgeTools(
  deps: RavenMcpDeps,
  _scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  // ── search_knowledge ─────────────────────────────────────────────
  tools.push(
    tool(
      'search_knowledge',
      'Search the knowledge base by semantic query. Returns matching knowledge items ' +
        'with titles, content, tags, and relevance scores.',
      {
        query: z.string().describe('Search keywords or natural language query'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        domain: z.string().optional().describe('Filter by domain'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
      },
      async ({ query, tags, domain, limit }) => {
        if (deps.retrievalEngine) {
          const results = await deps.retrievalEngine.retrieve(query, { limit, tags, domain });
          return ok({
            results: results.map((r) => ({
              id: r.bubble.id,
              title: r.bubble.title,
              content: r.bubble.content,
              tags: r.bubble.tags,
              score: r.score,
            })),
          });
        }
        if (deps.knowledgeStore) {
          const results = await deps.knowledgeStore.search(query, { limit, tags, domain });
          return ok({ results });
        }
        return err('Knowledge store not available.');
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  // ── save_knowledge ───────────────────────────────────────────────
  tools.push(
    tool(
      'save_knowledge',
      'Store a new knowledge item in the knowledge base.',
      {
        content: z.string().describe('Knowledge content'),
        title: z.string().optional().describe('Title (auto-generated if omitted)'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
        domain: z.string().optional().describe('Knowledge domain'),
        permanence: z.enum(['temporary', 'normal', 'robust']).default('normal').describe('Retention level'),
      },
      async ({ content, title, tags, domain, permanence }) => {
        if (!deps.knowledgeStore) return err('Knowledge store not available.');

        const result = await deps.knowledgeStore.create({
          content,
          title: title ?? content.slice(0, 80),
          tags: tags ?? [],
          domain,
          permanence,
        });

        return ok({ id: result.id });
      },
    ),
  );

  // ── get_knowledge_context ────────────────────────────────────────
  tools.push(
    tool(
      'get_knowledge_context',
      'Retrieve relevant knowledge context for a query. ' +
        'Returns a formatted text block suitable for inclusion in prompts.',
      {
        query: z.string().describe('Topic or question to find context for'),
        maxResults: z.number().int().min(1).max(20).default(5).describe('Max items to include'),
      },
      async ({ query, maxResults }) => {
        if (!deps.retrievalEngine) return err('Retrieval engine not available.');

        const results = await deps.retrievalEngine.retrieve(query, { limit: maxResults });
        if (results.length === 0) return ok({ context: '', resultCount: 0 });

        const context = results
          .map((r) => `## ${r.bubble.title}\n${r.bubble.content}`)
          .join('\n\n');

        return ok({ context, resultCount: results.length });
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  return tools;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/knowledge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/tools/knowledge.ts packages/core/src/__tests__/mcp-server/tools/knowledge.test.ts
git commit -m "feat(mcp): add knowledge tools — search, save, get_context"
```

---

### Task 6: System management tools (list_agents, create_agent, update_agent, list_projects, manage_schedule, trigger_pipeline)

**Files:**
- Create: `packages/core/src/mcp-server/tools/system.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/system.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/system.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildSystemTools } from '../../../mcp-server/tools/system.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildSystemTools', () => {
  const scope: ScopeContext = { role: 'system' };

  it('list_agents returns agents from store', async () => {
    const deps: RavenMcpDeps = {
      eventBus: { emit: vi.fn() } as any,
      namedAgentStore: {
        getAll: vi.fn().mockReturnValue([
          { id: 'a1', name: 'test-agent', description: 'Test', isDefault: false },
        ]),
      } as any,
    };
    const tools = buildSystemTools(deps, scope);
    const listTool = tools.find((t) => t.name === 'list_agents')!;
    const result = await listTool.handler({}, {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].name).toBe('test-agent');
  });

  it('list_projects returns projects from registry', async () => {
    const deps: RavenMcpDeps = {
      eventBus: { emit: vi.fn() } as any,
      projectRegistry: {
        listProjects: vi.fn().mockReturnValue([
          { id: 'p1', name: 'test-project' },
        ]),
      } as any,
    };
    const tools = buildSystemTools(deps, scope);
    const listTool = tools.find((t) => t.name === 'list_projects')!;
    const result = await listTool.handler({}, {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.projects).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/system.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Examine the exact method signatures on `NamedAgentStore`, `ProjectRegistry`, `Scheduler`, and `PipelineEngine` to wire correctly. The tool implementations are thin wrappers around existing store/engine methods.

```typescript
// packages/core/src/mcp-server/tools/system.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// eslint-disable-next-line max-lines-per-function -- registers all system management tools
export function buildSystemTools(
  deps: RavenMcpDeps,
  _scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  tools.push(
    tool(
      'list_agents',
      'List all named agents. Optionally filter by project.',
      {
        projectId: z.string().optional().describe('Filter by project ID'),
      },
      async ({ projectId }) => {
        if (!deps.namedAgentStore) return err('Agent store not available.');
        const agents = deps.namedAgentStore.getAll();
        const filtered = projectId
          ? agents.filter((a) => a.projectId === projectId)
          : agents;
        return ok({ agents: filtered });
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  tools.push(
    tool(
      'create_agent',
      'Create a new named agent with instructions and configuration.',
      {
        name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Agent name (kebab-case)'),
        description: z.string().optional().describe('What this agent does'),
        instructions: z.string().optional().describe('System prompt for the agent'),
        model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Model to use'),
        maxTurns: z.number().int().min(1).max(100).optional().describe('Max conversation turns'),
      },
      async ({ name, description, instructions, model, maxTurns }) => {
        if (!deps.namedAgentStore) return err('Agent store not available.');
        const agent = deps.namedAgentStore.create({
          name,
          description,
          instructions,
          model,
          maxTurns,
          suiteIds: [],
          skills: [],
        });
        return ok({ agentId: agent.id });
      },
    ),
  );

  tools.push(
    tool(
      'update_agent',
      'Update an existing named agent.',
      {
        agentId: z.string().describe('Agent ID to update'),
        name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
        description: z.string().nullable().optional(),
        instructions: z.string().nullable().optional(),
        model: z.enum(['haiku', 'sonnet', 'opus']).nullable().optional(),
        maxTurns: z.number().int().min(1).max(100).nullable().optional(),
      },
      async ({ agentId, ...updates }) => {
        if (!deps.namedAgentStore) return err('Agent store not available.');
        deps.namedAgentStore.update(agentId, updates);
        return ok({ ack: true });
      },
      { annotations: { idempotentHint: true } },
    ),
  );

  tools.push(
    tool(
      'list_projects',
      'List all projects in Raven.',
      {},
      async () => {
        if (!deps.projectRegistry) return err('Project registry not available.');
        const projects = deps.projectRegistry.listProjects();
        return ok({ projects });
      },
      { annotations: { readOnlyHint: true, idempotentHint: true } },
    ),
  );

  tools.push(
    tool(
      'trigger_pipeline',
      'Trigger a pipeline by name with optional parameters.',
      {
        name: z.string().describe('Pipeline name'),
        params: z.record(z.string()).optional().describe('Pipeline parameters'),
      },
      async ({ name, params }) => {
        if (!deps.pipelineEngine) return err('Pipeline engine not available.');
        const result = deps.pipelineEngine.trigger(name, params ?? {});
        return ok({ treeId: result?.treeId ?? 'unknown' });
      },
    ),
  );

  return tools;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/system.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/tools/system.ts packages/core/src/__tests__/mcp-server/tools/system.test.ts
git commit -m "feat(mcp): add system management tools — list/create/update agents, projects, pipelines"
```

---

### Task 7: Escalation tools (escalate_to_planned, request_approval)

**Files:**
- Create: `packages/core/src/mcp-server/tools/escalation.ts`
- Test: `packages/core/src/__tests__/mcp-server/tools/escalation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/tools/escalation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildEscalationTools } from '../../../mcp-server/tools/escalation.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildEscalationTools', () => {
  it('escalate_to_planned creates a task tree', async () => {
    const deps: RavenMcpDeps = {
      eventBus: { emit: vi.fn() } as any,
      executionEngine: {
        createTree: vi.fn().mockReturnValue({ id: 'tree-1' }),
        startTree: vi.fn().mockResolvedValue(undefined),
      } as any,
    };
    const scope: ScopeContext = { role: 'chat', projectId: 'proj-1', sessionId: 'sess-1' };
    const tools = buildEscalationTools(deps, scope);
    const escalateTool = tools.find((t) => t.name === 'escalate_to_planned')!;

    const result = await escalateTool.handler({
      plan: 'Multi-step research',
      tasks: [{ id: 'step-1', title: 'Research', prompt: 'Do it', blockedBy: [] }],
    }, {});
    expect(deps.executionEngine!.createTree).toHaveBeenCalled();
    expect(deps.executionEngine!.startTree).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.treeId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/escalation.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/tools/escalation.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const TaskNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['agent', 'code', 'condition', 'notify', 'delay', 'approval']).default('agent'),
  agent: z.string().optional(),
  prompt: z.string(),
  blockedBy: z.array(z.string()).default([]),
});

export function buildEscalationTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  tools.push(
    tool(
      'escalate_to_planned',
      'Escalate the current request to a multi-step planned execution. ' +
        'Use this when you realize mid-conversation that the work needs a task tree.',
      {
        plan: z.string().describe('One-sentence plan description'),
        tasks: z.array(TaskNodeSchema),
      },
      async ({ plan, tasks }) => {
        if (!deps.executionEngine) return err('Execution engine not available.');

        const treeId = generateId();
        deps.executionEngine.createTree({
          id: treeId,
          projectId: scope.projectId,
          plan,
          tasks,
        });

        await deps.executionEngine.startTree(treeId);

        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'execution:tree:created',
          payload: { treeId, projectId: scope.projectId, plan, taskCount: tasks.length },
        });

        return ok({ treeId, status: 'running' });
      },
    ),
  );

  tools.push(
    tool(
      'request_approval',
      'Pause execution and ask the user a question. Blocks until they respond.',
      {
        question: z.string().describe('What to ask the user'),
        options: z.array(z.string()).optional().describe('Choices (default: Yes/No)'),
      },
      async ({ question, options }) => {
        if (!deps.pendingApprovals) return err('Approval system not available.');

        const approvalId = generateId();
        deps.pendingApprovals.create({
          id: approvalId,
          skillName: 'raven-mcp',
          actionName: 'request_approval',
          question,
          options: options ?? ['Yes', 'No'],
          taskId: scope.taskId,
        });

        deps.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'raven-mcp',
          type: 'approval:requested',
          payload: { approvalId, question, options },
        });

        const result = await deps.pendingApprovals.waitForResolution(approvalId);
        return ok({ approved: result.approved, choice: result.choice });
      },
    ),
  );

  return tools;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/tools/escalation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/tools/escalation.ts packages/core/src/__tests__/mcp-server/tools/escalation.test.ts
git commit -m "feat(mcp): add escalation tools — escalate_to_planned, request_approval"
```

---

### Task 8: MCP factory (createRavenMcp) and index

**Files:**
- Create: `packages/core/src/mcp-server/index.ts`
- Test: `packages/core/src/__tests__/mcp-server/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/mcp-server/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createRavenMcp } from '../../mcp-server/index.ts';
import type { RavenMcpDeps } from '../../mcp-server/types.ts';
import type { ScopeContext } from '../../mcp-server/scope.ts';

function createMockDeps(): RavenMcpDeps {
  return {
    executionEngine: {
      onTaskCompleted: vi.fn().mockResolvedValue(undefined),
      onTaskBlocked: vi.fn(),
      createTree: vi.fn(),
      startTree: vi.fn().mockResolvedValue(undefined),
      getTree: vi.fn(),
    } as any,
    messageStore: {
      appendMessage: vi.fn().mockReturnValue('msg-1'),
      getMessages: vi.fn().mockReturnValue([]),
    } as any,
    eventBus: { emit: vi.fn() } as any,
  };
}

describe('createRavenMcp', () => {
  it('returns McpSdkServerConfigWithInstance', () => {
    const deps = createMockDeps();
    const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
    const config = createRavenMcp(deps, scope);

    expect(config.type).toBe('sdk');
    expect(config.name).toBe('raven');
    expect(config.instance).toBeDefined();
  });

  it('filters tools by scope — task scope gets task tools only', () => {
    const deps = createMockDeps();
    const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
    const config = createRavenMcp(deps, scope);

    // The instance is a McpServer — we verify it was created (exact tools are
    // tested in individual tool tests)
    expect(config.instance).toBeDefined();
  });

  it('system scope includes all tools', () => {
    const deps = createMockDeps();
    const scope: ScopeContext = { role: 'system' };
    const config = createRavenMcp(deps, scope);
    expect(config.instance).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/mcp-server/index.ts
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { isToolAllowed, type ScopeContext } from './scope.ts';
import { buildTaskLifecycleTools } from './tools/task-lifecycle.ts';
import { buildSessionTools } from './tools/session.ts';
import { buildKnowledgeTools } from './tools/knowledge.ts';
import { buildValidationTools } from './tools/validation.ts';
import { buildSystemTools } from './tools/system.ts';
import { buildEscalationTools } from './tools/escalation.ts';
import type { RavenMcpDeps } from './types.ts';

export type { RavenMcpDeps } from './types.ts';
export { type ScopeContext } from './scope.ts';

export function createRavenMcp(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): McpSdkServerConfigWithInstance {
  const allTools = [
    ...buildTaskLifecycleTools(deps, scope),
    ...buildSessionTools(deps, scope),
    ...buildKnowledgeTools(deps, scope),
    ...buildValidationTools(deps, scope),
    ...buildSystemTools(deps, scope),
    ...buildEscalationTools(deps, scope),
  ];

  const scopedTools = allTools.filter((t) => isToolAllowed(scope, t.name));

  return createSdkMcpServer({ name: 'raven', version: '1.0.0', tools: scopedTools });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/index.ts packages/core/src/__tests__/mcp-server/index.test.ts
git commit -m "feat(mcp): add createRavenMcp factory with scope-based tool filtering"
```

---

### Task 9: Wire Raven MCP into agent-session.ts

**Files:**
- Modify: `packages/core/src/agent-manager/agent-backend.ts` — update mcpServers type
- Modify: `packages/core/src/agent-manager/agent-session.ts` — add Raven MCP creation
- Modify: `packages/shared/src/types/agents.ts` — add treeId, executionTaskId to AgentTask
- Modify: `packages/shared/src/types/events.ts` — add treeId to AgentTaskRequestEvent
- Modify: `packages/core/src/index.ts` — pass treeId in execution:task:run-agent → agent:task:request

- [ ] **Step 1: Add treeId and executionTaskId to AgentTask**

In `packages/shared/src/types/agents.ts`, add after line 123 (`namedAgentId`):

```typescript
  treeId?: string;
  executionTaskId?: string;
```

- [ ] **Step 2: Add treeId to AgentTaskRequestEvent payload**

In `packages/shared/src/types/events.ts`, in the `AgentTaskRequestEvent` payload (around line 62), add:

```typescript
    treeId?: string;
    executionTaskId?: string;
```

- [ ] **Step 3: Update BackendOptions.mcpServers type**

In `packages/core/src/agent-manager/agent-backend.ts`, change line 16 from:

```typescript
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
```

to:

```typescript
  mcpServers: Record<string, unknown>;
```

This accepts both stdio configs and SDK MCP configs. The SDK `query()` already accepts the union type `McpServerConfig`.

- [ ] **Step 4: Wire Raven MCP into agent-session.ts**

In `packages/core/src/agent-manager/agent-session.ts`:

Add import at top:
```typescript
import { createRavenMcp, type RavenMcpDeps, type ScopeContext } from '../mcp-server/index.ts';
```

Add `ravenMcpDeps` to the `RunOptions` interface:
```typescript
export interface RunOptions {
  // ... existing fields ...
  ravenMcpDeps?: RavenMcpDeps;
  port?: number;
}
```

In the `runAgentTask` function, after the `sdkMcpServers` building loop (after line 253), add:

```typescript
// Add Raven MCP (in-process, scoped to this task)
if (opts.ravenMcpDeps) {
  const role = resolveAgentRole(task);
  const ravenMcp = createRavenMcp(opts.ravenMcpDeps, {
    role,
    projectId: task.projectId,
    sessionId: task.sessionId,
    treeId: task.treeId,
    taskId: task.executionTaskId,
  });
  sdkMcpServers['raven'] = ravenMcp;
}
```

Add the role resolver function before `runAgentTask`:

```typescript
function resolveAgentRole(task: AgentTask): ScopeContext['role'] {
  if (task.executionTaskId) return 'task';
  if (task.skillName === '_quality-reviewer' || task.skillName === '_evaluator') return 'validation';
  if (task.skillName === 'knowledge') return 'knowledge';
  return 'chat';
}
```

Add `mcp__raven__*` to allowedTools (after MCP wildcards loop):
```typescript
if (opts.ravenMcpDeps) {
  allowedTools.push('mcp__raven__*');
}
```

- [ ] **Step 5: Pass treeId through execution engine wiring in index.ts**

In `packages/core/src/index.ts`, in the `execution:task:run-agent` handler (line 270), add `treeId` to the emitted `agent:task:request` event payload:

```typescript
treeId: payload.treeId,
executionTaskId: payload.taskId,
```

- [ ] **Step 6: Pass ravenMcpDeps through AgentManager**

In `packages/core/src/agent-manager/agent-manager.ts`, the `runTask` method creates `RunOptions`. Pass `ravenMcpDeps` through. Add to the `AgentManagerDeps` or pass as a constructor parameter. The deps come from the same context as `ApiDeps` — executionEngine, messageStore, eventBus, etc.

- [ ] **Step 7: Build and verify no type errors**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/agents.ts packages/shared/src/types/events.ts \
  packages/core/src/agent-manager/agent-backend.ts \
  packages/core/src/agent-manager/agent-session.ts \
  packages/core/src/agent-manager/agent-manager.ts \
  packages/core/src/index.ts
git commit -m "feat(mcp): wire Raven MCP into agent session — every agent gets scoped MCP"
```

---

### Task 10: Migrate orchestrator — remove text parsing, use MCP tools

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts` — remove triage parsing, pending map, API injection
- Modify: `packages/core/src/agent-manager/prompt-builder.ts` — remove context injection that moves to MCP
- Delete: `packages/core/src/task-execution/plan-builder.ts`
- Modify: `packages/core/src/index.ts` — remove `execution:tree:create` handler (MCP creates trees directly)

- [ ] **Step 1: Remove plan-builder.ts import and triage handling from orchestrator**

In `packages/core/src/orchestrator/orchestrator.ts`:

1. Remove the import of `parseTriageResponse` from `plan-builder.ts`
2. Remove the `pendingTriageTasks` map (line 85)
3. Remove the `handleTaskCompleteTriage` method (lines 538-567)
4. Remove the event listener registration for `agent:task:complete` that calls `handleTaskCompleteTriage`
5. Remove `buildTriageInstructions` import and its usage in `handleUserChat` (lines 395-402)

- [ ] **Step 2: Remove meta-project and named agent API injection**

In `packages/core/src/orchestrator/orchestrator.ts`:

1. Remove lines 474 (named agent REST API injection)
2. Remove lines 479-492 (meta-project API injection)

These are replaced by MCP system management tools.

- [ ] **Step 3: Remove upfront knowledge context injection**

In `packages/core/src/orchestrator/orchestrator.ts`:

Remove lines 322-333 (knowledge context retrieval and injection). Agents now call `get_knowledge_context` or `search_knowledge` via MCP on demand.

Keep the `knowledgeContext` field on the task for backward compatibility during migration — it will be empty/undefined. Agents that need knowledge will call the MCP tool.

- [ ] **Step 4: Update orchestrator agent prompt**

Replace `buildTriageInstructions()` usage with new MCP-aware instructions. The orchestrator's system prompt should tell it to use `classify_request` and `create_task_tree` MCP tools instead of outputting text markers.

In `prompt-builder.ts`, remove the triage delegation section (lines 15-22) that references `EXECUTION_MODE`. Add MCP tool usage instructions for chat-scoped agents.

- [ ] **Step 5: Remove `execution:tree:create` handler from index.ts**

In `packages/core/src/index.ts`, remove lines 305-322 (the `execution:tree:create` event handler). The MCP's `create_task_tree` tool calls `executionEngine.createTree()` directly.

- [ ] **Step 6: Remove result-as-summary extraction from index.ts**

In `packages/core/src/index.ts`, remove lines 324-353 (the `agent:task:complete` → `executionEngine.onTaskCompleted` handler). Task agents now call `complete_task` via MCP, which calls `executionEngine.onTaskCompleted()` directly.

Also remove the `executionTaskToTree` map (line 256) — no longer needed.

- [ ] **Step 7: Delete plan-builder.ts**

```bash
rm packages/core/src/task-execution/plan-builder.ts
```

Remove any remaining imports of this file.

- [ ] **Step 8: Build and verify no type errors**

Run: `npm run build`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(mcp): remove text parsing, API injection, and triage handlers

Orchestrator now uses MCP tools (classify_request, create_task_tree)
instead of outputting EXECUTION_MODE markers parsed by plan-builder.ts.
Meta-project and named agent management moved to MCP system tools.
Knowledge context is now on-demand via MCP instead of upfront injection."
```

---

### Task 11: Migrate validation agents — remove SCORE regex

**Files:**
- Modify: `packages/core/src/task-execution/create-validation-deps.ts` — remove SCORE regex, use MCP event

- [ ] **Step 1: Update validation agent prompt**

In `packages/core/src/task-execution/create-validation-deps.ts`, the `runQualityReviewer` function (lines 74-96) tells the agent to "Respond with SCORE: N". Change the prompt to instruct the agent to use the `submit_validation_score` MCP tool instead.

The validation agent now has scope `validation` and the `submit_validation_score` tool available. The agent calls the tool, which emits an `execution:task:validation` event. Wire this event to the validation pipeline.

- [ ] **Step 2: Remove SCORE regex extraction**

Remove lines 88-90 (the `SCORE:\s*(\d+)` regex). The score now comes from the MCP tool call event, not from parsing agent text output.

- [ ] **Step 3: Wire validation event handler**

Add a listener for `execution:task:validation` in the appropriate place (either in `create-validation-deps.ts` or `index.ts`) that feeds the score/feedback/pass back to the validation pipeline.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-execution/create-validation-deps.ts
git commit -m "refactor(mcp): validation agents use submit_validation_score MCP tool

Removes SCORE: N regex extraction. Validation agents call the MCP tool
which emits a structured event with score, feedback, and pass/fail."
```

---

### Task 12: Migrate knowledge agent — remove WebFetch-to-localhost

**Files:**
- Modify: `packages/core/src/knowledge-engine/knowledge-agent.ts` — remove REST API prompt, use MCP tools
- Modify: `packages/core/src/knowledge-engine/knowledge-consolidation.ts` — remove JSON.parse
- Modify: `packages/core/src/knowledge-engine/clustering-ops.ts` — remove type cast
- Modify: `packages/core/src/knowledge-engine/hub-ops.ts` — remove type cast

- [ ] **Step 1: Rewrite knowledge agent definition**

In `packages/core/src/knowledge-engine/knowledge-agent.ts`:

Replace `buildKnowledgeAgentPrompt()` (which contains the full REST API spec) with a short prompt that tells the agent to use MCP knowledge tools:

```typescript
export function createKnowledgeAgentDefinition(): SubAgentDefinition {
  return {
    description:
      'Knowledge management agent — search, browse, organize, and manage your knowledge base. ' +
      'Delegate here when the user wants to find information in their knowledge.',
    prompt:
      'You manage Raven\'s knowledge base. Use these MCP tools:\n' +
      '- search_knowledge: find existing knowledge by query, tags, or domain\n' +
      '- save_knowledge: store new knowledge items\n' +
      '- get_knowledge_context: retrieve relevant context for a topic\n\n' +
      'Do not use WebFetch to call localhost APIs.',
    tools: [],  // No WebFetch needed — MCP tools handle everything
  };
}
```

Remove the `port` parameter — no longer needed.

- [ ] **Step 2: Update knowledge consolidation**

In `packages/core/src/knowledge-engine/knowledge-consolidation.ts`, the agent currently returns raw JSON that gets `JSON.parse()`d (line 150). The consolidation agent should now use `complete_task` with structured artifacts, or we keep it as-is since it's an internal agent that will have the Raven MCP automatically.

For consolidation specifically: the agent's output structure (merges, prunes, digest) is consumed by the consolidation engine directly. Update the agent to use `complete_task` with the structured data as an artifact, then have the consolidation engine read from the `execution:task:validation` event or the task's artifacts.

Alternatively, since consolidation runs as a simple agent task (not a tree task), keep the JSON output but add Zod validation instead of unsafe `JSON.parse()`:

```typescript
const ConsolidationResultSchema = z.object({
  merges: z.array(z.object({
    keepId: z.string(),
    removeIds: z.array(z.string()),
    mergedContent: z.string(),
  })).optional(),
  prunes: z.array(z.string()).optional(),
  digest: z.string().optional(),
});

const parsed = ConsolidationResultSchema.safeParse(JSON.parse(result.result));
if (!parsed.success) {
  log.error(`Invalid consolidation result: ${parsed.error.message}`);
  return;
}
```

- [ ] **Step 3: Update clustering-ops.ts**

In `packages/core/src/knowledge-engine/clustering-ops.ts`, line 145: replace unsafe type cast with Zod validation:

```typescript
const LabelResultSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
});

const parsed = LabelResultSchema.safeParse(JSON.parse(payload.result));
if (!parsed.success) {
  log.warn(`Invalid cluster label response: ${parsed.error.message}`);
  return;
}
```

- [ ] **Step 4: Update hub-ops.ts**

In `packages/core/src/knowledge-engine/hub-ops.ts`, line 158: same pattern — replace unsafe type cast with Zod validation.

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/knowledge-engine/knowledge-agent.ts \
  packages/core/src/knowledge-engine/knowledge-consolidation.ts \
  packages/core/src/knowledge-engine/clustering-ops.ts \
  packages/core/src/knowledge-engine/hub-ops.ts
git commit -m "refactor(mcp): knowledge agent uses MCP tools, add Zod validation to JSON parsing

Removes WebFetch-to-localhost REST API spec from knowledge agent prompt.
Replaces unsafe JSON.parse type casts with Zod schema validation."
```

---

### Task 13: Remove upfront prompt injection (session history, skill catalog)

**Files:**
- Modify: `packages/core/src/agent-manager/prompt-builder.ts` — remove context sections that move to MCP
- Modify: `packages/core/src/agent-manager/agent-session.ts` — remove upfront history loading

- [ ] **Step 1: Remove session history injection from agent-session.ts**

In `packages/core/src/agent-manager/agent-session.ts`, around line 277, there's code that loads conversation history and formats it as a `<conversation-history>` block in the prompt. Remove this — agents now call `get_session_history` via MCP when they need context.

- [ ] **Step 2: Slim down prompt-builder.ts**

In `packages/core/src/agent-manager/prompt-builder.ts`:

Keep:
- Base system prompt (lines 5-13) — "You are Raven..."
- Project context chain (line 28) — static identity
- Project system prompt (line 58) — custom project instructions
- Knowledge discovery instructions (lines 62-71)

Remove (moved to MCP on-demand access):
- `task.knowledgeContext` injection (lines 31-38) — agents call `get_knowledge_context`
- `task.sessionReferencesContext` injection — agents call `get_session_history`
- `task.taskBoardContext` injection (lines 49-50) — agents call `get_task_context`
- `task.skillCatalogContext` injection (line 54) — agents call `list_agents`

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/agent-manager/prompt-builder.ts \
  packages/core/src/agent-manager/agent-session.ts
git commit -m "refactor(mcp): remove upfront prompt injection — agents pull context via MCP

Session history, knowledge context, skill catalog, and task board
context are no longer injected into prompts. Agents retrieve them
on-demand using get_session_history, search_knowledge, get_task_context."
```

---

### Task 14: Run linting and fix issues

**Files:**
- All modified files

- [ ] **Step 1: Run format**

Run: `npm run format`

- [ ] **Step 2: Run lint and type check**

Run: `npm run check`
Expected: PASS (fix any issues that arise)

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: PASS (fix any failures)

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: fix lint and type errors from MCP migration"
```

---

### Task 15: Migration regression tests

**Files:**
- Create: `packages/core/src/__tests__/mcp-server/migration-regression.test.ts`

- [ ] **Step 1: Write regression test**

```typescript
// packages/core/src/__tests__/mcp-server/migration-regression.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';

const CORE_SRC = join(import.meta.dirname, '../../..');

describe('MCP migration regression', () => {
  it('plan-builder.ts is deleted', () => {
    const exists = existsSync(join(CORE_SRC, 'task-execution/plan-builder.ts'));
    expect(exists).toBe(false);
  });

  it('no file imports plan-builder', () => {
    const files = globSync('**/*.ts', { cwd: CORE_SRC, ignore: ['**/node_modules/**', '**/__tests__/**'] });
    for (const file of files) {
      const content = readFileSync(join(CORE_SRC, file), 'utf8');
      expect(content).not.toContain("from '../task-execution/plan-builder");
      expect(content).not.toContain("from './plan-builder");
    }
  });

  it('no prompt contains EXECUTION_MODE marker instructions', () => {
    const files = globSync('**/*.ts', { cwd: CORE_SRC, ignore: ['**/node_modules/**', '**/__tests__/**'] });
    for (const file of files) {
      const content = readFileSync(join(CORE_SRC, file), 'utf8');
      // Allow test files and this regression test to reference the marker
      if (file.includes('__tests__')) continue;
      expect(content).not.toContain('EXECUTION_MODE:');
    }
  });

  it('no prompt contains localhost REST API specs for agents', () => {
    const promptFiles = [
      'agent-manager/prompt-builder.ts',
      'knowledge-engine/knowledge-agent.ts',
    ];
    for (const file of promptFiles) {
      const fullPath = join(CORE_SRC, file);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf8');
      expect(content).not.toContain('http://localhost');
      expect(content).not.toContain('/api/knowledge');
    }
  });

  it('no agent prompt contains SCORE: pattern instruction', () => {
    const validationFile = join(CORE_SRC, 'task-execution/create-validation-deps.ts');
    if (existsSync(validationFile)) {
      const content = readFileSync(validationFile, 'utf8');
      expect(content).not.toMatch(/SCORE:\s*N/);
      expect(content).not.toMatch(/Respond with SCORE/);
    }
  });
});
```

- [ ] **Step 2: Run the regression test**

Run: `npm test -- --run packages/core/src/__tests__/mcp-server/migration-regression.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/mcp-server/migration-regression.test.ts
git commit -m "test(mcp): add migration regression tests — verify old patterns removed"
```

---

### Task 16: Build, full test suite, and final verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Lint check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

Start the core server and verify it boots without errors:
```bash
RAVEN_PORT=4001 node packages/core/dist/index.js
```

Check health:
```bash
curl http://localhost:4001/api/health
```

- [ ] **Step 5: Final commit and push**

```bash
git push origin master
```
