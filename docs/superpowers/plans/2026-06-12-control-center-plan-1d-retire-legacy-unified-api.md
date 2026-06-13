# Control Center — Plan 1d: Retire Legacy Scheduler + Unified Schedule API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the schedule convergence: delete the now-idle legacy `Scheduler`, give the schedule engine a queryable/controllable surface (`list`/`setEnabled`/`runNow`/`getActiveCount`/`getUpcoming`) backed by the `preferences` table for runtime pause/resume, rebuild `GET/PATCH/trigger /api/schedules` + health/dashboard over the engine, remove `orchestrator.handleSchedule` + template self-triggers, and add `?scheduleId=` run-history filters — so the Control Center UI (Plan 1) has one schedule API to consume.

**Architecture:** The engine becomes the single source of schedule truth. It tracks defs+crons by name, computes effective `enabled` from the YAML default plus a `preferences`-backed runtime override, **skips job-schedules whose handler isn't registered** (disabled suite → no fire-into-nothing), and exposes list/control methods. The legacy `Scheduler` class, its `ApiDeps.scheduler`, `orchestrator.handleSchedule`, and the template-scheduler's schedule-cron loop are deleted. The `/api/schedules` routes and health/dashboard read the engine.

**Tech Stack:** TypeScript ESM, croner, better-sqlite3, Fastify, Vitest. Conventions: `.ts` imports, `import type`, `createLogger`, `explicit-function-return-type`, `max-params: 3`.

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` § 1f (Plan 1d). **Depends on 1a+1b+1c** (engine fires all schedules; legacy `Scheduler` already seeds 0 jobs; `tasks.schedule_id` + `task_trees.schedule_id` exist).

**Conventions / baseline:** one command per line; migrations next free **030** (none needed unless noted); baseline-failing suites (`config-history`, `template-integration`, `template-scheduler`, knowledge-* Neo4j flakes) are not ours.

**Verified facts (grounding):**
- Engine (`packages/core/src/scheduler/schedule-engine.ts`) returns `{ start, stop }`; holds `jobs: Cron[]`; `registerScheduleDef(def, deps)` (job/template branches, skips `enabled===false`); deps `{ schedules, jobRegistry, taskStore, timezone, fireTemplate? }`.
- Legacy `Scheduler` consumers: `api/routes/schedules.ts` (`deps.scheduler.getSchedules/addSchedule/removeSchedule` + a `/trigger` that emits `schedule:triggered`), `api/routes/health.ts:49` (`deps.scheduler.getActiveJobCount()`), `api/routes/dashboard.ts:60,90` (`getActiveJobCount()`, `getUpcomingRuns(5)` → `{name,scheduledAt,type}`). `ApiDeps.scheduler: Scheduler` in `api/server.ts`. Constructed `index.ts` ~line 372 `new Scheduler(...)` + `scheduler.initialize([...schedulesConfig, ...suiteSchedules])`.
- `preferences` table = `{ key TEXT PK, value TEXT, updated_at INTEGER }`; no helper module — use raw `getDb().prepare(...)`.
- Web: `api-client.ts` `Schedule {id,name,cron,timezone,taskType,skillName,enabled}` + `getSchedules`; `app-store.ts` `fetchSchedules`/`schedules`/`fetchAll`; `app/schedules/page.tsx` renders `s.cron/s.skillName/s.timezone/s.enabled`; `app/page.tsx` refetches schedules on poll.
- Orchestrator: `schedule:triggered` subscription (line 97) + `handleSchedule` (152-206); `retrospective`/`knowledgeConsolidation` are used **only** in `handleSchedule` (now redundant — core-jobs invoke them). `sessionRetrospective` is separate (keep).
- `GET /api/tasks` uses `TaskQuerySchema` + `taskStore.queryTasks(filters)` (conditions builder); `tasks.schedule_id` column exists but no `scheduleId` filter. `GET /api/task-trees` maps trees but omits `scheduleId` (column exists post-1b).
- Template self-triggers: only `morning-briefing.yaml` + `system-maintenance.yaml` have `trigger: [{type: schedule}]`. template-scheduler `start()` has the cron-registration branch (remove) + an event branch (keep) + `triggerTemplate` (keep — engine's `fireTemplate` uses it).
- `briefing-formatter.ts` listens `agent:task:complete` filtering `taskType==='morning-digest'`, parses JSON, formats, emits `notification` (Telegram). With morning-digest now a template, that event never arrives → digest content delivery is broken. Addressed in Task 8 (flagged).

---

### Task 1: Schedule prefs helper (runtime enabled override)

**Files:**
- Create: `packages/core/src/scheduler/schedule-prefs.ts`
- Test: `packages/core/src/__tests__/schedule-prefs.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/schedule-prefs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchedulePrefs } from '../scheduler/schedule-prefs.ts';

