# Control Center — Plan 1b: Template-Kind Schedules + Tree Stamping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the schedule engine to fire `template`-kind schedules — instantiating a template into a TaskTree stamped with its `scheduleId` so it shows on the board as a `scheduled` grouped task — and migrate the `morning-digest` schedule off the legacy path to prove it.

**Architecture:** Add a `schedule_id` column to `task_trees` and thread it through `CreateTreeOptions`/`TaskTree`/row-mapping. Extend the template engine's existing `triggerTemplate` to accept `{ params, scheduleId, projectId }` and stamp the tree. Give the schedule engine a `fireTemplate` dep; on a `template`-kind schedule fire it calls `fireTemplate(def.run.ref, { scheduleId: def.name, params })` (the tree is the board-visible item — no separate RavenTask). Write a `morning-digest` template and point its schedule YAML at `run:{kind:template}`, removing the legacy DB row + both seed sources.

**Tech Stack:** TypeScript ESM, better-sqlite3, croner, Vitest (node env). Core conventions: `.ts` import extensions, `import type`, `createLogger`, `explicit-function-return-type`, `max-params: 3`.

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` § 1f. **Depends on Plan 1a** (schedule engine, `run:{kind,ref}` schema, JobRegistry — all merged).

**Conventions / baseline:** one command per line (no `&&`/`;`); migrations `migrations/NNN-*.sql` (latest is `026-drop-migrated-schedules.sql`, so next free numbers are **027**, **028**); pre-existing baseline failures (`config-history`, `template-integration`, `template-scheduler`, plus the knowledge-*/task-execution-engine flakes) are not ours.

**Verified facts:**
- `executionEngine.createTree(opts: { id; projectId?; plan?; tasks })` inserts into `task_trees (id, project_id, status, plan, created_at, updated_at)`; `rowToTaskTree(treeRow, taskRows)` maps it back. No `scheduleId` anywhere yet. `startTree(id)` sets status running + processes ready tasks.
- The template engine factory `createTemplateScheduler(...)` returns `{ start, stop, triggerTemplate }`; internally `triggerFromTemplate(template, params)` does instantiate → id-prefix (to avoid UNIQUE clashes on re-trigger) → `createTree` → `startTree` if `approval==='auto'`. **Reuse this — do not reimplement the id-prefixing.**
- `morning-digest` is seeded from BOTH `config/schedules.json` AND `suites/daily-briefing/schedules.json` (via `suiteRegistry.collectSchedules()`), so both must be removed or it re-seeds on boot. Its YAML `projects/schedules/morning-digest.yaml` currently uses legacy `template: morning-digest` (normalized to `run:{kind:template,ref:morning-digest}` by Plan 1a's schema) — but the template doesn't exist yet.
- `projects/templates/morning-briefing.yaml` is the closest existing template (gmail→ticktick→digest→telegram) and is the model for `morning-digest`.
- The schedule engine (Plan 1a) currently registers only `kind==='job'` and skips others with a log.

---

### Task 1: Add `schedule_id` to task trees (migration + types + engine threading)

**Files:**
- Create: `migrations/027-task-tree-schedule-id.sql`
- Modify: `packages/shared/src/types/task-execution.ts` (`TaskTree`)
- Modify: `packages/core/src/task-execution/task-execution-engine.ts` (`CreateTreeOptions`, `TaskTreeRow`, INSERT, `rowToTaskTree`)
- Test: `packages/core/src/__tests__/task-tree-schedule-id.test.ts` (new)

- [ ] **Step 1: Write the migration**

Create `migrations/027-task-tree-schedule-id.sql`:

```sql
-- Stamp the schedule that produced a tree, for run-history + the `scheduled` board badge.
ALTER TABLE task_trees ADD COLUMN schedule_id TEXT;
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/__tests__/task-tree-schedule-id.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../db/database.ts';
import { runMigrations } from '../db/migrations.ts';
import { createTaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import { EventBus } from '../event-bus/event-bus.ts';

describe('task_trees schedule_id stamping', () => {
  let dir: string;
  let engine: ReturnType<typeof createTaskExecutionEngine>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-tree-sched-'));
    const db = createDatabase(join(dir, 'test.db'));
    runMigrations(db);
    engine = createTaskExecutionEngine({ db, eventBus: new EventBus() });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists scheduleId on createTree and reads it back', () => {
    const tree = engine.createTree({
      id: 'tree-1',
      scheduleId: 'morning-digest',
      plan: 'p',
      tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
    });
    expect(tree.scheduleId).toBe('morning-digest');

    const reloaded = engine.getTree('tree-1');
    expect(reloaded?.scheduleId).toBe('morning-digest');
  });

  it('leaves scheduleId undefined when not provided', () => {
    const tree = engine.createTree({
      id: 'tree-2',
      tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
    });
    expect(tree.scheduleId).toBeUndefined();
  });
});
```

Before running, confirm the real construction/util names used above:
Run: `grep -n "export function createTaskExecutionEngine\|createDatabase\|runMigrations\|getTree\b" packages/core/src/task-execution/task-execution-engine.ts packages/core/src/db/database.ts packages/core/src/db/migrations.ts`
If the engine factory, `createDatabase`, `runMigrations`, or a tree getter are named differently, adjust the test imports/usage to the real names (e.g. the getter may be `getTree`/`loadTree`/`getTreeById`). The behavioral assertions stay the same.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/task-tree-schedule-id.test.ts`
Expected: FAIL — `createTree` rejects/ignores `scheduleId` and `tree.scheduleId` is undefined (type error or runtime undefined).

