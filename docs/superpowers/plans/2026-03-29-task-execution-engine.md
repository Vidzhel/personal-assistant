# Task Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a harness-driven task execution engine that replaces the orchestrator relay pattern with a plan-execute-synthesize model, complete with three-gate validation, dependency resolution, retry with feedback, and dynamic task trees.

**Architecture:** The orchestrator triages requests into DIRECT/DELEGATED/PLANNED modes. For PLANNED tasks, it creates a task tree with dependencies and agent assignments. A new Task Execution Engine (deterministic code, zero tokens) watches task completions, resolves dependencies, triggers next agents, and runs each result through a validation pipeline (programmatic checks → evaluator agent → optional quality reviewer). Failed tasks retry with feedback. Blocked or replanning-needed tasks escalate to the orchestrator. The entire tree is visible in the dashboard.

**Tech Stack:** TypeScript ESM, existing task-store + event bus, Zod validation, built-in evaluator/reviewer agents via CapabilityLibrary

**Key constraint:** Existing task CRUD and API must remain backward-compatible. The execution engine is an addition, not a replacement of current flows.

---

## File Structure

### New files to create:

```
packages/shared/src/types/
└── task-execution.ts                    # New: TaskArtifact, TaskTreeNode, execution types

packages/core/src/task-execution/
├── dependency-resolver.ts               # Determines which tasks are ready to run
├── validation-pipeline.ts               # Three-gate validation (programmatic → evaluator → quality)
├── task-execution-engine.ts             # Core loop: watches completions → triggers next
├── plan-builder.ts                      # Builds task tree from orchestrator plan
└── task-board-protocol.ts               # System prompt additions for agent task awareness

projects/agents/
├── _evaluator.yaml                      # Built-in evaluator agent
└── _quality-reviewer.yaml               # Built-in quality reviewer agent
```

### Files to modify:

```
packages/shared/src/types/tasks.ts       # New statuses, blockedBy, structured artifacts
packages/shared/src/types/events.ts      # New events: task:ready, task:validation:*, task:replan
migrations/022-task-execution.sql        # blockedBy, validationStatus, retryCount columns
packages/core/src/task-manager/task-store.ts  # New fields, dependency queries
packages/core/src/orchestrator/orchestrator.ts # DIRECT/DELEGATED/PLANNED triage
packages/core/src/agent-manager/prompt-builder.ts # Task-board protocol injection
packages/core/src/index.ts               # Boot: initialize execution engine
```

---

### Task 1: Extend Task Types for Execution Engine

**Files:**
- Modify: `packages/shared/src/types/tasks.ts`
- Create: `packages/shared/src/types/task-execution.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/task-execution-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/__tests__/task-execution-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  TaskArtifactSchema,
  TaskValidationConfigSchema,
  TaskTreeNodeSchema,
} from '../types/task-execution.ts';

describe('TaskArtifactSchema', () => {
  it('validates a file artifact', () => {
    const result = TaskArtifactSchema.safeParse({
      type: 'file',
      label: 'Study guide',
      filePath: 'data/artifacts/t1/guide.md',
    });
    expect(result.success).toBe(true);
  });

  it('validates a data artifact', () => {
    const result = TaskArtifactSchema.safeParse({
      type: 'data',
      label: 'Schedule data',
      data: { exams: [{ date: '2026-04-01', subject: 'Calculus' }] },
    });
    expect(result.success).toBe(true);
  });

  it('validates a reference artifact', () => {
    const result = TaskArtifactSchema.safeParse({
      type: 'reference',
      label: 'Source task',
      referenceId: 'task-123',
    });
    expect(result.success).toBe(true);
  });
});

describe('TaskTreeNodeSchema', () => {
  it('validates a task tree node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'check-schedule',
      title: 'Check today schedule',
      type: 'agent',
      agent: 'schedule-agent',
      prompt: 'Check the calendar for today',
      blockedBy: [],
    });
    expect(result.success).toBe(true);
  });

  it('validates a code node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'fetch-weather',
      title: 'Fetch weather',
      type: 'code',
      script: 'scripts/fetch-weather.ts',
      blockedBy: [],
    });
    expect(result.success).toBe(true);
  });

  it('validates a condition node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'has-exams',
      title: 'Check if exams exist',
      type: 'condition',
      expression: '{{ check-schedule.artifacts.data.exams.length }} > 0',
      blockedBy: ['check-schedule'],
    });
    expect(result.success).toBe(true);
  });

  it('validates a notify node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'send-summary',
      title: 'Send briefing',
      type: 'notify',
      channel: 'telegram',
      message: '{{ compile.summary }}',
      blockedBy: ['compile'],
    });
    expect(result.success).toBe(true);
  });

  it('validates a delay node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'wait-12h',
      title: 'Wait 12 hours',
      type: 'delay',
      duration: '12h',
      blockedBy: ['send-summary'],
    });
    expect(result.success).toBe(true);
  });

  it('validates an approval node', () => {
    const result = TaskTreeNodeSchema.safeParse({
      id: 'approve-send',
      title: 'Approve email send',
      type: 'approval',
      message: 'Ready to send the email?',
      blockedBy: ['compose-email'],
    });
    expect(result.success).toBe(true);
  });

  it('validates validation config', () => {
    const result = TaskValidationConfigSchema.safeParse({
      evaluator: true,
      evaluatorModel: 'haiku',
      qualityReview: true,
      qualityThreshold: 4,
      maxRetries: 3,
    });
    expect(result.success).toBe(true);
  });

  it('applies validation defaults', () => {
    const result = TaskValidationConfigSchema.parse({});
    expect(result.evaluator).toBe(true);
    expect(result.evaluatorModel).toBe('haiku');
    expect(result.qualityReview).toBe(false);
    expect(result.maxRetries).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/task-execution-types.test.ts`

