# Unified Task Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both the pipeline engine and simple task templates with a unified template system that supports all task types (agent, code, condition, notify, delay, approval), `{{ }}` interpolation, `forEach` fan-out, cron/event/manual triggers, and parameterization — all driven by the Phase 3 task execution engine.

**Architecture:** Templates are YAML files in `projects/**/templates/`. A `TemplateRegistry` loads and validates them. When triggered (manually, by schedule, or by event), a template is instantiated — its `{{ }}` placeholders resolved, `forEach` items expanded — into a `TaskTree` that the execution engine drives. The pipeline engine's scheduler, event triggers, and run history are preserved but redirected to use templates.

**Tech Stack:** TypeScript ESM, Zod, js-yaml, existing task execution engine from Phase 3

**Key constraint:** The pipeline API (`/api/pipelines`) keeps working during migration — existing pipelines continue to function until all are migrated to templates.

---

## File Structure

### New files:

```
packages/shared/src/types/
└── templates.ts                        # Template YAML schema + types

packages/core/src/template-engine/
├── template-loader.ts                  # Loads templates from projects/ hierarchy
├── template-registry.ts                # Indexes templates, resolves from projects
├── template-instantiator.ts            # Resolves params, interpolation, forEach → TaskTree
└── template-scheduler.ts               # Cron + event triggers for templates
```

### Files to modify:

```
packages/core/src/index.ts              # Boot: initialize template engine
packages/core/src/api/routes/task-trees.ts  # Add template trigger endpoints
packages/core/src/scheduler/scheduler.ts    # Wire schedule YAML to template triggers
```

---

### Task 1: Define Template Schema

**Files:**
- Create: `packages/shared/src/types/templates.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/template-schema.test.ts`

- [ ] **Step 1: Write failing test**

Tests for:
- Valid template with agent tasks parses
- Valid template with mixed task types (agent + code + condition + notify)
- `params` field validates (name, type, required, default)
- `trigger` field validates (manual, schedule with cron, event with type)
- `plan.approval` defaults to `'manual'`
- `forEach` on a task validates
- `runIf` on a task validates
- Template with no tasks rejected
- Invalid task type rejected

- [ ] **Step 2: Implement template schema**

```typescript
// packages/shared/src/types/templates.ts
import { z } from 'zod';
import { TaskTreeNodeSchema, TaskValidationConfigSchema } from './task-execution.ts';

const KebabCaseRegex = /^[a-z][a-z0-9-]*$/;

const TemplateParamSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(true),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});

const TemplateTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1),
    timezone: z.string().default('UTC'),
  }),
  z.object({
    type: z.literal('event'),
    eventType: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// Extended task node for templates — adds forEach support
const TemplateTaskSchema = TaskTreeNodeSchema.and(z.object({
  forEach: z.string().optional(),        // "{{ taskId.artifacts.data.items }}"
  forEachAs: z.string().default('item'), // variable name for current item
}));

export const TaskTemplateSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  displayName: z.string().min(1),
  description: z.string().optional(),

  params: z.record(z.string(), TemplateParamSchema).default({}),
  trigger: z.array(TemplateTriggerSchema).default([{ type: 'manual' }]),

  plan: z.object({
    approval: z.enum(['auto', 'manual']).default('manual'),
    parallel: z.boolean().default(true),
  }).default({}),

  tasks: z.array(TemplateTaskSchema).min(1),
});

export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export type TemplateParam = z.infer<typeof TemplateParamSchema>;
export type TemplateTrigger = z.infer<typeof TemplateTriggerSchema>;
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;
```

- [ ] **Step 3: Export, run tests, build, check, commit**

```bash
git commit -m "feat(shared): add unified task template schema with params, triggers, forEach"
```

---

### Task 2: Build Template Loader

**Files:**
- Create: `packages/core/src/template-engine/template-loader.ts`
- Test: `packages/core/src/__tests__/template-loader.test.ts`

- [ ] **Step 1: Write failing test**

Tests:
- Loads templates from a directory
- Validates against TaskTemplateSchema
- Skips invalid templates with warning
- Returns empty for non-existent directory

- [ ] **Step 2: Implement**

```typescript
export async function loadTemplates(templatesDir: string): Promise<Map<string, TaskTemplate>>
```