- [ ] **Step 4: Add `scheduleId` to the `TaskTree` type**

In `packages/shared/src/types/task-execution.ts`, in the `TaskTree` interface add the field after `projectId?: string;`:

```ts
  scheduleId?: string;
```

- [ ] **Step 5: Thread it through the engine**

In `packages/core/src/task-execution/task-execution-engine.ts`:

(a) Add to `CreateTreeOptions` (after `projectId?: string;`):

```ts
  scheduleId?: string;
```

(b) Add to the `TaskTreeRow` interface (after `project_id: string | null;`):

```ts
  schedule_id: string | null;
```

(c) Update the `createTree` INSERT to include the column. Replace:

```ts
  this.db.run(
    `INSERT INTO task_trees (id, project_id, status, plan, created_at, updated_at)
     VALUES (?, ?, 'pending_approval', ?, ?, ?)`,
    opts.id,
    opts.projectId ?? null,
    opts.plan ?? null,
    now,
    now,
  );
```

with:

```ts
  this.db.run(
    `INSERT INTO task_trees (id, project_id, schedule_id, status, plan, created_at, updated_at)
     VALUES (?, ?, ?, 'pending_approval', ?, ?, ?)`,
    opts.id,
    opts.projectId ?? null,
    opts.scheduleId ?? null,
    opts.plan ?? null,
    now,
    now,
  );
```

(d) In the in-memory `tree` object built by `createTree`, add (next to the `projectId` conditional spread):

```ts
    ...(opts.scheduleId !== undefined && { scheduleId: opts.scheduleId }),
```

(e) In `rowToTaskTree`, add (next to the `projectId` conditional spread):

```ts
    ...(treeRow.schedule_id !== null && { scheduleId: treeRow.schedule_id }),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/task-tree-schedule-id.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add migrations/027-task-tree-schedule-id.sql packages/shared/src/types/task-execution.ts packages/core/src/task-execution/task-execution-engine.ts packages/core/src/__tests__/task-tree-schedule-id.test.ts
```
```bash
git commit -m "feat(schedules): add schedule_id to task_trees, thread through createTree + rowToTaskTree"
```

---

### Task 2: Extend `triggerTemplate` to stamp `scheduleId`

**Files:**
- Modify: `packages/core/src/template-engine/template-scheduler.ts` (`triggerFromTemplate` + `triggerTemplate`)
- Test: `packages/core/src/__tests__/template-trigger-scheduleid.test.ts` (new)

