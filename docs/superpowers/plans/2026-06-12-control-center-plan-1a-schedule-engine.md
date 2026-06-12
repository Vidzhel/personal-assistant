# Control Center — Plan 1a: Schedule Engine + Job Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a unified schedule engine where a schedule is `cron + a polymorphic handler`, with a Job Registry for code/service handlers, proven end-to-end by migrating the 3 pure-code jobs (task-archival, knowledge-retrospective, knowledge-consolidation) off the legacy DB scheduler — each fire producing a board-visible RavenTask stamped with its `scheduleId`.

**Architecture:** A new `schedule-engine` loads schedule definitions (`projects/schedules/*.yaml`, now `cron + run:{kind,ref}`), registers crons (croner), and on each fire of a `kind: 'job'` schedule creates a `source: 'scheduled'` RavenTask (in_progress → completed/blocked) and invokes the handler registered in a new `JobRegistry`. The 3 migrated schedules are deleted from the legacy `schedules` table (migration) and from `config/schedules.json`, and their old inline listener is removed — so the legacy path no longer fires them (no double-fire). Template/agent handler kinds are recognized but deferred to Plan 1b.

**Tech Stack:** TypeScript ESM, Zod, croner, better-sqlite3, Vitest (node env). Core package conventions: `.ts` import extensions, `import type`, `createLogger` (no console), `explicit-function-return-type`, `max-params: 3`, `crypto.randomUUID` via `generateId`.

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` § 1f (Plans 1a + 1b).

**Conventions / guardrails (verified):**
- Core/shared imports use **`.ts` extensions** and `import type` for type-only imports (unlike the web package).
- `no-console` — use `createLogger('name')`. `explicit-function-return-type` is an error. `max-params: 3` (use a deps object). Test files (`__tests__/**`) have relaxed rules.
- Run commands one per line — **no chained `&&`/`;`**.
- Migrations live in `migrations/NNN-*.sql`, auto-applied on boot; the latest is `025-drop-named-agents.sql`, so the next is **026**.
- Build: `npm run build -w packages/shared -w packages/core`. Tests: `npx vitest run <path>`. Gate: `npm run check`.
- Pre-existing failing suites (knowledge-*, config-history, template-integration, template-scheduler, task-execution-engine) are the **baseline** — compare against that set; do not fix them here.

**Verified facts the plan relies on:**
- `tasks` table already has `schedule_id` (migration 015); `task_trees` does **not** (not needed in 1a — jobs produce RavenTasks).
- The 8 legacy schedules are seeded from `config/schedules.json` (+ suite `schedules.json`) into the `schedules` DB table; `Scheduler.initialize` only **inserts when missing** and loads `WHERE enabled = 1`, so rows from prior boots **persist** — they must be deleted via migration to stop firing.
- `code` execution-engine nodes run `execFileAsync(script, args)` (an external binary) — they cannot call internal functions, which is why these jobs are Job-Registry jobs, not templates.

---

### Task 1: Schedule definition schema (`run: {kind, ref}`) + `scheduled` task source

**Files:**
- Modify: `packages/shared/src/project/schemas.ts` (`ScheduleYamlSchema`)
- Modify: `packages/shared/src/types/tasks.ts` (`TaskSourceValues`)
- Test: `packages/shared/src/__tests__/schedule-yaml.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/schedule-yaml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ScheduleYamlSchema } from '../project/schemas.ts';

describe('ScheduleYamlSchema', () => {
  it('parses the new run:{kind,ref} shape', () => {
    const s = ScheduleYamlSchema.parse({
      name: 'task-archival',
      cron: '0 * * * *',
      run: { kind: 'job', ref: 'task-archival' },
    });
    expect(s.run).toEqual({ kind: 'job', ref: 'task-archival' });
    expect(s.timezone).toBe('UTC');
    expect(s.enabled).toBe(true);
  });

  it('normalizes the legacy template: field into run', () => {
    const s = ScheduleYamlSchema.parse({
      name: 'morning-digest',
      cron: '0 8 * * *',
      template: 'morning-digest',
    });
    expect(s.run).toEqual({ kind: 'template', ref: 'morning-digest' });
  });

  it('rejects a def with neither run nor template', () => {
    expect(() => ScheduleYamlSchema.parse({ name: 'x', cron: '0 0 * * *' })).toThrow();
  });

  it('rejects an unknown run kind', () => {
    expect(() =>
      ScheduleYamlSchema.parse({ name: 'x', cron: '0 0 * * *', run: { kind: 'nope', ref: 'y' } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/schedule-yaml.test.ts`
Expected: FAIL — `s.run` is undefined (schema has no `run` yet).

- [ ] **Step 3: Update `ScheduleYamlSchema`**

In `packages/shared/src/project/schemas.ts`, replace the existing `ScheduleYamlSchema` (currently:)

```ts
export const ScheduleYamlSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'Schedule name must be lowercase kebab-case'),
  cron: z.string().min(1),
  timezone: z.string().default('UTC'),
  template: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});
```

with:

```ts
export const ScheduleRunSchema = z.object({
  kind: z.enum(['template', 'job', 'agent']),
  ref: z.string().min(1),
});

export const ScheduleYamlSchema = z
  .object({
    name: z.string().regex(KEBAB_CASE_RE, 'Schedule name must be lowercase kebab-case'),
    cron: z.string().min(1),
    timezone: z.string().default('UTC'),
    enabled: z.boolean().default(true),
    params: z.record(z.string(), z.unknown()).optional(),
    run: ScheduleRunSchema.optional(),
    // Legacy: a bare template reference, normalized into `run` below.
    template: z.string().min(1).optional(),
  })
  .refine((s) => s.run !== undefined || s.template !== undefined, {
    message: 'schedule must define either run:{kind,ref} or a legacy template:',
  })
  .transform((s) => ({
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    params: s.params,
    run: s.run ?? { kind: 'template' as const, ref: s.template as string },
  }));
```

- [ ] **Step 4: Add the `scheduled` task source**

In `packages/shared/src/types/tasks.ts`, change:

```ts
export const TaskSourceValues = ['manual', 'agent', 'template', 'ticktick', 'pipeline'] as const;
```

to:

```ts
export const TaskSourceValues = [
  'manual',
  'agent',
  'template',
  'ticktick',
  'pipeline',
  'scheduled',
] as const;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/shared/src/__tests__/schedule-yaml.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Rebuild shared so core sees the new types**

Run: `npm run build -w packages/shared`
Expected: clean compile.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/schemas.ts packages/shared/src/types/tasks.ts packages/shared/src/__tests__/schedule-yaml.test.ts
```
```bash
git commit -m "feat(schedules): schedule run:{kind,ref} schema (legacy template back-compat) + scheduled task source"
```

---

### Task 2: Job Registry

**Files:**
- Create: `packages/core/src/scheduler/job-registry.ts`
- Test: `packages/core/src/__tests__/job-registry.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/job-registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createJobRegistry } from '../scheduler/job-registry.ts';

describe('JobRegistry', () => {
  it('registers, finds, lists, and runs handlers', async () => {
    const reg = createJobRegistry();
    const handler = vi.fn().mockResolvedValue({ summary: 'done' });
    reg.register('job-a', handler);

    expect(reg.has('job-a')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.list()).toEqual(['job-a']);

    const found = reg.get('job-a');
    expect(found).toBeDefined();
    const result = await found!({ scheduleName: 's', params: {} });
    expect(result.summary).toBe('done');
    expect(handler).toHaveBeenCalledWith({ scheduleName: 's', params: {} });
  });

  it('throws on duplicate registration', () => {
    const reg = createJobRegistry();
    reg.register('dup', async () => ({}));
    expect(() => reg.register('dup', async () => ({}))).toThrow(/already registered/);
  });

  it('returns undefined for unknown jobs', () => {
    expect(createJobRegistry().get('ghost')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/job-registry.test.ts`
Expected: FAIL — module `../scheduler/job-registry.ts` does not exist.

- [ ] **Step 3: Implement the Job Registry**

Create `packages/core/src/scheduler/job-registry.ts`:

```ts
import { createLogger } from '@raven/shared';

const log = createLogger('job-registry');

export interface JobContext {
  scheduleName: string;
  params: Record<string, unknown>;
}

export interface JobResult {
  summary?: string;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export interface JobRegistry {
  register(id: string, handler: JobHandler): void;
  has(id: string): boolean;
  get(id: string): JobHandler | undefined;
  list(): string[];
}

export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, JobHandler>();
  return {
    register(id: string, handler: JobHandler): void {
      if (jobs.has(id)) {
        throw new Error(`job already registered: ${id}`);
      }
      jobs.set(id, handler);
      log.info(`Registered job: ${id}`);
    },
    has: (id: string): boolean => jobs.has(id),
    get: (id: string): JobHandler | undefined => jobs.get(id),
    list: (): string[] => [...jobs.keys()],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/job-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/job-registry.ts packages/core/src/__tests__/job-registry.test.ts
```
```bash
git commit -m "feat(schedules): add JobRegistry for code/service schedule handlers"
```

---

### Task 3: Schedule engine (dispatch + stamped task per fire)

**Files:**
- Create: `packages/core/src/scheduler/schedule-engine.ts`
- Test: `packages/core/src/__tests__/schedule-engine.test.ts` (new)

The engine exposes a unit-testable `runScheduledJob(def, deps)` (creates a stamped RavenTask, runs the handler, sets final status) plus a `createScheduleEngine` factory that registers crons for `kind: 'job'` schedules.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/schedule-engine.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runScheduledJob } from '../scheduler/schedule-engine.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import type { ScheduleYaml } from '@raven/shared';

function fakeTaskStore() {
  const calls: Array<{ kind: string; arg: any }> = [];
  return {
    calls,
    createTask: vi.fn((input: any) => {
      calls.push({ kind: 'create', arg: input });
      return { id: 'task-1', ...input };
    }),
    updateTask: vi.fn((id: string, patch: any) => {
      calls.push({ kind: 'update', arg: { id, patch } });
      return { id, ...patch };
    }),
  };
}

const jobDef: ScheduleYaml = {
  name: 'task-archival',
  cron: '0 * * * *',
  timezone: 'UTC',
  enabled: true,
  params: {},
  run: { kind: 'job', ref: 'task-archival' },
};

describe('runScheduledJob', () => {
  it('creates a scheduled task, runs the handler, marks it completed', async () => {
    const reg = createJobRegistry();
    reg.register('task-archival', async () => ({ summary: 'archived 3' }));
    const taskStore = fakeTaskStore();

    await runScheduledJob(jobDef, { jobRegistry: reg, taskStore: taskStore as any });

    const create = taskStore.calls.find((c) => c.kind === 'create');
    expect(create?.arg.source).toBe('scheduled');
    expect(create?.arg.scheduleId).toBe('task-archival');
    expect(create?.arg.status).toBe('in_progress');

    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('completed');
  });

  it('marks the task blocked when the handler throws', async () => {
    const reg = createJobRegistry();
    reg.register('task-archival', async () => {
      throw new Error('boom');
    });
    const taskStore = fakeTaskStore();

    await runScheduledJob(jobDef, { jobRegistry: reg, taskStore: taskStore as any });

    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('blocked');
  });

  it('marks the task blocked when no handler is registered', async () => {
    const taskStore = fakeTaskStore();
    await runScheduledJob(jobDef, { jobRegistry: createJobRegistry(), taskStore: taskStore as any });
    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine.test.ts`
Expected: FAIL — module `../scheduler/schedule-engine.ts` does not exist.

- [ ] **Step 3: Implement the engine**

First confirm the task-store update method name and input type:

Run: `grep -n "updateTask\|TaskUpdateInput\|createTask\|TaskCreateInput" packages/core/src/task-manager/task-store.ts | head`

Expected: an `updateTask(id, input: TaskUpdateInput)` method and a `createTask(input: TaskCreateInput)` method. Use those exact names in the `TaskStoreLike` interface below (adjust if the grep shows different names).

Create `packages/core/src/scheduler/schedule-engine.ts`:

```ts
import { Cron } from 'croner';
import { createLogger, type ScheduleYaml, type RavenTask } from '@raven/shared';
import type { JobRegistry } from './job-registry.ts';

const log = createLogger('schedule-engine');

/** The slice of the task store the engine needs. */
export interface TaskStoreLike {
  createTask(input: {
    title: string;
    source: 'scheduled';
    scheduleId: string;
    status: 'in_progress';
    prompt?: string;
  }): RavenTask;
  updateTask(
    id: string,
    patch: { status: 'completed' | 'blocked'; description?: string },
  ): RavenTask;
}