Reads all `.yaml`/`.yml` files, parses with js-yaml, validates with `TaskTemplateSchema`. Returns `Map<name, template>`.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add template loader for reading template YAML files"
```

---

### Task 3: Build Template Registry

**Files:**
- Create: `packages/core/src/template-engine/template-registry.ts`
- Test: `packages/core/src/__tests__/template-registry.test.ts`

- [ ] **Step 1: Write failing test**

Tests:
- Loads templates from project hierarchy (global + project + sub-project)
- Templates from deeper levels override same-name from parent
- `listTemplates(projectId?)` returns templates available at a project scope
- `getTemplate(name, projectId?)` resolves from nearest scope

- [ ] **Step 2: Implement**

```typescript
export class TemplateRegistry {
  async load(projectsDir: string): Promise<void>
  getTemplate(name: string, projectId?: string): TaskTemplate | undefined
  listTemplates(projectId?: string): TaskTemplate[]
}
```

Uses `ProjectRegistry` to walk the hierarchy. At each level, loads `templates/*.yaml`. Deeper levels override same-name templates.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add template registry with project-scoped resolution"
```

---

### Task 4: Build Template Instantiator

**Files:**
- Create: `packages/core/src/template-engine/template-instantiator.ts`
- Test: `packages/core/src/__tests__/template-instantiator.test.ts`

This is the core of Phase 4 — resolves `{{ }}` interpolation and `forEach` expansion.

- [ ] **Step 1: Write failing test**

Tests:
- Resolves `{{ param }}` from provided params
- Resolves `{{ taskId.summary }}` from completed task summaries
- Resolves `{{ taskId.artifacts.data.field }}` with dot-path traversal
- Resolves `{{ taskId.output }}` for code task output
- Resolves `{{ taskId.result }}` for condition result
- `forEach` expands a single task into N tasks (one per item)
- `forEach` tasks get sequential IDs: `{originalId}-0`, `{originalId}-1`, etc.
- `{{ item }}` resolves to current forEach item
- `{{ item.field }}` resolves to field on current item
- Tasks downstream of a forEach task get blockedBy expanded to all generated IDs
- Missing params with no default throws error
- Missing params with default uses default value

- [ ] **Step 2: Implement**

```typescript
export interface InstantiationContext {
  params: Record<string, unknown>;
  completedTasks: Map<string, { summary: string; artifacts: TaskArtifact[]; output?: string; result?: boolean }>;
}

/**
 * Instantiate a template into TaskTreeNodes ready for the execution engine.
 * Phase 1: resolve params in all string fields.
 * Phase 2: (deferred) forEach expansion happens at runtime as tasks complete.
 */
export function instantiateTemplate(
  template: TaskTemplate,
  params: Record<string, unknown>,
): { tasks: TaskTreeNode[]; errors: string[] }
```

### Interpolation Engine

The interpolation replaces `{{ expression }}` in all string fields of task nodes.

Resolution order:
1. `{{ paramName }}` → from `params`
2. `{{ taskId.summary }}` → deferred (resolved at runtime by execution engine)
3. `{{ taskId.artifacts.data.field }}` → deferred
4. `{{ item }}` / `{{ item.field }}` → resolved during forEach expansion

For initial instantiation, only params are resolved. Task-to-task references are left as `{{ ... }}` and resolved by the execution engine at runtime when tasks complete.

### forEach Expansion

When a task has `forEach: "{{ taskId.artifacts.data.items }}"`, it can't be expanded at instantiation time (the source task hasn't run yet). Instead, mark it as a `forEach` task. The execution engine handles expansion at runtime when the source task completes.

For static forEach (e.g., `forEach: "{{ params.subjects }}"`), expand immediately during instantiation.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add template instantiator with param resolution and forEach expansion"
```

---

### Task 5: Build Template Scheduler

**Files:**
- Create: `packages/core/src/template-engine/template-scheduler.ts`
- Test: `packages/core/src/__tests__/template-scheduler.test.ts`

- [ ] **Step 1: Write failing test**

Tests:
- Registers cron jobs for templates with schedule triggers
- Cron trigger calls instantiate + createTree + startTree
- Event trigger fires when matching event occurs
- Manual trigger (no auto-registration, only on-demand)
- Unregisters jobs on shutdown

- [ ] **Step 2: Implement**

```typescript
export function createTemplateScheduler(deps: {
  templateRegistry: TemplateRegistry;
  executionEngine: TaskExecutionEngine;
  eventBus: EventBusInterface;
}): { start: () => void; stop: () => void }
```