- [ ] **Step 1: Confirm the current `triggerTemplate` signature**

Run: `grep -n "triggerTemplate\|triggerFromTemplate\|function start\|return {" packages/core/src/template-engine/template-scheduler.ts`

You should find an internal `triggerFromTemplate(template, params)` and a returned `triggerTemplate(name, params?)` that looks up the template by name and calls `triggerFromTemplate`. Confirm the exact param shapes before editing.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/__tests__/template-trigger-scheduleid.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTemplateScheduler } from '../template-engine/template-scheduler.ts';
import type { TaskTemplate } from '@raven/shared';

const template: TaskTemplate = {
  name: 'morning-digest',
  displayName: 'Morning Digest',
  description: 'digest',
  params: {},
  trigger: [{ type: 'manual' }],
  plan: { approval: 'auto', parallel: true },
  tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
} as TaskTemplate;

function deps() {
  const createTree = vi.fn();
  const startTree = vi.fn().mockResolvedValue(undefined);
  return {
    templateRegistry: { getTemplate: vi.fn().mockReturnValue(template), getAllTemplates: () => [] },
    executionEngine: { createTree, startTree },
    eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    _createTree: createTree,
  };
}

describe('triggerTemplate scheduleId stamping', () => {
  it('passes scheduleId through to createTree', () => {
    const d = deps();
    const scheduler = createTemplateScheduler(d as any);
    scheduler.triggerTemplate('morning-digest', { scheduleId: 'morning-digest' });

    expect(d._createTree).toHaveBeenCalledTimes(1);
    const arg = d._createTree.mock.calls[0][0];
    expect(arg.scheduleId).toBe('morning-digest');
    expect(Array.isArray(arg.tasks)).toBe(true);
  });

  it('works with no options (back-compat, no scheduleId)', () => {
    const d = deps();
    const scheduler = createTemplateScheduler(d as any);
    scheduler.triggerTemplate('morning-digest');
    const arg = d._createTree.mock.calls[0][0];
    expect(arg.scheduleId).toBeUndefined();
  });
});
```

Note: this test mirrors the deps `createTemplateScheduler` expects (`templateRegistry`, `executionEngine`, `eventBus`). If the real factory needs more deps, add them as `vi.fn()` stubs — only `createTree`/`startTree`/`getTemplate` behavior is asserted.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/template-trigger-scheduleid.test.ts`
Expected: FAIL — `createTree` is called without `scheduleId` (arg.scheduleId undefined in the first test).

- [ ] **Step 4: Thread `scheduleId` through the trigger path**

In `packages/core/src/template-engine/template-scheduler.ts`:

(a) Change `triggerFromTemplate` to accept an options object instead of bare params. Replace its signature and the `createTree` call. The current shape is:

```ts
function triggerFromTemplate(template: TaskTemplate, params: Record<string, unknown>): string {
  const treeId = generateId();
  const { nodes, errors } = instantiateTemplate(template, params);
  // ... id-prefixing (KEEP AS-IS) ...
  executionEngine.createTree({
    id: treeId,
    plan: template.description,
    tasks: nodes,
  });
  if (template.plan.approval === 'auto') {
    executionEngine.startTree(treeId).catch(/* ... */);
  }
  // ... logging ...
  return treeId;
}
```

Change it to:

```ts
interface TriggerOptions {
  params?: Record<string, unknown>;
  scheduleId?: string;
  projectId?: string;
}

function triggerFromTemplate(template: TaskTemplate, options: TriggerOptions = {}): string {
  const treeId = generateId();
  const { nodes, errors } = instantiateTemplate(template, options.params ?? {});
  // ... id-prefixing (KEEP EXACTLY AS-IS) ...
  executionEngine.createTree({
    id: treeId,
    plan: template.description,
    tasks: nodes,
    ...(options.scheduleId !== undefined && { scheduleId: options.scheduleId }),
    ...(options.projectId !== undefined && { projectId: options.projectId }),
  });
  if (template.plan.approval === 'auto') {
    executionEngine.startTree(treeId).catch((err: unknown) => {
      logger.error(`Failed to auto-start tree ${treeId}: ${err}`);
    });
  }
  // ... logging (KEEP) ...
  return treeId;
}
```