export interface RunJobDeps {
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
}

/** Create a stamped RavenTask for one schedule fire, run its job handler, set final status. */
export async function runScheduledJob(def: ScheduleYaml, deps: RunJobDeps): Promise<void> {
  const task = deps.taskStore.createTask({
    title: def.name,
    source: 'scheduled',
    scheduleId: def.name,
    status: 'in_progress',
    prompt: `Scheduled job: ${def.run.ref}`,
  });

  const handler = deps.jobRegistry.get(def.run.ref);
  if (!handler) {
    log.error(`No job registered for "${def.run.ref}" (schedule ${def.name})`);
    deps.taskStore.updateTask(task.id, {
      status: 'blocked',
      description: `No job handler registered: ${def.run.ref}`,
    });
    return;
  }

  try {
    const result = await handler({ scheduleName: def.name, params: def.params ?? {} });
    deps.taskStore.updateTask(task.id, {
      status: 'completed',
      ...(result.summary !== undefined && { description: result.summary }),
    });
    log.info(`Schedule "${def.name}" completed: ${result.summary ?? 'ok'}`);
  } catch (err) {
    log.error(`Schedule "${def.name}" failed: ${String(err)}`);
    deps.taskStore.updateTask(task.id, { status: 'blocked', description: String(err) });
  }
}