describe('schedule prefs', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-schedprefs-'));
    db = new Database(join(dir, 't.db'));
    db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no override set', () => {
    const prefs = createSchedulePrefs(db);
    expect(prefs.getEnabledOverride('morning-digest')).toBeUndefined();
  });

  it('persists and reads an enabled override', () => {
    const prefs = createSchedulePrefs(db);
    prefs.setEnabledOverride('morning-digest', false);
    expect(prefs.getEnabledOverride('morning-digest')).toBe(false);
    prefs.setEnabledOverride('morning-digest', true);
    expect(prefs.getEnabledOverride('morning-digest')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/schedule-prefs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/core/src/scheduler/schedule-prefs.ts`:

```ts
import type { Database } from 'better-sqlite3';

const PREFIX = 'schedule:enabled:';

export interface SchedulePrefs {
  getEnabledOverride(name: string): boolean | undefined;
  setEnabledOverride(name: string, enabled: boolean): void;
}

export function createSchedulePrefs(db: Database): SchedulePrefs {
  return {
    getEnabledOverride(name: string): boolean | undefined {
      const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(`${PREFIX}${name}`) as
        | { value: string }
        | undefined;
      if (!row) return undefined;
      return row.value === 'true';
    },
    setEnabledOverride(name: string, enabled: boolean): void {
      db.prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(`${PREFIX}${name}`, enabled ? 'true' : 'false', Date.now());
    },
  };
}
```

Note: confirm the better-sqlite3 `Database` type import path matches how other core modules import it:
Run: `grep -rn "from 'better-sqlite3'\|better-sqlite3'" packages/core/src/db/*.ts | head -3`
If the codebase wraps the raw db in a `DatabaseInterface`, you may instead type the param as that interface and use its `prepare`/`run` — match whatever `task-store.ts` / `getDb()` exposes. Keep the behavior (get/set the `schedule:enabled:<name>` preference).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/schedule-prefs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduler/schedule-prefs.ts packages/core/src/__tests__/schedule-prefs.test.ts
```
```bash
git commit -m "feat(schedules): preferences-backed runtime enabled override store"
```

---

### Task 2: Engine surface — list / setEnabled / runNow / getActiveCount / getUpcoming + skip-unregistered

**Files:**
- Modify: `packages/core/src/scheduler/schedule-engine.ts`
- Test: `packages/core/src/__tests__/schedule-engine-surface.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/schedule-engine-surface.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createScheduleEngine } from '../scheduler/schedule-engine.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import type { ScheduleYaml } from '@raven/shared';

function defs(): ScheduleYaml[] {
  return [
    { name: 'has-job', cron: '0 * * * *', timezone: 'UTC', enabled: true, params: {}, run: { kind: 'job', ref: 'has-job' } },
    { name: 'no-job', cron: '0 * * * *', timezone: 'UTC', enabled: true, params: {}, run: { kind: 'job', ref: 'missing' } },
  ];
}

function fakePrefs() {
  const m = new Map<string, boolean>();
  return {
    getEnabledOverride: (n: string) => m.get(n),
    setEnabledOverride: (n: string, e: boolean) => void m.set(n, e),
  };
}

function makeEngine() {
  const jobRegistry = createJobRegistry();
  const ran: string[] = [];
  jobRegistry.register('has-job', async () => {
    ran.push('has-job');
    return { summary: 'ok' };
  });
  const taskStore = { createTask: vi.fn(() => ({ id: 't' })), updateTask: vi.fn(() => ({ id: 't' })) };
  const engine = createScheduleEngine({
    schedules: defs(),
    jobRegistry,
    taskStore: taskStore as any,
    timezone: 'UTC',
    schedulePrefs: fakePrefs(),
  });
  return { engine, ran };
}

describe('schedule engine surface', () => {
  it('lists schedules with registered flag (skips unregistered job)', () => {
    const { engine } = makeEngine();
    engine.start();
    const list = engine.list();
    const hasJob = list.find((s) => s.name === 'has-job')!;
    const noJob = list.find((s) => s.name === 'no-job')!;
    expect(hasJob.registered).toBe(true);
    expect(hasJob.enabled).toBe(true);
    expect(hasJob.nextRun).not.toBeNull();
    expect(noJob.registered).toBe(false);
    expect(noJob.nextRun).toBeNull(); // not scheduled — handler missing
    engine.stop();
  });

  it('getActiveCount counts only running crons', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1); // only has-job
    engine.stop();
  });

  it('setEnabled(false) stops the cron; setEnabled(true) restarts it', () => {
    const { engine } = makeEngine();
    engine.start();
    expect(engine.getActiveCount()).toBe(1);
    engine.setEnabled('has-job', false);
    expect(engine.getActiveCount()).toBe(0);
    expect(engine.list().find((s) => s.name === 'has-job')!.enabled).toBe(false);
    engine.setEnabled('has-job', true);
    expect(engine.getActiveCount()).toBe(1);
    engine.stop();
  });

  it('runNow invokes the handler immediately', async () => {
    const { engine, ran } = makeEngine();
    engine.start();
    await engine.runNow('has-job');
    expect(ran).toContain('has-job');
    engine.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine-surface.test.ts`
Expected: FAIL — `list`/`setEnabled`/`runNow`/`getActiveCount` not on the engine; `schedulePrefs` dep unknown.

- [ ] **Step 3: Rewrite the engine to track defs+crons by name + add the surface**

In `packages/core/src/scheduler/schedule-engine.ts`:

(a) Add a prefs dep type import and extend `ScheduleEngineDeps`:

```ts
import type { SchedulePrefs } from './schedule-prefs.ts';
```
Add to `ScheduleEngineDeps`:
```ts
  schedulePrefs?: SchedulePrefs;
```

(b) Add the public types + extend the interface:

```ts
export interface ScheduleInfo {
  name: string;
  cron: string;
  timezone: string;
  kind: 'job' | 'template' | 'agent';
  ref: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
}

export interface ScheduleEngine {
  start(): void;
  stop(): void;
  list(): ScheduleInfo[];
  setEnabled(name: string, enabled: boolean): boolean;
  runNow(name: string): Promise<boolean>;
  getActiveCount(): number;
  getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }>;
}
```

(c) Rewrite `createScheduleEngine` to hold a `Map<string, { def: ScheduleYaml; job: Cron | null }>` instead of a bare array, computing effective-enabled and registered-ness. Replace the whole factory body:

```ts
export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const entries = new Map<string, { def: ScheduleYaml; job: Cron | null }>();

  function isRegistered(def: ScheduleYaml): boolean {
    if (def.run.kind === 'job') return deps.jobRegistry.has(def.run.ref);
    if (def.run.kind === 'template') return deps.fireTemplate !== undefined;
    return false;
  }

  function effectiveEnabled(def: ScheduleYaml): boolean {
    const override = deps.schedulePrefs?.getEnabledOverride(def.name);
    return override ?? def.enabled !== false;
  }

  function makeCron(def: ScheduleYaml): Cron {
    return new Cron(def.cron, { timezone: def.timezone }, () => {
      void fire(def);
    });
  }

  async function fire(def: ScheduleYaml): Promise<void> {
    if (def.run.kind === 'job') {
      await runScheduledJob(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore }).catch(
        (err: unknown) => log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`),
      );
    } else if (def.run.kind === 'template' && deps.fireTemplate) {
      const fireTemplate = deps.fireTemplate;
      await runScheduledTemplate(def, { fireTemplate }).catch((err: unknown) =>
        log.error(`runScheduledTemplate(${def.name}) failed: ${String(err)}`),
      );
    }
  }

  function startEntry(name: string): void {
    const entry = entries.get(name);
    if (!entry || entry.job) return;
    if (!isRegistered(entry.def)) {
      log.warn(`Schedule "${name}" handler not registered (suite disabled?) — not scheduled`);
      return;
    }
    if (!effectiveEnabled(entry.def)) {
      log.info(`Schedule "${name}" disabled — not scheduled`);
      return;
    }
    entry.job = makeCron(entry.def);
    log.info(`Scheduled "${name}" (${entry.def.cron}) → next ${entry.job.nextRun()?.toISOString() ?? 'n/a'}`);
  }

  function stopEntry(name: string): void {
    const entry = entries.get(name);
    if (entry?.job) {
      entry.job.stop();
      entry.job = null;
    }
  }

  return {
    start(): void {
      for (const def of deps.schedules) entries.set(def.name, { def, job: null });
      for (const name of entries.keys()) startEntry(name);
      log.info(`Schedule engine started with ${[...entries.values()].filter((e) => e.job).length} active schedules`);
    },
    stop(): void {
      for (const name of entries.keys()) stopEntry(name);
    },
    list(): ScheduleInfo[] {
      return [...entries.values()].map(({ def, job }) => ({
        name: def.name,
        cron: def.cron,
        timezone: def.timezone,
        kind: def.run.kind,
        ref: def.run.ref,
        enabled: effectiveEnabled(def),
        registered: isRegistered(def),
        nextRun: job?.nextRun()?.toISOString() ?? null,
      }));
    },
    setEnabled(name: string, enabled: boolean): boolean {
      const entry = entries.get(name);
      if (!entry) return false;
      deps.schedulePrefs?.setEnabledOverride(name, enabled);
      if (enabled) startEntry(name);
      else stopEntry(name);
      return true;
    },
    async runNow(name: string): Promise<boolean> {
      const entry = entries.get(name);
      if (!entry) return false;
      await fire(entry.def);
      return true;
    },
    getActiveCount(): number {
      return [...entries.values()].filter((e) => e.job).length;
    },
    getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }> {
      return [...entries.values()]
        .map(({ def, job }) => ({ name: def.name, next: job?.nextRun() ?? null, kind: def.run.kind }))
        .filter((x): x is { name: string; next: Date; kind: string } => x.next !== null)
        .sort((a, b) => a.next.getTime() - b.next.getTime())
        .slice(0, limit)
        .map((x) => ({ name: x.name, scheduledAt: x.next.toISOString(), kind: x.kind }));
    },
  };
}
```

Keep the existing `runScheduledJob`, `runScheduledTemplate`, `FireTemplate`, `TaskStoreLike`, `RunJobDeps`, `RunTemplateDeps` exports unchanged (the new `fire()` reuses them). Remove the old `registerScheduleDef`/`registerJobSchedule`/`registerTemplateSchedule` helpers and the old `jobs: Cron[]` array (superseded by `entries` + `startEntry`). If any of those helper functions are exported or referenced by a test, update accordingly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/schedule-engine-surface.test.ts`
Expected: PASS (4 tests).

Run: `npx vitest run packages/core/src/__tests__/schedule-engine.test.ts packages/core/src/__tests__/schedule-engine-template.test.ts`
Expected: PASS (these test `runScheduledJob`/`runScheduledTemplate` directly — unchanged — so they still pass).

- [ ] **Step 5: Wire `schedulePrefs` in boot**

In `packages/core/src/index.ts`, where `createScheduleEngine({...})` is called (~line 514), add the prefs dep. First add the import near other scheduler imports:
```ts
import { createSchedulePrefs } from './scheduler/schedule-prefs.ts';
```
Then before/at the engine construction:
```ts
  const schedulePrefs = createSchedulePrefs(getDb());
```
(Use the same db handle other modules use — `getDb()` returns the raw better-sqlite3 instance; if `createSchedulePrefs` was typed to `DatabaseInterface` in Task 1, pass `dbInterface` instead. Match Task 1's chosen type.)
Add `schedulePrefs,` to the `createScheduleEngine({...})` deps object.

- [ ] **Step 6: Build + lint + commit**

Run: `npm run build -w packages/shared -w packages/core` (clean)
Run: `npx eslint --max-warnings 0 packages/core/src/scheduler/schedule-engine.ts` (clean — if `getUpcoming` or `createScheduleEngine` trips `max-lines-per-function`, extract helpers)
```bash
git add packages/core/src/scheduler/schedule-engine.ts packages/core/src/__tests__/schedule-engine-surface.test.ts packages/core/src/index.ts
```
```bash
git commit -m "feat(schedules): engine surface (list/setEnabled/runNow/getActiveCount/getUpcoming) + skip unregistered jobs"
```

---

### Task 3: Rewrite `/api/schedules` over the engine

**Files:**
- Modify: `packages/core/src/api/routes/schedules.ts`
- Modify: `packages/core/src/api/server.ts` (`ApiDeps`: add `scheduleEngine`, remove `scheduler`)

- [ ] **Step 1: Replace the routes**

Rewrite `packages/core/src/api/routes/schedules.ts` to:

```ts
import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';

export function registerScheduleRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/schedules', async () => {
    return deps.scheduleEngine.list();
  });

  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/schedules/:id',
    async (req, reply) => {
      const ok = deps.scheduleEngine.setEnabled(req.params.id, req.body.enabled === true);
      if (!ok) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Schedule not found' });
      return { id: req.params.id, enabled: req.body.enabled === true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/schedules/:id/trigger', async (req, reply) => {
    const ok = await deps.scheduleEngine.runNow(req.params.id);
    if (!ok) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Schedule not found' });
    return { triggered: true };
  });
}
```

(`:id` is the schedule name. The legacy POST-create and DELETE routes are dropped — schedules are now defined in YAML, not created via API.)

- [ ] **Step 2: Update `ApiDeps`**

In `packages/core/src/api/server.ts`: in the `ApiDeps` interface, REMOVE `scheduler: Scheduler;` and ADD `scheduleEngine: ScheduleEngine;` (import `ScheduleEngine` type from `../scheduler/schedule-engine.ts`; remove the now-unused `Scheduler` import if nothing else uses it — health/dashboard will be updated in Task 4). Update the `createApiServer` deps wiring in `index.ts` to pass `scheduleEngine` instead of `scheduler` (find where `createApiServer({...})` or the deps object is built and swap the field).

- [ ] **Step 3: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: FAILS until Task 4 (health/dashboard still reference `deps.scheduler`) — that's expected; proceed to Task 4 and build there. (If you prefer a green build per task, do Task 4's edits before building. Either way, commit Tasks 3+4 together if the build only goes green after Task 4.)

- [ ] **Step 4: Commit (with Task 4 if needed for a green build)**

```bash
git add packages/core/src/api/routes/schedules.ts packages/core/src/api/server.ts packages/core/src/index.ts
```
```bash
git commit -m "feat(schedules): rewrite /api/schedules over the engine (list + PATCH enabled + run-now)"
```

---

### Task 4: Health + dashboard read the engine; delete the `Scheduler` class

**Files:**
- Modify: `packages/core/src/api/routes/health.ts`, `packages/core/src/api/routes/dashboard.ts`
- Modify: `packages/core/src/index.ts` (remove `new Scheduler(...)` + seed loading)
- Delete: `packages/core/src/scheduler/scheduler.ts`, `packages/core/src/__tests__/scheduler.test.ts`

- [ ] **Step 1: Health**

In `packages/core/src/api/routes/health.ts:49`, replace `deps.scheduler.getActiveJobCount()` with `deps.scheduleEngine.getActiveCount()`.

- [ ] **Step 2: Dashboard**

In `packages/core/src/api/routes/dashboard.ts`:
- line ~60: `deps.scheduler.getActiveJobCount()` → `deps.scheduleEngine.getActiveCount()`.
- line ~90: `deps.scheduler.getUpcomingRuns(UPCOMING_LIMIT)` → `deps.scheduleEngine.getUpcoming(UPCOMING_LIMIT)`. The shape changes from `{name,scheduledAt,type}` to `{name,scheduledAt,kind}`. Update the dashboard response mapping to use `kind` (or alias to `type` in the mapping if the web `LifeDashboardData` type expects `type` — check `packages/shared` for the dashboard event type and keep the wire shape the web expects, mapping `kind`→`type` if needed).

- [ ] **Step 3: Remove the legacy Scheduler from boot**

In `packages/core/src/index.ts`:
- Remove `const scheduler = new Scheduler(...)` and `await scheduler.initialize([...schedulesConfig, ...suiteSchedules])` (~line 372).
- Remove the now-unused `schedulesConfig`/`suiteSchedules` locals IF they're only used for that seed. (`loadSchedulesConfig` import + `suiteRegistry.collectSchedules()` — remove if unused elsewhere; grep first: `grep -n "loadSchedulesConfig\|collectSchedules\|schedulesConfig\|suiteSchedules" packages/core/src/index.ts`.)
- Remove the `scheduler` from the `createApiServer`/ApiDeps wiring (done in Task 3) and any shutdown call `scheduler.shutdown()` (the engine's `stop()` already runs).
- Remove the `Scheduler` import.

- [ ] **Step 4: Delete the class + its test**

```bash
git rm packages/core/src/scheduler/scheduler.ts packages/core/src/__tests__/scheduler.test.ts
```
Then grep for any remaining references:
Run: `grep -rn "scheduler/scheduler.ts\|new Scheduler(\|from '.*scheduler/scheduler'\|deps.scheduler\b\|\.scheduler\b" packages/core/src | grep -iv schedule-engine | grep -iv scheduleEngine`
Fix every remaining reference (api.test.ts, e2e.test.ts, dashboard-api.test.ts likely build an `ApiDeps`/mock with `scheduler` — replace with a `scheduleEngine` mock exposing `list/getActiveCount/getUpcoming/setEnabled/runNow`). Report the files you touched.

- [ ] **Step 5: Build + tests**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.
Run: `npx vitest run packages/core/src/__tests__/dashboard-api.test.ts packages/core/src/__tests__/api.test.ts packages/core/src/__tests__/health.test.ts 2>&1 | tail -15`
Expected: pass (or pre-existing baseline only). Fix any that broke due to the scheduler→scheduleEngine swap.

- [ ] **Step 6: Commit**

```bash
git add -A
```
```bash
git commit -m "feat(schedules): delete legacy Scheduler; health/dashboard read the engine"
```

---

### Task 5: Remove `orchestrator.handleSchedule` + drop its now-unused deps

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts`
- Modify: `packages/core/src/index.ts` (Orchestrator construction — drop `retrospective`/`knowledgeConsolidation` args)

- [ ] **Step 1: Remove the subscription + method**

In `packages/core/src/orchestrator/orchestrator.ts`:
- Remove the `this.eventBus.on<ScheduleTriggeredEvent>('schedule:triggered', ...)` block (~line 97-99).
- Remove the entire `private async handleSchedule(...)` method (~line 152-206).
- Remove the `retrospective` + `knowledgeConsolidation` fields, their constructor assignments, and their entries in `OrchestratorDeps` (they're used ONLY by handleSchedule — verified). KEEP `sessionRetrospective` (separate).
- Remove now-unused imports: `ScheduleTriggeredEvent`, `Retrospective`, `KnowledgeConsolidation` (verify each is unused after the edits before removing).

- [ ] **Step 2: Update the Orchestrator construction in index.ts**

Find `new Orchestrator({...})` in `index.ts` and remove the `retrospective` and `knowledgeConsolidation` properties from its deps object. (Leave the `retrospective`/`knowledgeConsolidation` variables themselves — they're still passed to `registerCoreJobs`.)

- [ ] **Step 3: Build + orchestrator tests**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.
Run: `npx vitest run packages/core/src/__tests__/orchestrator.test.ts 2>&1 | tail -15`
Expected: pass (or baseline only). If a test asserted `handleSchedule`/schedule routing, remove/adjust it (that behavior is gone by design — schedules no longer route through the orchestrator).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator.ts packages/core/src/index.ts
```
(add orchestrator test if changed)
```bash
git commit -m "feat(schedules): remove orchestrator.handleSchedule (schedules run via the engine)"
```

---

### Task 6: Remove template self-triggers + the template-scheduler cron loop

**Files:**
- Modify: `packages/core/src/template-engine/template-scheduler.ts` (remove the `schedule` branch in `start()`)
- Modify: `projects/templates/morning-briefing.yaml`, `projects/templates/system-maintenance.yaml` (remove `trigger:` blocks)

- [ ] **Step 1: Remove the schedule branch from `start()`**

In `packages/core/src/template-engine/template-scheduler.ts` `start()`, remove the `if (trigger.type === 'schedule') { ... }` branch (the `new Cron(...)` registration + `cronJobs.push`). KEEP the `else if (trigger.type === 'event')` branch and everything else (`triggerTemplate`, `triggerFromTemplate`, `stop`, the event handlers). If `cronJobs` becomes unused, remove it and its `stop()` cleanup; if it's still used by event handling, leave it. Update the final log line if it referenced `cronJobs.length`.

- [ ] **Step 2: Remove the `trigger:` blocks from the two templates**

In `projects/templates/morning-briefing.yaml`, delete the `trigger:` block (the `- type: schedule / cron / timezone` lines). `TaskTemplateSchema` defaults `trigger` to `[{type:'manual'}]`, so the template stays valid + manually triggerable.

In `projects/templates/system-maintenance.yaml`, delete the `trigger:` block likewise.

- [ ] **Step 3: Build + template-scheduler test**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.
Run: `npx vitest run packages/core/src/__tests__/template-scheduler.test.ts 2>&1 | tail -15`
Expected: the file is baseline-failing (1 pre-existing failure); confirm no NEW failures. If a test asserted schedule-cron registration, update it (that path is removed by design).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/template-engine/template-scheduler.ts projects/templates/morning-briefing.yaml projects/templates/system-maintenance.yaml
```
```bash
git commit -m "feat(schedules): remove template self-triggers (cron lives only in projects/schedules)"
```

> **FLAG for the human:** `morning-briefing` (6am) had only a self-trigger and no schedule YAML — after this it no longer auto-fires. It overlaps `morning-digest` (8am). Decide: delete `morning-briefing.yaml`, or add `projects/schedules/morning-briefing.yaml` (`run:{kind:template, ref:morning-briefing}`) if you want it back. Left as-is (manual-only) pending your call.

---

### Task 7: `?scheduleId=` run-history filter (tasks + task-trees)

**Files:**
- Modify: `packages/core/src/api/routes/tasks.ts` (`TaskQuerySchema`)
- Modify: `packages/core/src/task-manager/task-store.ts` (`queryTasks` + `TaskQueryFilters`)
- Modify: `packages/core/src/api/routes/task-trees.ts` (include `scheduleId` in list)
- Test: extend `packages/core/src/__tests__/` task-store test or add a focused one

- [ ] **Step 1: Add `scheduleId` to the task query**

In `packages/core/src/api/routes/tasks.ts`, add to `TaskQuerySchema`:
```ts
  scheduleId: z.string().optional(),
```
In `packages/core/src/task-manager/task-store.ts`, add `scheduleId?: string` to `TaskQueryFilters` (its type) and a condition in `queryTasks`:
```ts
  if (filters.scheduleId) {
    conditions.push('schedule_id = ?');
    params.push(filters.scheduleId);
  }
```

- [ ] **Step 2: Include `scheduleId` in the task-trees list**

In `packages/core/src/api/routes/task-trees.ts` `GET /api/task-trees`, add `scheduleId: tree.scheduleId,` to the mapped object.

- [ ] **Step 3: Test the filter**

Add a test (in the existing task-store test file, or a new `packages/core/src/__tests__/task-schedule-filter.test.ts`) that creates two tasks (one with `scheduleId: 'morning-digest'`, one without) and asserts `queryTasks({ scheduleId: 'morning-digest' })` returns only the stamped one. Use the existing task-store test setup pattern (temp DB).

Run: `npx vitest run <that test>`
Expected: PASS.

- [ ] **Step 4: Build + commit**

Run: `npm run build -w packages/shared -w packages/core` (clean)
```bash
git add packages/core/src/api/routes/tasks.ts packages/core/src/task-manager/task-store.ts packages/core/src/api/routes/task-trees.ts packages/core/src/__tests__/
```
```bash
git commit -m "feat(schedules): add ?scheduleId= filter on tasks + expose scheduleId on task-trees list"
```

---

### Task 8: Web client + schedules page + morning-digest delivery

**Files:**
- Modify: `packages/web/src/lib/api-client.ts` (`Schedule` type + methods)
- Modify: `packages/web/src/app/schedules/page.tsx` (render new shape)
- Modify: `projects/templates/morning-digest.yaml` (delivery), and flag briefing-formatter

- [ ] **Step 1: Update the web `Schedule` type + client**

In `packages/web/src/lib/api-client.ts`, replace the `Schedule` interface with the engine's `ScheduleInfo` shape:
```ts
export interface Schedule {
  name: string;
  cron: string;
  timezone: string;
  kind: 'job' | 'template' | 'agent';
  ref: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
}
```
`getSchedules` stays `request<Schedule[]>('/schedules')`. Add:
```ts
  setScheduleEnabled: (name: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>(`/schedules/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  triggerSchedule: (name: string) =>
    request<{ triggered: boolean }>(`/schedules/${encodeURIComponent(name)}/trigger`, { method: 'POST' }),
```

- [ ] **Step 2: Update the schedules page to the new shape**

In `packages/web/src/app/schedules/page.tsx`, replace `s.skillName`/`s.taskType` references with `s.kind` + `s.ref` + a human next-run (`s.nextRun`). Use `s.name` as the key (id is gone). Keep it simple — Plan 1 replaces this page with the Control Center rail; this edit just keeps it compiling + sensible.

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean (no references to removed `Schedule` fields remain — grep `\.skillName\|\.taskType` in `packages/web/src` for schedule usages and fix).

- [ ] **Step 3: morning-digest content delivery (the flagged gap)**

The legacy `briefing-formatter` delivered the digest by listening for the `morning-digest` agent task; with morning-digest now a template, that event never arrives. Make the template self-deliver: in `projects/templates/morning-digest.yaml`, change the `compile-digest` agent task prompt to ALSO send the result via Telegram (the `digest` agent in the daily-briefing suite can delegate to the telegram agent), e.g. append to the prompt: `"Then send the compiled digest to the user via Telegram."` and remove the static `send-digest` notify node (or keep it as a terminal marker). Confirm the `digest` agent has telegram delegation (check `suites/daily-briefing` agent definitions); if it does not, instead keep the notify node and leave a FLAG (below) — do not fabricate a delivery path.

> **FLAG for the human:** verify the morning digest still delivers its *content* to Telegram (not just a "ready" ping). The `briefing-formatter` service's `morning-digest` branch is now dead (the template path doesn't emit `taskType: 'morning-digest'`). If the `digest` agent can't send Telegram from within template execution, we keep `briefing-formatter` by having it listen for the compile-digest execution-task completion instead — a follow-up, not blindly done here.

- [ ] **Step 4: Build web + commit**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json` (clean)
Run: `npx eslint --max-warnings 0 packages/web/src/lib/api-client.ts packages/web/src/app/schedules/page.tsx` (clean)
```bash
git add packages/web/src/lib/api-client.ts packages/web/src/app/schedules/page.tsx projects/templates/morning-digest.yaml
```
```bash
git commit -m "feat(schedules): web client + schedules page on unified shape; morning-digest self-delivery"
```

---

### Task 9: Full verification

- [ ] **Step 1: Build + targeted tests**

Run: `npm run build -w packages/shared -w packages/core` (clean)
Run: `npx vitest run packages/core/src/__tests__/schedule-prefs.test.ts packages/core/src/__tests__/schedule-engine-surface.test.ts packages/core/src/__tests__/schedule-engine.test.ts packages/core/src/__tests__/schedule-engine-template.test.ts packages/core/src/__tests__/job-registry.test.ts`
Expected: all PASS.

- [ ] **Step 2: Full suite vs baseline**

Run: `npm test`
Expected: only the documented baseline failures + knowledge-* flakes — zero NEW. (Tests for the deleted `Scheduler` are gone; api/dashboard/orchestrator tests updated.)

- [ ] **Step 3: Lint/check + web type-check**

Run: `npm run check`
Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: our changed files clean.

- [ ] **Step 4: Boot smoke — engine is the only scheduler; API works**

Run: `RAVEN_PORT=4016 timeout 30 node packages/core/dist/index.js > /tmp/raven-1d.log 2>&1`
Run: `grep -iE "Schedule engine started|Scheduled \"|handler not registered|Scheduler initialized" /tmp/raven-1d.log`
Expected: "Schedule engine started with N active schedules"; NO "Scheduler initialized" line (legacy gone); any disabled-suite schedules log "handler not registered ... not scheduled" (no fire-into-nothing).

- [ ] **Step 5: API smoke (engine-backed schedules endpoint)**

Run: `RAVEN_PORT=4016 node packages/core/dist/index.js > /tmp/raven-1d2.log 2>&1 &` then wait ~6s and:
Run: `curl -s http://localhost:4016/api/schedules | head -c 800`
Expected: a JSON array of `{name,cron,kind,ref,enabled,registered,nextRun}`. Then kill the server:
Run: `pkill -f "RAVEN_PORT=4016" || true`
(Use the project's preferred run approach if different; the goal is to confirm `GET /api/schedules` returns the unified shape.)

- [ ] **Step 6: Push**

```bash
git push
```

---

## After 1d

The schedule subsystem is fully converged: one engine, one definition source (`projects/schedules/*.yaml`), one API. **Plan 1 (Control Center UI)** can now build the Schedules rail on `GET /api/schedules` + `PATCH`/`trigger`, and the board's `scheduled` badge + run-history on `?scheduleId=`.

Open human-decisions carried out of this plan: (1) whether `morning-briefing` should be deleted or given a schedule YAML; (2) confirm morning-digest content delivery (briefing-formatter follow-up if the digest agent can't self-send).