(b) Update the internal callers of `triggerFromTemplate`:
- The cron loop in `start()`: `triggerFromTemplate(template, {})` → `triggerFromTemplate(template, {})` (no change needed; default applies). If it passed params, wrap as `{ params }`.
- The event handler in `start()`: `triggerFromTemplate(template, { event })` → `triggerFromTemplate(template, { params: { event } })`.

(c) Update the public `triggerTemplate` to accept and forward options. Find the returned `triggerTemplate` (it looks up the template by name then calls `triggerFromTemplate`). Change its signature to:

```ts
function triggerTemplate(name: string, options: TriggerOptions = {}): string {
  const template = templateRegistry.getTemplate(name);
  if (!template) throw new Error(`Template not found: ${name}`);
  return triggerFromTemplate(template, options);
}
```

(Match the real existing body — keep any projectId lookup it already does; just thread `options` through instead of `params`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/template-trigger-scheduleid.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the existing template-scheduler test (it's a baseline-failing file — confirm no NEW breakage)**

Run: `npx vitest run packages/core/src/__tests__/template-scheduler.test.ts`
Expected: the same pre-existing failure(s) as baseline (the `triggerTemplate()` test that checks `createTree` args via `objectContaining`). If your change altered the call shape, update that test's `objectContaining` to still pass (it should — you only ADDED optional fields). Do not introduce new failures beyond the documented baseline.

- [ ] **Step 7: Build + commit**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

```bash
git add packages/core/src/template-engine/template-scheduler.ts packages/core/src/__tests__/template-trigger-scheduleid.test.ts
```
```bash
git commit -m "feat(schedules): triggerTemplate accepts {params,scheduleId,projectId}, stamps tree"
```

---

### Task 3: Schedule engine fires `template`-kind schedules

**Files:**
- Modify: `packages/core/src/scheduler/schedule-engine.ts`
- Test: `packages/core/src/__tests__/schedule-engine-template.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/schedule-engine-template.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runScheduledTemplate } from '../scheduler/schedule-engine.ts';
import type { ScheduleYaml } from '@raven/shared';

const tplDef: ScheduleYaml = {
  name: 'morning-digest',
  cron: '0 8 * * *',
  timezone: 'UTC',
  enabled: true,
  params: { foo: 'bar' },
  run: { kind: 'template', ref: 'morning-digest' },
};

describe('runScheduledTemplate', () => {
  it('fires the template with scheduleId + params', async () => {
    const fireTemplate = vi.fn().mockReturnValue('tree-xyz');
    await runScheduledTemplate(tplDef, { fireTemplate });
    expect(fireTemplate).toHaveBeenCalledWith('morning-digest', {
      scheduleId: 'morning-digest',
      params: { foo: 'bar' },
    });
  });

  it('does not throw when fireTemplate rejects (logs instead)', async () => {
    const fireTemplate = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runScheduledTemplate(tplDef, { fireTemplate })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine-template.test.ts`
Expected: FAIL — `runScheduledTemplate` is not exported.

- [ ] **Step 3: Add template dispatch to the engine**

In `packages/core/src/scheduler/schedule-engine.ts`:

(a) Add a `fireTemplate` type and extend the deps. Near the top (after the `TaskStoreLike` interface), add:

```ts
export type FireTemplate = (
  ref: string,
  options: { scheduleId: string; params?: Record<string, unknown> },
) => string | Promise<string>;
```

(b) Add `runScheduledTemplate` (exported, beside `runScheduledJob`):

```ts
export interface RunTemplateDeps {
  fireTemplate: FireTemplate;
}

/** Fire a template-kind schedule. The resulting tree is the board-visible, scheduleId-stamped item. */
export async function runScheduledTemplate(def: ScheduleYaml, deps: RunTemplateDeps): Promise<void> {
  try {
    const treeId = await deps.fireTemplate(def.run.ref, {
      scheduleId: def.name,
      params: def.params ?? {},
    });
    log.info(`Schedule "${def.name}" fired template "${def.run.ref}" → tree ${treeId}`);
  } catch (err) {
    log.error(`Schedule "${def.name}" template fire failed: ${String(err)}`);
  }
}
```

(c) Extend `ScheduleEngineDeps` to carry the optional `fireTemplate`:

```ts
export interface ScheduleEngineDeps {
  schedules: ScheduleYaml[];
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
  timezone: string;
  fireTemplate?: FireTemplate;
}
```

(d) In `createScheduleEngine`'s `start()` (or its per-def registration helper), handle the `template` kind. Where it currently skips non-`job` kinds, change the dispatch so `job` and `template` both register crons. Replace the per-def guard logic with:

```ts
      if (def.enabled === false) {
        log.info(`Schedule "${def.name}" disabled — not registered`);
        continue;
      }
      if (def.run.kind === 'job') {
        const job = new Cron(def.cron, { timezone: def.timezone }, () => {
          runScheduledJob(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore }).catch(
            (err: unknown) => log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`),
          );
        });
        jobs.push(job);
        log.info(`Registered job schedule "${def.name}" (${def.cron}) → next ${job.nextRun()?.toISOString() ?? 'n/a'}`);
      } else if (def.run.kind === 'template') {
        if (!deps.fireTemplate) {
          log.warn(`Schedule "${def.name}" is template-kind but no fireTemplate dep — skipping`);
          continue;
        }
        const fireTemplate = deps.fireTemplate;
        const job = new Cron(def.cron, { timezone: def.timezone }, () => {
          runScheduledTemplate(def, { fireTemplate }).catch((err: unknown) =>
            log.error(`runScheduledTemplate(${def.name}) failed: ${String(err)}`),
          );
        });
        jobs.push(job);
        log.info(`Registered template schedule "${def.name}" (${def.cron}) → next ${job.nextRun()?.toISOString() ?? 'n/a'}`);
      } else {
        log.info(`Skipping schedule "${def.name}" (kind=${def.run.kind}) — handled elsewhere`);
      }