export interface ScheduleEngineDeps {
  schedules: ScheduleYaml[];
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
  timezone: string;
}

export interface ScheduleEngine {
  start(): void;
  stop(): void;
}

export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const jobs: Cron[] = [];

  function start(): void {
    for (const def of deps.schedules) {
      if (def.run.kind !== 'job') {
        log.info(`Skipping schedule "${def.name}" (kind=${def.run.kind}) — handled elsewhere until Plan 1b`);
        continue;
      }
      if (def.enabled === false) {
        log.info(`Schedule "${def.name}" disabled — not registered`);
        continue;
      }
      const job = new Cron(def.cron, { timezone: def.timezone }, () => {
        runScheduledJob(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore }).catch(
          (err: unknown) => log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`),
        );
      });
      jobs.push(job);
      log.info(`Registered job schedule "${def.name}" (${def.cron}) → next ${job.nextRun()?.toISOString() ?? 'n/a'}`);
    }
    log.info(`Schedule engine started with ${jobs.length} job schedules`);
  }

  function stop(): void {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('Schedule engine stopped');
  }

  return { start, stop };
}
```

Note: if Step 3's grep showed the update method takes a different shape (e.g. `completeTask(id)`), adjust `TaskStoreLike` and the two `updateTask` calls to match the real API; the test's `fakeTaskStore` mirrors `createTask`/`updateTask` and should be updated in lockstep if so.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/schedule-engine.ts packages/core/src/__tests__/schedule-engine.test.ts
```
```bash
git commit -m "feat(schedules): schedule engine — stamped task per fire, job dispatch, cron registration"
```

---

### Task 4: Register the 3 core jobs + rewrite their schedule YAMLs

**Files:**
- Create: `packages/core/src/scheduler/core-jobs.ts`
- Test: `packages/core/src/__tests__/core-jobs.test.ts` (new)
- Modify: `projects/schedules/task-archival.yaml`
- Modify: `projects/schedules/knowledge-retrospective.yaml`
- Modify: `projects/schedules/knowledge-consolidation.yaml`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/core-jobs.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerCoreJobs } from '../scheduler/core-jobs.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';

describe('registerCoreJobs', () => {
  it('registers the three pure-code jobs and wires their deps', async () => {
    const reg = createJobRegistry();
    const taskStore = { archiveCompletedTasks: vi.fn().mockReturnValue(3) };
    const retrospective = { runFullRetrospective: vi.fn().mockResolvedValue(undefined) };
    const knowledgeConsolidation = { runConsolidation: vi.fn().mockResolvedValue(undefined) };

    registerCoreJobs(reg, {
      taskStore: taskStore as any,
      retrospective: retrospective as any,
      knowledgeConsolidation: knowledgeConsolidation as any,
    });

    expect(reg.list().sort()).toEqual([
      'knowledge-consolidation',
      'knowledge-retrospective',
      'task-archival',
    ]);

    const archival = await reg.get('task-archival')!({ scheduleName: 'task-archival', params: {} });
    expect(taskStore.archiveCompletedTasks).toHaveBeenCalled();
    expect(archival.summary).toMatch(/3/);

    await reg.get('knowledge-retrospective')!({ scheduleName: 'k', params: {} });
    expect(retrospective.runFullRetrospective).toHaveBeenCalled();

    await reg.get('knowledge-consolidation')!({ scheduleName: 'k', params: {} });
    expect(knowledgeConsolidation.runConsolidation).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/core-jobs.test.ts`
Expected: FAIL — module `../scheduler/core-jobs.ts` does not exist.

- [ ] **Step 3: Implement `core-jobs.ts`**

First confirm the types backing retrospective/consolidation:

Run: `grep -n "export interface Retrospective\b\|runFullRetrospective\|export interface KnowledgeConsolidation\|runConsolidation" packages/core/src/knowledge-engine/retrospective.ts packages/core/src/knowledge-engine/knowledge-consolidation.ts`

Create `packages/core/src/scheduler/core-jobs.ts` (use the exact exported interface names the grep shows for the typed deps; they are `Retrospective` and `KnowledgeConsolidation`):

```ts
import type { JobRegistry } from './job-registry.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import type { KnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';

interface ArchiverLike {
  archiveCompletedTasks(): number;
}

export interface CoreJobDeps {
  taskStore: ArchiverLike;
  retrospective: Retrospective;
  knowledgeConsolidation: KnowledgeConsolidation;
}

export function registerCoreJobs(registry: JobRegistry, deps: CoreJobDeps): void {
  registry.register('task-archival', async () => {
    const count = deps.taskStore.archiveCompletedTasks();
    return { summary: `Archived ${count} completed tasks` };
  });

  registry.register('knowledge-retrospective', async () => {
    await deps.retrospective.runFullRetrospective();
    return { summary: 'Knowledge retrospective complete' };
  });

  registry.register('knowledge-consolidation', async () => {
    await deps.knowledgeConsolidation.runConsolidation();
    return { summary: 'Knowledge consolidation complete' };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/core-jobs.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Rewrite the 3 schedule YAMLs to the `run: {kind: job}` shape**

Overwrite `projects/schedules/task-archival.yaml`:

```yaml
name: task-archival
cron: "0 * * * *"
timezone: UTC
enabled: true
run:
  kind: job
  ref: task-archival
```

Overwrite `projects/schedules/knowledge-retrospective.yaml`:

```yaml
name: knowledge-retrospective
cron: "0 9 * * 1"
timezone: UTC
enabled: true
run:
  kind: job
  ref: knowledge-retrospective
```

Overwrite `projects/schedules/knowledge-consolidation.yaml`:

```yaml
name: knowledge-consolidation
cron: "0 3 * * 0"
timezone: UTC
enabled: true
run:
  kind: job
  ref: knowledge-consolidation
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduler/core-jobs.ts packages/core/src/__tests__/core-jobs.test.ts projects/schedules/task-archival.yaml projects/schedules/knowledge-retrospective.yaml projects/schedules/knowledge-consolidation.yaml
```
```bash
git commit -m "feat(schedules): register 3 pure-code jobs + point their schedule YAMLs at run:{kind:job}"
```

---

### Task 5: Boot wiring + retire the 3 legacy schedules

**Files:**
- Create: `migrations/026-drop-migrated-schedules.sql`
- Modify: `config/schedules.json` (remove the 3 migrated entries)
- Modify: `packages/core/src/index.ts` (construct engine + register jobs + start; remove the task-archival inline listener; add stop to shutdown)

- [ ] **Step 1: Add the migration that deletes the persisted legacy rows**

Create `migrations/026-drop-migrated-schedules.sql`:

```sql
-- These three schedules are now owned by the unified schedule engine
-- (projects/schedules/*.yaml with run:{kind:job}). Remove the legacy DB rows
-- so the legacy Scheduler no longer fires them (prevents double-firing).
DELETE FROM schedules WHERE id IN (
  'task-archival',
  'knowledge-retrospective',
  'knowledge-consolidation'
);
```

- [ ] **Step 2: Remove the 3 entries from `config/schedules.json`**

Edit `config/schedules.json` and delete the three objects whose `id` is `task-archival`, `knowledge-retrospective`, and `knowledge-consolidation`. The remaining array must keep: `morning-digest`, `autonomous-task-management`, `ticktick-task-sync`, `system-maintenance`. Ensure the JSON stays valid (no trailing commas).

- [ ] **Step 3: Check these ids aren't also seeded by a suite**

Run: `grep -rn "task-archival\|knowledge-retrospective\|knowledge-consolidation\|knowledge:retrospective" suites --include=schedules.json`

Expected: no matches (these are config-level, not suite-level). If any suite `schedules.json` lists them, remove those entries too and `git add` that file in Step 7.

- [ ] **Step 4: Remove the legacy task-archival inline listener**

In `packages/core/src/index.ts`, delete this block (currently around lines 229–238):

```ts
// 7g. Archival schedule handler
eventBus.on('schedule:triggered', (event: RavenEvent) => {
  if (event.type === 'schedule:triggered' && 'payload' in event) {
    const payload = event.payload as { scheduleName?: string };
    if (payload.scheduleName === 'Task Archival') {
      const count = taskStore.archiveCompletedTasks();
      if (count > 0) log.info(`Archived ${count} completed tasks`);
    }
  }
});
```

- [ ] **Step 5: Wire the schedule engine into boot**

In `packages/core/src/index.ts`, add imports near the other scheduler/knowledge imports:

```ts
import { createJobRegistry } from './scheduler/job-registry.ts';
import { registerCoreJobs } from './scheduler/core-jobs.ts';
import { createScheduleEngine } from './scheduler/schedule-engine.ts';
```

After `knowledgeConsolidation` is constructed (currently around line 513–518) — and after `retrospective` (≈490) and `taskStore` (early) already exist — add:

```ts
  // Unified schedule engine (job-kind schedules; template/agent kinds land in Plan 1b)
  const jobRegistry = createJobRegistry();
  registerCoreJobs(jobRegistry, { taskStore, retrospective, knowledgeConsolidation });
  const scheduleEngine = createScheduleEngine({
    schedules: projectRegistry.getGlobal().schedules,
    jobRegistry,
    taskStore,
    timezone: config.RAVEN_TIMEZONE,
  });
  scheduleEngine.start();
```

- [ ] **Step 6: Stop the engine on shutdown**

Find where the legacy scheduler is stopped:

Run: `grep -n "scheduler.shutdown\|\.shutdown()\|templateScheduler.stop\|gracefulShutdown\|SIGTERM" packages/core/src/index.ts`

In the same shutdown path that calls `scheduler.shutdown()` / `templateScheduler.stop()`, add (one line):

```ts
  scheduleEngine.stop();
```

- [ ] **Step 7: Build to verify wiring type-checks**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean compile.

- [ ] **Step 8: Commit**

```bash
git add migrations/026-drop-migrated-schedules.sql config/schedules.json packages/core/src/index.ts
```
```bash
git commit -m "feat(schedules): wire schedule engine in boot, retire 3 legacy schedules (migration + config + listener)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the new + adjacent tests**

Run: `npx vitest run packages/shared/src/__tests__/schedule-yaml.test.ts packages/core/src/__tests__/job-registry.test.ts packages/core/src/__tests__/schedule-engine.test.ts packages/core/src/__tests__/core-jobs.test.ts`
Expected: all PASS.

- [ ] **Step 2: Full test suite — compare to baseline**

Run: `npm test`
Expected: the same pre-existing failing files as baseline (knowledge-*, config-history, template-integration, template-scheduler, task-execution-engine) — **zero new failures**. The new schedule tests are green.

- [ ] **Step 3: Lint/format/strip-types gate for our files**

Run: `npm run check`
If our new files are flagged for formatting: `npm run format`, then re-run. ESLint over our new files (`scheduler/job-registry.ts`, `scheduler/schedule-engine.ts`, `scheduler/core-jobs.ts`) must be clean; the pre-existing baseline errors elsewhere are not ours.

- [ ] **Step 4: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 5: Boot smoke — confirm migration + new engine, no double-fire**

Run: `RAVEN_PORT=4001 timeout 25 node packages/core/dist/index.js 2>&1 | grep -iE "schedule engine|Registered job schedule|Registered: |migrat"`
Expected: log shows the schedule engine starting and "Registered job schedule" lines for `task-archival`, `knowledge-retrospective`, `knowledge-consolidation`; migration 026 applied; and the legacy `Registered: Task Archival/Weekly Knowledge ...` lines are **absent** (those rows were deleted). The legacy scheduler may still log the remaining 4 (morning-digest, autonomous-task-management, ticktick-task-sync, system-maintenance) — that's expected until Plan 1b.

- [ ] **Step 6: Confirm the legacy rows are gone from the DB**

Run: `node -e "const db=require('better-sqlite3')('data/raven.db'); console.log(db.prepare('SELECT id FROM schedules ORDER BY id').all().map(r=>r.id)); db.close();"`
Expected: the list does NOT contain `task-archival`, `knowledge-retrospective`, or `knowledge-consolidation`.

- [ ] **Step 7: Push**

```bash
git push
```

---

## Follow-up — Plan 1b (NOT in this plan)

- Migrate the 3 suite services (ticktick-sync, autonomous-task-management, pattern-analysis) to registered jobs; write the `morning-digest` template; teach the engine's `template` and `agent` handler kinds (template → `executionEngine.createTree` stamped with `scheduleId`; needs migration to add `task_trees.schedule_id`); remove templates' embedded `schedule` triggers (kill remaining double-fire); delete the legacy `Scheduler` definition role + `orchestrator.handleSchedule`; add `GET /api/schedules` (unified), `PATCH /api/schedules/:id {enabled}` (runtime pause/resume via a new `setEnabled` that starts/stops a cron), and run-now; `?scheduleId=` filter on task/tree list endpoints.