Uses Croner for cron jobs (same as existing pipeline-scheduler). For each template with a `schedule` trigger, registers a cron job that:
1. Instantiates the template with default params
2. Creates a task tree via execution engine
3. Starts the tree (if `plan.approval === 'auto'`) or leaves pending

For event triggers, registers event handlers that match and trigger.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add template scheduler for cron and event-triggered template execution"
```

---

### Task 6: Wire Templates into Boot + API

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/api/routes/task-trees.ts` (add template endpoints)

- [ ] **Step 1: Add template engine to boot**

After execution engine initialization:
```typescript
const templateRegistry = new TemplateRegistry();
await templateRegistry.load(projectsDir);
const templateScheduler = createTemplateScheduler({ templateRegistry, executionEngine, eventBus });
templateScheduler.start();
```

- [ ] **Step 2: Add template API endpoints**

```
GET /api/templates                        — list all templates (optionally filtered by projectId)
GET /api/templates/:name                  — get template details
POST /api/templates/:name/trigger         — manually trigger template with params
```

The trigger endpoint:
1. Gets template from registry
2. Instantiates with provided params
3. Creates task tree
4. If `plan.approval === 'auto'`, starts immediately
5. Returns tree ID

- [ ] **Step 3: Build, test, check, commit**

```bash
git commit -m "feat(boot): wire template engine into boot sequence with API endpoints"
```

---

### Task 7: Migrate Existing Pipelines to Templates

**Files:**
- Create/modify: `projects/templates/morning-briefing.yaml` (convert from pipeline)
- Create/modify: `projects/templates/system-maintenance.yaml` (convert from pipeline)

- [ ] **Step 1: Convert morning-briefing pipeline**

Read `config/pipelines/morning-briefing.yaml`. Convert its nodes/connections to the unified template task format.

- [ ] **Step 2: Convert system-maintenance pipeline**

Same conversion for the maintenance pipeline.

- [ ] **Step 3: Update schedule YAML files**

Ensure `projects/schedules/*.yaml` reference the correct template names matching the converted templates.

- [ ] **Step 4: Validate**

Run: `npm run validate:projects`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: migrate existing pipelines to unified task template format"
```

---

### Task 8: Template Validation

**Files:**
- Modify: `packages/core/src/project-registry/project-validator.ts`
- Modify: `scripts/validate-projects.ts`

- [ ] **Step 1: Add template validation to project validator**

Extend `validateProjects()` to also check templates:
- Every template YAML passes `TaskTemplateSchema`
- All `blockedBy` references point to existing task IDs within same template
- No circular dependencies (reuse DAG validation)
- `agent` references resolve to known agents (if agent registry available)
- `forEach` fields contain valid `{{ }}` expressions
- `trigger` schedule cron expressions are valid

- [ ] **Step 2: Run validation, fix issues, commit**

```bash
git commit -m "feat: add template validation to project validator"
```

---

### Task 9: Integration Test

**Files:**
- Create: `packages/core/src/__tests__/template-integration.test.ts`

- [ ] **Step 1: Write integration test**

Tests:
- Loads real templates from projects/
- Instantiates a template with params
- Creates a task tree from instantiated template
- Validates template structure (zero errors)
- Template with forEach expands correctly
- Cron trigger registration works

- [ ] **Step 2: Run, fix, commit**

```bash
git commit -m "test: add integration test for unified task template system"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Build**: `npm run build`
- [ ] **Step 2: Test**: `npm test`
- [ ] **Step 3: Check**: `npm run check`
- [ ] **Step 4: Validate**: `npm run validate:library && npm run validate:projects`
- [ ] **Step 5: Commit any fixes**

```bash
git commit -m "feat: complete Phase 4 — unified task templates replacing pipelines"
```

---

## Summary

After completing all 10 tasks:

- **Unified template schema**: params, triggers (cron/event/manual), 7 task types, forEach, runIf
- **Template registry**: loads from project hierarchy with inheritance
- **Template instantiator**: `{{ }}` interpolation, param resolution, forEach expansion
- **Template scheduler**: cron + event triggers (replaces pipeline-scheduler)
- **API endpoints**: list, get, trigger templates
- **Migrated pipelines**: morning-briefing + system-maintenance converted
- **Validation**: templates validated as part of project validation
- **Pipeline engine preserved**: existing pipelines continue working until fully migrated

**Next plan**: Phase 5 — Permissions & Bash Access (graduated access levels with code-level enforcement)