```

If `start()` would exceed the 50-line guardrail, keep the existing extracted per-def helper (e.g. `registerSchedule(def)`) and put this branching inside it.

- [ ] **Step 4: Run the new test + the Plan 1a engine test (no regression)**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine-template.test.ts packages/core/src/__tests__/schedule-engine.test.ts`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --max-warnings 0 packages/core/src/scheduler/schedule-engine.ts`
Expected: clean.

```bash
git add packages/core/src/scheduler/schedule-engine.ts packages/core/src/__tests__/schedule-engine-template.test.ts
```
```bash
git commit -m "feat(schedules): engine fires template-kind schedules (stamped tree via fireTemplate)"
```

---

### Task 4: morning-digest template + migrate the schedule + wire fireTemplate

**Files:**
- Create: `projects/templates/morning-digest.yaml`
- Modify: `projects/schedules/morning-digest.yaml`
- Modify: `config/schedules.json` (remove morning-digest)
- Modify: `suites/daily-briefing/schedules.json` (remove morning-digest)
- Create: `migrations/028-drop-morning-digest-schedule.sql`
- Modify: `packages/core/src/index.ts` (pass `fireTemplate` to the engine)

- [ ] **Step 1: Write the `morning-digest` template**

Create `projects/templates/morning-digest.yaml` (modeled on `morning-briefing.yaml`, but NO embedded `trigger` block — the cron lives in the schedule):

```yaml
name: morning-digest
displayName: Morning Digest
description: Compile and send the morning digest (tasks + emails)

plan:
  approval: auto
  parallel: true