- [ ] **Step 3: Create task-execution.ts with schemas and types**

```typescript
// packages/shared/src/types/task-execution.ts
import { z } from 'zod';

// --- Structured Artifacts ---

export const TaskArtifactSchema = z.object({
  type: z.enum(['file', 'data', 'reference']),
  label: z.string().min(1),
  filePath: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  referenceId: z.string().optional(),
});

export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

// --- Validation Config ---

export const TaskValidationConfigSchema = z.object({
  requireArtifacts: z.boolean().default(true),
  evaluator: z.boolean().default(true),
  evaluatorModel: z.enum(['haiku', 'sonnet']).default('haiku'),
  evaluatorCriteria: z.string().optional(),
  qualityReview: z.boolean().default(false),
  qualityModel: z.enum(['sonnet', 'opus']).default('sonnet'),
  qualityThreshold: z.number().int().min(1).max(5).default(3),
  maxRetries: z.number().int().min(0).default(2),
  retryBackoffMs: z.number().int().min(0).default(1000),
  onMaxRetriesFailed: z.enum(['fail', 'escalate', 'skip']).default('escalate'),
});

export type TaskValidationConfig = z.infer<typeof TaskValidationConfigSchema>;

// --- Task Tree Node Types ---

const BaseNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  blockedBy: z.array(z.string()).default([]),
  runIf: z.string().optional(),
  validation: TaskValidationConfigSchema.optional(),
});

const AgentNodeSchema = BaseNodeSchema.extend({
  type: z.literal('agent'),
  agent: z.string().optional(),          // null = orchestrator picks
  prompt: z.string().min(1),
});

const CodeNodeSchema = BaseNodeSchema.extend({
  type: z.literal('code'),
  script: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const ConditionNodeSchema = BaseNodeSchema.extend({
  type: z.literal('condition'),
  expression: z.string().min(1),
});

const NotifyNodeSchema = BaseNodeSchema.extend({
  type: z.literal('notify'),
  channel: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(z.string()).default([]),
});

const DelayNodeSchema = BaseNodeSchema.extend({
  type: z.literal('delay'),
  duration: z.string().min(1),           // "12h", "30m", "1d"
});

const ApprovalNodeSchema = BaseNodeSchema.extend({
  type: z.literal('approval'),
  message: z.string().min(1),
});

export const TaskTreeNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  CodeNodeSchema,
  ConditionNodeSchema,
  NotifyNodeSchema,
  DelayNodeSchema,
  ApprovalNodeSchema,
]);

export type TaskTreeNode = z.infer<typeof TaskTreeNodeSchema>;

// --- Execution Status ---

export type ExecutionTaskStatus =
  | 'pending_approval'   // plan created, waiting for user approval
  | 'todo'               // ready but waiting for dependencies
  | 'ready'              // all dependencies met, can be triggered
  | 'in_progress'        // agent/code running
  | 'validating'         // running through validation pipeline
  | 'completed'          // passed validation
  | 'failed'             // max retries exceeded
  | 'blocked'            // agent reported blocked, needs replan
  | 'skipped'            // runIf condition was false
  | 'cancelled';         // user cancelled

// --- Task Tree ---

export interface ExecutionTask {
  id: string;
  parentTaskId: string;              // the parent RavenTask that owns this tree
  node: TaskTreeNode;                // the task definition
  status: ExecutionTaskStatus;
  agentTaskId?: string;              // link to AgentTask when running
  artifacts: TaskArtifact[];
  summary?: string;
  retryCount: number;
  lastError?: string;
  needsReplan?: boolean;
  validationResult?: {
    gate1Passed?: boolean;
    gate2Passed?: boolean;
    gate2Reason?: string;
    gate3Passed?: boolean;
    gate3Score?: number;
    gate3Feedback?: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface TaskTree {
  id: string;                        // same as parent RavenTask ID
  projectId?: string;
  status: 'pending_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  tasks: Map<string, ExecutionTask>;
  plan?: string;                     // orchestrator's plan description
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Update TaskStatus in tasks.ts**

Add `'pending_approval'` and `'blocked'` to the existing `TaskStatus` type and DB CHECK constraint:

```typescript
// packages/shared/src/types/tasks.ts
export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'archived' | 'pending_approval' | 'blocked';
```

- [ ] **Step 5: Export from index**

Add exports to `packages/shared/src/index.ts` and `packages/shared/src/types/index.ts`.

- [ ] **Step 6: Run tests, build, check**

Run: `npx vitest run packages/shared/src/__tests__/task-execution-types.test.ts && npm run build -w packages/shared && npm run check`

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(shared): add task execution types — TaskArtifact, TaskTreeNode, validation config"
```