tasks:
  - id: fetch-tasks
    type: agent
    title: Gather today's tasks
    agent: ticktick
    prompt: "Get all overdue tasks and tasks due today. List each with title, due date, and priority."
    blockedBy: []

  - id: fetch-emails
    type: agent
    title: Summarize recent emails
    agent: gmail
    prompt: "Summarize unread emails from the last 12 hours. Include sender, subject, and urgency (urgent/normal/low)."
    blockedBy: []

  - id: compile-digest
    type: agent
    title: Compile the digest
    agent: digest
    prompt: "Compile a concise morning digest from the gathered tasks and email summaries. Group by urgent emails, task reminders, and a prioritized action list for the day."
    blockedBy:
      - fetch-tasks
      - fetch-emails

  - id: send-digest
    type: notify
    title: Send digest via Telegram
    channel: telegram
    message: "Morning digest ready — check today's priorities."
    blockedBy:
      - compile-digest
```

Note: `trigger` is omitted; `TaskTemplateSchema` defaults it to `[{ type: 'manual' }]` — so this template will NOT self-schedule (no double-fire). Confirm the agent refs (`ticktick`, `gmail`, `digest`) match those used in `projects/templates/morning-briefing.yaml`; if morning-briefing uses different agent names, use the same ones.

- [ ] **Step 2: Point the schedule YAML at the template**

Overwrite `projects/schedules/morning-digest.yaml`:

```yaml
name: morning-digest
cron: "0 8 * * *"
timezone: UTC
enabled: true
run:
  kind: template
  ref: morning-digest
```

- [ ] **Step 3: Remove morning-digest from both legacy seed sources**

Edit `config/schedules.json` — delete the object with `"id": "morning-digest"`. Verify:
Run: `node -e "console.log(require('./config/schedules.json').map(s=>s.id))"`
Expected: `[ 'autonomous-task-management', 'ticktick-task-sync', 'system-maintenance' ]`

Edit `suites/daily-briefing/schedules.json` — remove the `morning-digest` entry (the file may become `[]`; keep it valid JSON). Confirm:
Run: `cat suites/daily-briefing/schedules.json`

- [ ] **Step 4: Migration to delete the persisted legacy row**

Create `migrations/028-drop-morning-digest-schedule.sql`:

```sql
-- morning-digest now fires via the unified schedule engine (template kind). Remove the
-- legacy DB row so the legacy Scheduler no longer fires it (prevents double-firing).
DELETE FROM schedules WHERE id = 'morning-digest';
```

- [ ] **Step 5: Wire `fireTemplate` into the engine at boot**

In `packages/core/src/index.ts`, the `templateScheduler` is created around line 292 (`createTemplateScheduler({...})`) and the schedule engine around line 514 (`createScheduleEngine({...})`). The engine is constructed AFTER the template scheduler, so `templateScheduler.triggerTemplate` is in scope. Add `fireTemplate` to the `createScheduleEngine({...})` deps object:

```ts
    fireTemplate: (ref, options) => templateScheduler.triggerTemplate(ref, options),
```

Confirm the template scheduler variable name first:
Run: `grep -n "createTemplateScheduler\|templateScheduler" packages/core/src/index.ts`
Use the real variable name (expected `templateScheduler`). If the schedule engine is constructed BEFORE the template scheduler, move the `createScheduleEngine(...)` block to after `templateScheduler` is created (both must be after their own deps; `templateScheduler` only needs templateRegistry + executionEngine + eventBus, all available early).

- [ ] **Step 6: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add projects/templates/morning-digest.yaml projects/schedules/morning-digest.yaml config/schedules.json suites/daily-briefing/schedules.json migrations/028-drop-morning-digest-schedule.sql packages/core/src/index.ts
```
```bash
git commit -m "feat(schedules): migrate morning-digest to a template-kind schedule, retire its legacy row"
```

---

### Task 5: Full verification

- [ ] **Step 1: New + adjacent tests**