---

### Task 2: Database Migration for Task Execution

**Files:**
- Create: `migrations/022-task-execution.sql`

- [ ] **Step 1: Create migration**

```sql
-- Migration 022: Task execution engine support

-- Extend task status CHECK constraint
-- SQLite doesn't support ALTER CHECK, so we create a new table and migrate

-- Add execution task tracking table
CREATE TABLE IF NOT EXISTS execution_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id),
  node_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('pending_approval', 'todo', 'ready', 'in_progress', 'validating', 'completed', 'failed', 'blocked', 'skipped', 'cancelled')),
  agent_task_id TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  needs_replan INTEGER NOT NULL DEFAULT 0,
  validation_result_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_tasks_parent ON execution_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_status ON execution_tasks(status);

-- Task trees table
CREATE TABLE IF NOT EXISTS task_trees (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'running', 'completed', 'failed', 'cancelled')),
  plan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Update tasks table: allow new statuses
-- SQLite workaround: add the blocked status to tasks table
-- (pending_approval tasks use task_trees, but tasks may also be individually blocked)
```

Note: SQLite doesn't support modifying CHECK constraints. The existing `tasks` table CHECK constraint limits status to `('todo', 'in_progress', 'completed', 'archived')`. For the execution engine, we use the separate `execution_tasks` table which has the full status set. The parent `tasks` record stays with its original status set.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(db): add execution_tasks and task_trees tables for task execution engine"
```

---

### Task 3: Build Dependency Resolver

**Files:**
- Create: `packages/core/src/task-execution/dependency-resolver.ts`
- Test: `packages/core/src/__tests__/dependency-resolver.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/src/__tests__/dependency-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { findReadyTasks, validateDag, topologicalSort } from '../task-execution/dependency-resolver.ts';
import type { ExecutionTask } from '@raven/shared';

describe('validateDag', () => {
  it('accepts a valid DAG', () => {
    const tasks = new Map([
      ['a', makeTask('a', [])],
      ['b', makeTask('b', ['a'])],
      ['c', makeTask('c', ['a'])],
      ['d', makeTask('d', ['b', 'c'])],
    ]);
    expect(validateDag(tasks)).toEqual([]);
  });

  it('detects cycles', () => {
    const tasks = new Map([
      ['a', makeTask('a', ['b'])],
      ['b', makeTask('b', ['a'])],
    ]);
    const errors = validateDag(tasks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('cycle');
  });

  it('detects missing dependencies', () => {
    const tasks = new Map([
      ['a', makeTask('a', ['nonexistent'])],
    ]);
    const errors = validateDag(tasks);
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true);
  });
});

describe('findReadyTasks', () => {
  it('returns tasks with no dependencies', () => {
    const tasks = new Map([
      ['a', makeTask('a', [], 'todo')],
      ['b', makeTask('b', ['a'], 'todo')],
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['a']);
  });

  it('returns tasks whose dependencies are all completed', () => {
    const tasks = new Map([
      ['a', makeTask('a', [], 'completed')],
      ['b', makeTask('b', ['a'], 'todo')],
      ['c', makeTask('c', ['a', 'b'], 'todo')],
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['b']);
  });

  it('returns multiple independent ready tasks', () => {
    const tasks = new Map([
      ['a', makeTask('a', [], 'completed')],
      ['b', makeTask('b', ['a'], 'todo')],
      ['c', makeTask('c', ['a'], 'todo')],
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toContain('b');
    expect(ready).toContain('c');
  });

  it('skips tasks that are already running or completed', () => {
    const tasks = new Map([
      ['a', makeTask('a', [], 'in_progress')],
      ['b', makeTask('b', [], 'completed')],
      ['c', makeTask('c', [], 'todo')],
    ]);
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['c']);
  });

  it('handles runIf with skipped dependencies', () => {
    const tasks = new Map([
      ['cond', makeTask('cond', [], 'completed')],
      ['dependent', makeTask('dependent', ['cond'], 'todo')],
    ]);
    // dependent is ready because cond is completed
    const ready = findReadyTasks(tasks);
    expect(ready).toEqual(['dependent']);
  });
});

describe('topologicalSort', () => {
  it('returns correct execution order', () => {
    const tasks = new Map([
      ['a', makeTask('a', [])],
      ['b', makeTask('b', ['a'])],
      ['c', makeTask('c', ['a'])],
      ['d', makeTask('d', ['b', 'c'])],
    ]);
    const order = topologicalSort(tasks);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });
});

function makeTask(id: string, blockedBy: string[], status = 'todo'): ExecutionTask {
  return {
    id,
    parentTaskId: 'parent-1',
    node: { id, title: `Task ${id}`, type: 'agent', prompt: 'test', blockedBy } as any,
    status: status as any,
    artifacts: [],
    retryCount: 0,
  };
}
```

- [ ] **Step 2: Implement dependency-resolver.ts**

Export three functions:
- `validateDag(tasks: Map<string, ExecutionTask>): string[]` — returns errors (cycle detection, missing deps)
- `findReadyTasks(tasks: Map<string, ExecutionTask>): string[]` — returns IDs of tasks ready to run
- `topologicalSort(tasks: Map<string, ExecutionTask>): string[]` — returns execution order

Use Kahn's algorithm for topological sort and cycle detection (same approach as existing pipeline DAG validator — check `packages/core/src/pipeline-engine/` for reference).

A task is "ready" when:
- Status is `'todo'`
- All tasks in its `blockedBy` are `'completed'` or `'skipped'`

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add dependency resolver with DAG validation and ready-task detection"
```

---

### Task 4: Build Validation Pipeline

**Files:**
- Create: `packages/core/src/task-execution/validation-pipeline.ts`
- Test: `packages/core/src/__tests__/validation-pipeline.test.ts`

- [ ] **Step 1: Write failing test**

Tests for:
- Gate 1 (programmatic): passes when artifacts exist, fails when empty
- Gate 2 (evaluator): mock agent call, passes when PASS, fails when FAIL
- Gate 3 (quality): mock agent call, passes when score >= threshold
- Full pipeline: runs gates in order, stops on first failure
- Retry produces correct feedback prompt
- Gate 2 skipped when `evaluator: false`
- Gate 3 skipped when `qualityReview: false`

- [ ] **Step 2: Implement validation-pipeline.ts**

```typescript
// packages/core/src/task-execution/validation-pipeline.ts

export interface ValidationResult {
  passed: boolean;
  gate1Passed: boolean;
  gate2Passed?: boolean;
  gate2Reason?: string;
  gate3Passed?: boolean;
  gate3Score?: number;
  gate3Feedback?: string;
}

export interface ValidationDeps {
  runEvaluator: (taskPrompt: string, result: string, criteria?: string) => Promise<{ passed: boolean; reason: string }>;
  runQualityReviewer: (taskPrompt: string, result: string, threshold: number) => Promise<{ passed: boolean; score: number; feedback: string }>;
}

export async function validateTaskResult(
  task: ExecutionTask,
  config: TaskValidationConfig,
  deps: ValidationDeps,
): Promise<ValidationResult> {
  // Gate 1: Programmatic
  const gate1 = validateProgrammatic(task, config);
  if (!gate1) return { passed: false, gate1Passed: false };

  // Gate 2: Evaluator
  if (config.evaluator) {
    const gate2 = await deps.runEvaluator(
      task.node.type === 'agent' ? task.node.prompt : task.node.title,
      task.summary ?? '',
      config.evaluatorCriteria,
    );
    if (!gate2.passed) {
      return { passed: false, gate1Passed: true, gate2Passed: false, gate2Reason: gate2.reason };
    }
  }

  // Gate 3: Quality review
  if (config.qualityReview) {
    const gate3 = await deps.runQualityReviewer(
      task.node.type === 'agent' ? task.node.prompt : task.node.title,
      task.summary ?? '',
      config.qualityThreshold,
    );
    if (!gate3.passed) {
      return { passed: false, gate1Passed: true, gate2Passed: true, gate3Passed: false, gate3Score: gate3.score, gate3Feedback: gate3.feedback };
    }
  }

  return { passed: true, gate1Passed: true, gate2Passed: true, gate3Passed: true };
}

function validateProgrammatic(task: ExecutionTask, config: TaskValidationConfig): boolean {
  if (config.requireArtifacts && task.artifacts.length === 0 && !task.summary) {
    return false;
  }
  return true;
}

export function buildRetryPrompt(originalPrompt: string, lastError: string, attempt: number): string {
  return [
    `RETRY ATTEMPT ${attempt}`,
    '',
    '## Previous Attempt Failed',
    `Reason: ${lastError}`,
    '',
    '## Original Task',
    originalPrompt,
    '',
    'Please address the feedback above and try again.',
  ].join('\n');
}
```

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add three-gate validation pipeline with retry prompt builder"
```

---

### Task 5: Build Task Execution Engine (Core)

**Files:**
- Create: `packages/core/src/task-execution/task-execution-engine.ts`
- Test: `packages/core/src/__tests__/task-execution-engine.test.ts`

This is the heart of the system — the deterministic loop that drives task trees.

- [ ] **Step 1: Write failing test**

Tests for:
- Engine starts a task tree and triggers ready tasks
- When a task completes, engine checks dependencies and triggers next ready tasks
- Validation pipeline runs on completed agent tasks
- Failed validation retries the task with feedback
- Max retries exceeded marks task as failed and escalates
- All subtasks completed triggers orchestrator synthesis
- Blocked task triggers orchestrator replan
- Code tasks execute scripts directly
- Condition tasks evaluate expressions
- Notify tasks emit notification events
- Delay tasks schedule wakeup
- Approval tasks pause and wait for user input

- [ ] **Step 2: Implement task-execution-engine.ts**

```typescript
// packages/core/src/task-execution/task-execution-engine.ts

export interface TaskExecutionEngineDeps {
  eventBus: EventBusInterface;
  taskStore: TaskStore;
  db: DatabaseInterface;
  runAgentForTask: (executionTask: ExecutionTask, retryFeedback?: string) => Promise<{ summary: string; artifacts: TaskArtifact[] }>;
  validateTask: (task: ExecutionTask, config: TaskValidationConfig) => Promise<ValidationResult>;
}

export class TaskExecutionEngine {
  private trees = new Map<string, TaskTree>();

  constructor(private deps: TaskExecutionEngineDeps) {}

  /**
   * Start executing a task tree (called after user approves plan).
   */
  async startTree(treeId: string): Promise<void> {
    const tree = this.loadTree(treeId);
    tree.status = 'running';
    this.saveTree(tree);

    // Find and trigger all ready tasks
    await this.processReadyTasks(tree);
  }

  /**
   * Handle task completion — check deps, trigger next tasks.
   */
  async onTaskCompleted(treeId: string, taskId: string, summary: string, artifacts: TaskArtifact[]): Promise<void> {
    const tree = this.loadTree(treeId);
    const task = tree.tasks.get(taskId);
    if (!task) return;

    task.summary = summary;
    task.artifacts = artifacts;
    task.completedAt = new Date().toISOString();

    // Run validation for agent tasks
    if (task.node.type === 'agent') {
      const config = task.node.validation ?? TaskValidationConfigSchema.parse({});
      task.status = 'validating';
      this.saveTree(tree);

      const result = await this.deps.validateTask(task, config);
      task.validationResult = result;

      if (!result.passed) {
        await this.handleValidationFailure(tree, task, config, result);
        return;
      }
    }

    task.status = 'completed';
    this.saveTree(tree);

    // Check if all tasks are done
    if (this.isTreeComplete(tree)) {
      tree.status = 'completed';
      this.saveTree(tree);
      this.deps.eventBus.emit(/* task-tree:completed */);
      return;
    }

    // Trigger next ready tasks
    await this.processReadyTasks(tree);
  }

  private async handleValidationFailure(tree, task, config, result): Promise<void> {
    if (task.retryCount < config.maxRetries) {
      task.retryCount++;
      task.lastError = result.gate2Reason ?? result.gate3Feedback ?? 'Validation failed';
      task.status = 'todo'; // will be picked up as ready again
      this.saveTree(tree);
      await this.processReadyTasks(tree);
    } else {
      if (config.onMaxRetriesFailed === 'escalate') {
        task.status = 'failed';
        this.saveTree(tree);
        this.deps.eventBus.emit(/* escalate to orchestrator */);
      } else if (config.onMaxRetriesFailed === 'skip') {
        task.status = 'skipped';
        this.saveTree(tree);
        await this.processReadyTasks(tree);
      } else {
        task.status = 'failed';
        tree.status = 'failed';
        this.saveTree(tree);
      }
    }
  }

  private async processReadyTasks(tree: TaskTree): Promise<void> {
    const readyIds = findReadyTasks(tree.tasks);
    for (const taskId of readyIds) {
      const task = tree.tasks.get(taskId)!;
      await this.executeTask(tree, task);
    }
  }

  private async executeTask(tree: TaskTree, task: ExecutionTask): Promise<void> {
    // Check runIf condition
    if (task.node.runIf) {
      const condResult = this.evaluateCondition(task.node.runIf, tree);
      if (!condResult) {
        task.status = 'skipped';
        this.saveTree(tree);
        await this.processReadyTasks(tree);
        return;
      }
    }

    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    this.saveTree(tree);

    switch (task.node.type) {
      case 'agent':
        await this.executeAgentTask(tree, task);
        break;
      case 'code':
        await this.executeCodeTask(tree, task);
        break;
      case 'condition':
        await this.executeConditionTask(tree, task);
        break;
      case 'notify':
        await this.executeNotifyTask(tree, task);
        break;
      case 'delay':
        await this.executeDelayTask(tree, task);
        break;
      case 'approval':
        await this.executeApprovalTask(tree, task);
        break;
    }
  }

  // Implementation of each task type handler...
}
```

This is a large implementation. The key behaviors:
- `processReadyTasks()` calls `findReadyTasks()` and triggers each
- Agent tasks: call `runAgentForTask()` dep → validation pipeline → complete or retry
- Code tasks: `execFile()` the script, capture stdout as artifact
- Condition tasks: evaluate expression, set result as artifact data
- Notify tasks: emit notification event, mark complete
- Delay tasks: `setTimeout` then mark complete and process ready
- Approval tasks: set status, emit event, wait for external resolution

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add task execution engine with dependency resolution and validation"
```

---

### Task 6: Create Built-In Evaluator and Quality Reviewer Agents

**Files:**
- Create: `projects/agents/_evaluator.yaml`
- Create: `projects/agents/_quality-reviewer.yaml`

- [ ] **Step 1: Create evaluator agent**

```yaml
# projects/agents/_evaluator.yaml
name: _evaluator
displayName: Task Evaluator
description: Validates task completion — binary PASS/FAIL judgment
isDefault: false
skills: []
model: haiku
maxTurns: 1
instructions: |
  You are a task completion evaluator. You receive:
  - TASK: The original task description and expected output
  - RESULT: The agent's output summary and artifact descriptions

  Evaluate with binary judgment:
  - PASS: The task was meaningfully completed. Output addresses the prompt.
  - FAIL: The task was not completed, output is empty/irrelevant/hallucinated,
    or critical requirements were missed.

  Respond in EXACTLY this format (no other text):
  VERDICT: PASS
  REASON: One sentence explaining why.

  OR:
  VERDICT: FAIL
  REASON: One sentence explaining why.

  Be strict but fair. A partial but useful result is PASS.
  An empty, off-topic, or "I cannot do this" response is FAIL.
```

- [ ] **Step 2: Create quality reviewer agent**

```yaml
# projects/agents/_quality-reviewer.yaml
name: _quality-reviewer
displayName: Quality Reviewer
description: Adversarial quality review for high-stakes tasks
isDefault: false
skills: []
model: sonnet
maxTurns: 3
instructions: |
  You are an adversarial quality reviewer. You receive a completed task
  and its output. Your job is to find problems.

  Evaluate on these criteria:
  1. Completeness — does the output address ALL aspects of the task?
  2. Accuracy — are facts, dates, names correct?
  3. Coherence — is the output well-structured and logical?
  4. Usefulness — would the user find this valuable?

  Score 1-5 (1=unusable, 3=acceptable, 5=excellent).
  Provide specific, actionable feedback for any score below threshold.

  Respond in EXACTLY this format:
  SCORE: N
  FEEDBACK: Specific issues found (or "No issues" if score >= threshold)
bash:
  access: none
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add built-in evaluator and quality reviewer agent definitions"
```

---

### Task 7: Update Orchestrator for DIRECT/DELEGATED/PLANNED Triage

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts`
- Create: `packages/core/src/task-execution/plan-builder.ts`

- [ ] **Step 1: Create plan-builder.ts**

Export `function buildPlanPrompt(userMessage: string, availableAgents: string[], availableTemplates: string[]): string` that generates a system prompt instructing the orchestrator to:

1. Analyze the request
2. Decide execution mode: DIRECT, DELEGATED, or PLANNED
3. If PLANNED: output a structured task tree as JSON

The plan prompt instructs the orchestrator to respond in a specific format:

```
MODE: DIRECT | DELEGATED | PLANNED

If PLANNED:
PLAN: {
  "description": "...",
  "tasks": [
    { "id": "...", "title": "...", "type": "agent", "agent": "...", "prompt": "...", "blockedBy": [] },
    ...
  ]
}
```

- [ ] **Step 2: Update orchestrator handleUserChat**

Add triage logic at the start of handleUserChat. The orchestrator's first call determines the mode:

- **DIRECT**: Proceed with existing single-agent flow (unchanged)
- **DELEGATED**: Proceed with existing flow but create a RavenTask to track it
- **PLANNED**: Parse the task tree, create RavenTask + execution tasks, display plan for approval, hand off to execution engine

The key: we inject the plan-builder prompt as ADDITIONAL context to the existing orchestrator prompt. The orchestrator's response is parsed for the MODE indicator. If PLANNED, we parse the JSON task tree.

IMPORTANT: Be very careful with the orchestrator. This is additive — the existing flow for DIRECT mode (which is what currently happens for all requests) must continue working exactly as before.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(orchestrator): add DIRECT/DELEGATED/PLANNED triage with plan builder"
```

---

### Task 8: Task-Board Protocol (System Prompt Additions)

**Files:**
- Create: `packages/core/src/task-execution/task-board-protocol.ts`
- Modify: `packages/core/src/agent-manager/prompt-builder.ts`

- [ ] **Step 1: Create task-board-protocol.ts**

Export a function that generates system prompt text instructing agents on task management:

```typescript
export function buildTaskBoardInstructions(parentTaskId?: string): string {
  return [
    '## Task Management Protocol',
    '',
    'You have access to the Raven task system. When working on substantial tasks:',
    '',
    '1. If a parent task ID is provided, your work is tracked under it.',
    '2. Attach all output files as artifacts (save to data/artifacts/ directory).',
    '3. When done, provide a concise summary of what was accomplished.',
    '4. If you cannot complete the task, explain what blocked you.',
    '',
    parentTaskId ? `**Current parent task:** ${parentTaskId}` : '',
    '',
    '## Output Format',
    '',
    'End your response with:',
    '```',
    'STATUS: COMPLETED | BLOCKED | NEEDS_REPLAN',
    'SUMMARY: One paragraph summary of what was done',
    'ARTIFACTS:',
    '- /path/to/file1.md (description)',
    '- /path/to/file2.json (description)',
    '```',
  ].filter(Boolean).join('\n');
}
```

- [ ] **Step 2: Inject into prompt-builder.ts**

In the prompt builder, when building system prompts for execution engine tasks, include the task-board instructions. Read `prompt-builder.ts` to understand the current pattern and follow it.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add task-board protocol for agent system prompts"
```

---

### Task 9: Wire Execution Engine into Boot Sequence

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: task API routes (add endpoints for tree management)

- [ ] **Step 1: Initialize execution engine in boot**

Create TaskExecutionEngine instance with all deps, register event listeners.

- [ ] **Step 2: Add task tree API endpoints**

```
GET /api/task-trees                    — list active task trees
GET /api/task-trees/:id                — get tree with all execution tasks
POST /api/task-trees/:id/approve       — approve pending plan, start execution
POST /api/task-trees/:id/cancel        — cancel tree
POST /api/task-trees/:id/tasks/:taskId/approve — approve approval-type task
```

- [ ] **Step 3: Build, test, check, commit**

```bash
git commit -m "feat(boot): wire task execution engine into boot sequence with API endpoints"
```

---

### Task 10: Integration Test

**Files:**
- Create: `packages/core/src/__tests__/task-execution-integration.test.ts`

- [ ] **Step 1: Write integration test**

End-to-end test that:
1. Creates a task tree with 3 tasks (A → B → C with dependencies)
2. Starts the tree
3. Simulates task A completion with mock agent
4. Verifies B becomes ready and is triggered
5. Simulates B completion
6. Verifies C is triggered
7. Simulates C completion
8. Verifies tree is marked completed

Also test:
- Validation pipeline (mock evaluator returns PASS/FAIL)
- Retry on failure (mock evaluator returns FAIL, then PASS on retry)
- Blocked task escalation

- [ ] **Step 2: Run, fix, commit**

```bash
git commit -m "test: add integration test for task execution engine flow"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Build**

Run: `npm run build`

- [ ] **Step 2: Run all tests**

Run: `npm test`

- [ ] **Step 3: Lint/format check**

Run: `npm run check`

- [ ] **Step 4: Run all validators**

Run: `npm run validate:library && npm run validate:projects`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: complete Phase 3 — task execution engine with three-gate validation harness"
```

---

## Summary

After completing all 11 tasks:

- **Task types extended**: structured artifacts, validation config, 7 task node types, execution statuses
- **Dependency resolver**: DAG validation, topological sort, ready-task detection
- **Validation pipeline**: 3 gates (programmatic → evaluator → quality reviewer) with retry
- **Task execution engine**: watches completions, triggers next tasks, handles all node types
- **Built-in agents**: `_evaluator` (Haiku, binary PASS/FAIL) and `_quality-reviewer` (Sonnet, scored)
- **Orchestrator triage**: DIRECT/DELEGATED/PLANNED modes with plan builder
- **Task-board protocol**: system prompt instructions for agent task awareness
- **API endpoints**: task tree management (list, get, approve, cancel)
- **DB schema**: execution_tasks + task_trees tables

**Reliability math**: With 2 retries + evaluator, per-step success goes from 90% to 99.9%, making a 10-step workflow 99% reliable.

**Next plan**: Phase 4 — Unified Task Templates (replacing pipelines with template YAML + forEach + interpolation)