Run: `npx vitest run packages/core/src/__tests__/task-tree-schedule-id.test.ts packages/core/src/__tests__/template-trigger-scheduleid.test.ts packages/core/src/__tests__/schedule-engine-template.test.ts packages/core/src/__tests__/schedule-engine.test.ts packages/core/src/__tests__/job-registry.test.ts`
Expected: all PASS.

- [ ] **Step 2: Full suite vs baseline**

Run: `npm test`
Expected: only the documented baseline failures (`config-history`, `template-integration`, `template-scheduler`, plus knowledge-*/task-execution-engine flakes) — zero NEW failures.

- [ ] **Step 3: Template validation (morning-digest must be a valid template)**

Run: `npm run validate:library`
Expected: passes (or the same pre-existing template-validation state). If it flags `morning-digest`, fix the template to satisfy the validator (compare against `morning-briefing.yaml` which already validates). Note: `template-integration.test.ts` "validates all templates pass project validation" is baseline-failing — confirm your new template does not ADD a failure (run `npx vitest run packages/core/src/__tests__/template-integration.test.ts` and compare the failing assertions before/after).

- [ ] **Step 4: Lint/format + build**

Run: `npm run check`
Expected: our new/changed files clean (baseline lint debt elsewhere is not ours).

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 5: Boot smoke — morning-digest registers as template, no double-fire**

Run: `RAVEN_PORT=4013 timeout 30 node packages/core/dist/index.js > /tmp/raven-1b.log 2>&1`
Then:
Run: `grep -iE "Registered template schedule|Registered job schedule|fired template|migrat.*028|Skipping schedule" /tmp/raven-1b.log`
Expected: `Registered template schedule "morning-digest" (0 8 * * *)`; the 3 job schedules from 1a still register; migration 028 applied. The legacy `Registered: Morning Digest` line is absent.

- [ ] **Step 6: Confirm legacy morning-digest row gone**

Run: `node -e "const db=require('better-sqlite3')('data/raven.db'); console.log(db.prepare('SELECT id FROM schedules ORDER BY id').all().map(r=>r.id)); db.close();"`
Expected: does NOT contain `morning-digest` (remaining: `autonomous-task-management`, `pattern-analysis`, `system-maintenance`, `ticktick-task-sync`).

- [ ] **Step 7: Push**

```bash
git push
```

---

## Follow-up — Plans 1c & 1d (NOT in this plan)

- **Plan 1c — services + system-maintenance → jobs:** extract `runSync` (ticktick-sync), `runAutonomousManagement` (autonomous-manager), and the data-collector snapshot+emit into Job-Registry job handlers; register them (with eventBus/db/agentManager deps); point `projects/schedules/{ticktick-task-sync,autonomous-task-management,pattern-analysis}.yaml` at `run:{kind:job}`; remove those services' `schedule:triggered` listeners; add a `system-maintenance` job that emits the `agent:task:request {actionName:'maintenance:run'}` the maintenance-runner expects (it's currently orphaned); migration to delete the remaining legacy rows + remove from `suites/proactive-intelligence/schedules.json`. After this the legacy `Scheduler` fires nothing.
- **Plan 1d — retire legacy + unified API:** delete the `Scheduler` class and `ApiDeps.scheduler`; replace `getActiveJobCount`/`getUpcomingRuns` (health, dashboard routes) with engine-backed equivalents; rebuild `GET /api/schedules` (unified: YAML defs + computed next-run + preferences-backed `enabled`), `PATCH /api/schedules/:id {enabled}` (a `setEnabled` that starts/stops the cron + persists to the `preferences` table keyed `schedule:enabled:<name>`), `POST /api/schedules/:id/trigger` (run-now via engine); remove embedded `schedule` triggers from `morning-briefing.yaml` + `system-maintenance.yaml` and the template-scheduler cron loop; remove `orchestrator.handleSchedule` + its dead knowledge cases; update the web `Schedule` type + client; add `?scheduleId=` filter on the task/tree list endpoints for run-history.
