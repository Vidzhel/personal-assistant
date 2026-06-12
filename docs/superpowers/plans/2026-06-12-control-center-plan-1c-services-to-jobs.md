# Control Center — Plan 1c: Suite Services → Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the three cron-triggered suite services (ticktick-sync, autonomous-manager, pattern-analysis) and the currently-orphaned `system-maintenance` onto the unified schedule engine as Job-Registry jobs, so every scheduled run produces a `scheduled`-badged task and the legacy `Scheduler` fires nothing.

**Architecture:** Expose the `JobRegistry` on `ServiceContext`. Each service, in its `start()`, registers a job (keyed by its schedule name) that runs its existing core logic — instead of subscribing to `schedule:triggered`. Recreate the four schedule YAMLs as `run:{kind:job}`; delete their legacy DB rows + both seed sources; the engine then owns them. Services keep their own deps (eventBus/db/agentManager via the same lazy globals/config they already use).

**Tech Stack:** TypeScript ESM, croner, Vitest. Core conventions: `.ts` imports, `import type`, `createLogger`, `explicit-function-return-type`, `max-params: 3`.

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` § 1f (Plan 1c). **Depends on Plans 1a + 1b** (schedule engine with `job` + `template` kinds, JobRegistry — merged).

**Conventions / baseline:** one command per line; migrations `migrations/NNN-*.sql` (latest `028`, next free **029**); baseline-failing suites (`config-history`, `template-integration`, `template-scheduler`) are not ours.

**Verified facts (from grounding):**
- `ServiceContext` = `{ eventBus, db, logger, config, projectRoot, integrationsConfig }` in `packages/core/src/suite-registry/service-runner.ts`. Services receive it in `start(context)`.
- Boot (`packages/core/src/index.ts`): `baseContext` is built ~line 174 and `serviceRunner.startServices(...)` called ~line 189. `taskStore` (line 211) and `agentManager` (later, ~355) are exposed as **globals after** `startServices` — services use them lazily at fire-time, so jobs registered at `start()` work. The `jobRegistry` was created by Plan 1a ~line 514 (after services) — **this plan moves its creation before `baseContext`**.
- Service internals (keep their core fns):
  - **ticktick-sync** (`suites/task-management/services/ticktick-sync.ts`): `runSync()` (lines ~65-165); subscribes `eventBus.on('schedule:triggered', scheduleHandler)` filtering `scheduleName === 'ticktick-task-sync'` (const `SYNC_SCHEDULE_NAME`). Uses globals `__raven_task_store__`, `__raven_agent_manager__`.
  - **autonomous-manager** (`suites/task-management/services/autonomous-manager.ts`): `runAutonomousManagement()` (lines ~182-317) with module `isRunning` guard; `handleScheduleTrigger` filters `taskType === 'autonomous-task-management'`; registered `eventBus.on('schedule:triggered', handleScheduleTrigger)`. Uses `serviceConfig.agentManager`.
  - **data-collector** (`suites/proactive-intelligence/services/data-collector.ts`): `handleScheduleTriggered` filters `taskType === 'pattern-analysis'`, calls `buildSnapshot(db)` then `eventBus.emit('agent:task:request', ...)`; registered `eventBus.on('schedule:triggered', handleScheduleTriggered)`.
  - **maintenance-runner** (`suites/_orchestrator/services/maintenance-runner.ts`): module-scoped `runMaintenance(taskId)`; `start()` listens `agent:task:request {actionName:'maintenance:run'}`. system-maintenance is currently ORPHANED (the schedule fires but nothing routes it). Imports `ServiceContext` from `@raven/core/suite-registry/service-runner.ts`.
- Legacy DB rows still present (post-1b): `autonomous-task-management`, `pattern-analysis`, `system-maintenance`, `ticktick-task-sync`. Seeds: `config/schedules.json` (autonomous-task-management, ticktick-task-sync, system-maintenance) + `suites/proactive-intelligence/schedules.json` (pattern-analysis).
- After 1b, `projects/schedules/` contains only the migrated job/template files (the premature ones were deleted) — so this plan **creates** new schedule YAMLs for the 4.

---

### Task 1: Expose `JobRegistry` on `ServiceContext` + move its creation before services

**Files:**
- Modify: `packages/core/src/suite-registry/service-runner.ts` (`ServiceContext`)
- Modify: `packages/core/src/index.ts` (create `jobRegistry` before `baseContext`; remove the later duplicate creation)

- [ ] **Step 1: Add `jobRegistry` to `ServiceContext`**

In `packages/core/src/suite-registry/service-runner.ts`, add the import at the top:

```ts
import type { JobRegistry } from '../scheduler/job-registry.ts';
```

Add the field to the `ServiceContext` interface (after `integrationsConfig: IntegrationsConfig;`):

```ts
  jobRegistry: JobRegistry;
```

- [ ] **Step 2: Wire it in boot — create before `baseContext`**

In `packages/core/src/index.ts`:

(a) Confirm the current jobRegistry creation site:
Run: `grep -n "createJobRegistry\|registerCoreJobs\|createScheduleEngine\|const baseContext" packages/core/src/index.ts`

(b) Add the import if not present (near the other scheduler imports):
```ts
import { createJobRegistry } from './scheduler/job-registry.ts';
```

(c) Immediately BEFORE `const baseContext = {` (~line 174), add:
```ts
  const jobRegistry = createJobRegistry();
```

(d) Add `jobRegistry` to the `baseContext` object (after `integrationsConfig,`):
```ts
    jobRegistry,
```

(e) REMOVE the now-duplicate `const jobRegistry = createJobRegistry();` that Plan 1a added later (around the `registerCoreJobs(...)` / `createScheduleEngine(...)` block, ~line 514). Leave `registerCoreJobs(jobRegistry, {...})` and `createScheduleEngine({ ..., jobRegistry, ... })` intact — they now reference the earlier `jobRegistry`.

- [ ] **Step 3: Build to verify type-check**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean. (If any test or service constructs a `ServiceContext` literal without `jobRegistry`, the build/tests will flag it — fix those in the relevant task below or add `jobRegistry` to the test's context.)

- [ ] **Step 4: Check for ServiceContext literals in tests**

Run: `grep -rn "ServiceContext\|startServices\|\.start({" packages/core/src/__tests__ suites/**/__tests__ 2>/dev/null | head`
If any test builds a `ServiceContext`/calls a service `start()` with a literal context, note them — they'll need `jobRegistry: createJobRegistry()` added. Fix them now (import `createJobRegistry` in those tests and add the field) so the build/tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/suite-registry/service-runner.ts packages/core/src/index.ts
```
```bash
git commit -m "feat(schedules): expose JobRegistry on ServiceContext, create it before services start"
```

---

### Task 2: ticktick-sync → job

**Files:**
- Modify: `suites/task-management/services/ticktick-sync.ts`
- Modify: its test if one exists (`suites/task-management/__tests__/*ticktick-sync*` or `packages/core` — grep)

- [ ] **Step 1: Read the service**

Read `suites/task-management/services/ticktick-sync.ts` fully. Identify: `runSync()` (core logic — keep), the `scheduleHandler` + `eventBus.on('schedule:triggered', scheduleHandler)` registration in `start()`, and the `SYNC_SCHEDULE_NAME` const.

- [ ] **Step 2: Replace the schedule listener with a job registration**

In `start(context)`, REMOVE:
```ts
    scheduleHandler = (event: unknown): void => {
      const e = event as ScheduleTriggeredEvent;
      if (e.payload.scheduleName === SYNC_SCHEDULE_NAME) {
        void runSync();
      }
    };
    eventBus.on('schedule:triggered', scheduleHandler);
```
(match the real code) and ADD:
```ts
    context.jobRegistry.register(SYNC_SCHEDULE_NAME, async () => {
      const summary = await runSync();
      return { summary: summary ?? 'TickTick sync complete' };
    });
```
If `runSync()` returns `void`/`Promise<void>`, drop the `summary` capture and just `await runSync(); return { summary: 'TickTick sync complete' };`. Keep `SYNC_SCHEDULE_NAME = 'ticktick-task-sync'` (it's the job ref). In `stop()`, remove any `eventBus.off('schedule:triggered', scheduleHandler)` (the registry has no unregister; that's fine — jobs live for the process). Remove the now-unused `scheduleHandler` module variable and the `ScheduleTriggeredEvent` import if no longer used.

- [ ] **Step 3: Update the test (if present)**

Run: `grep -rln "ticktick-sync\|runSync\|SYNC_SCHEDULE_NAME" suites/task-management/__tests__ packages/core/src/__tests__ 2>/dev/null`
If a test simulates the schedule via `eventBus.emit({type:'schedule:triggered', payload:{scheduleName:'ticktick-task-sync'}})`, change it to: build a `jobRegistry` (`createJobRegistry()`), pass it in the `ServiceContext`, call `service.start(context)`, then invoke the registered job: `await context.jobRegistry.get('ticktick-task-sync')!({ scheduleName: 'ticktick-task-sync', params: {} })`. Keep all existing assertions about sync behavior (created/updated tasks, notification emit). If no test exists, skip.

- [ ] **Step 4: Build + lint**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.
Run: `npx eslint --max-warnings 0 suites/task-management/services/ticktick-sync.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add suites/task-management/services/ticktick-sync.ts
```
(add the test file too if you changed one)
```bash
git commit -m "feat(schedules): ticktick-sync registers a job instead of listening to schedule:triggered"
```

---

### Task 3: autonomous-manager → job

**Files:**
- Modify: `suites/task-management/services/autonomous-manager.ts`
- Modify: its test if present

- [ ] **Step 1: Read the service**

Read `suites/task-management/services/autonomous-manager.ts`. Identify `runAutonomousManagement()` (keep), `handleScheduleTrigger` + its `eventBus.on('schedule:triggered', ...)` registration, and the module `isRunning` guard.

- [ ] **Step 2: Replace with a job registration**

In `start(context)`, REMOVE the `eventBus.on('schedule:triggered', handleScheduleTrigger ...)` line and ADD:
```ts
    context.jobRegistry.register('autonomous-task-management', async () => {
      if (isRunning) return { summary: 'Already running — skipped' };
      isRunning = true;
      try {
        await runAutonomousManagement();
        return { summary: 'Autonomous task management complete' };
      } finally {
        isRunning = false;
      }
    });
```
Remove the now-unused `handleScheduleTrigger` function and `ScheduleTriggerPayloadSchema` if it's no longer referenced. Keep `runAutonomousManagement` + `isRunning`.

- [ ] **Step 3: Update the test (if present)**

Run: `grep -rln "autonomous-manager\|runAutonomousManagement\|autonomous-task-management" suites/task-management/__tests__ packages/core/src/__tests__ 2>/dev/null`
If a test emits `schedule:triggered` to trigger it, change to register-and-invoke via `jobRegistry.get('autonomous-task-management')!({scheduleName:'autonomous-task-management', params:{}})`, preserving assertions.

- [ ] **Step 4: Build + lint + commit**

Run: `npm run build -w packages/shared -w packages/core` (clean)
Run: `npx eslint --max-warnings 0 suites/task-management/services/autonomous-manager.ts` (clean)
```bash
git add suites/task-management/services/autonomous-manager.ts
```
```bash
git commit -m "feat(schedules): autonomous-manager registers a job instead of listening to schedule:triggered"
```

---

### Task 4: data-collector (pattern-analysis) → job

**Files:**
- Modify: `suites/proactive-intelligence/services/data-collector.ts`
- Modify: its test if present

- [ ] **Step 1: Read the service**

Read `suites/proactive-intelligence/services/data-collector.ts`. Identify `handleScheduleTriggered` (filters `taskType === 'pattern-analysis'`, calls `buildSnapshot(db)` then `eventBus.emit('agent:task:request', ...)`) and its `eventBus.on('schedule:triggered', handleScheduleTriggered)` registration. Note `buildSnapshot` is the reusable core.

- [ ] **Step 2: Replace with a job registration**

Refactor the snapshot+emit body out of `handleScheduleTriggered` (which filtered by taskType) into the job. In `start(context)`, REMOVE `eventBus.on('schedule:triggered', handleScheduleTriggered)` and ADD:
```ts
    context.jobRegistry.register('pattern-analysis', async () => {
      const snapshot = buildSnapshot(db);
      log.info(`Data snapshot collected (${snapshot.length} chars)`);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_PROACTIVE_INTELLIGENCE,
        type: 'agent:task:request',
        payload: {
          taskId: generateId(),
          prompt: `Analyze the following data snapshot and identify actionable patterns:\n\n${snapshot}`,
          skillName: SUITE_PROACTIVE_INTELLIGENCE,
          actionName: 'intelligence:generate-insight',
          mcpServers: {},
          agentDefinitions: { [AGENT_PATTERN_ANALYZER]: undefined },
          priority: 'low' as const,
        },
      });
      return { summary: `Pattern analysis dispatched (${snapshot.length} char snapshot)` };
    });
```
(Copy the exact emit payload from the existing `handleScheduleTriggered` — match `source`, `skillName`, `actionName`, `agentDefinitions`, `priority` to what's there now.) Remove the now-unused `handleScheduleTriggered`. Keep `buildSnapshot`. Ensure `generateId`, `SUITE_PROACTIVE_INTELLIGENCE`, `AGENT_PATTERN_ANALYZER` imports remain.

- [ ] **Step 3: Update the test (if present)**

Run: `grep -rln "data-collector\|pattern-analysis\|buildSnapshot" suites/proactive-intelligence/__tests__ packages/core/src/__tests__ 2>/dev/null`
Adapt any schedule:triggered-emit test to invoke the registered `pattern-analysis` job; preserve assertions (esp. that an `agent:task:request` is emitted with the snapshot prompt).

- [ ] **Step 4: Build + lint + commit**

Run: `npm run build -w packages/shared -w packages/core` (clean)
Run: `npx eslint --max-warnings 0 suites/proactive-intelligence/services/data-collector.ts` (clean)
```bash
git add suites/proactive-intelligence/services/data-collector.ts
```
```bash
git commit -m "feat(schedules): data-collector registers a pattern-analysis job instead of listening to schedule:triggered"
```

---

### Task 5: maintenance-runner registers a `system-maintenance` job

**Files:**
- Modify: `suites/_orchestrator/services/maintenance-runner.ts`

- [ ] **Step 1: Register the job in `start()`**

In `suites/_orchestrator/services/maintenance-runner.ts`, in `start(context)`, after the existing `eventBus.on('agent:task:request', ...)` block, ADD:

```ts
    context.jobRegistry.register('system-maintenance', async () => {
      await runMaintenance(generateId());
      return { summary: 'System maintenance complete' };
    });
```

`runMaintenance` is module-scoped (defined below `service`) and `generateId` is already imported — the closure can call them directly. Keep the existing `agent:task:request` listener (pipelines may still trigger maintenance that way).

- [ ] **Step 2: Build + lint**

Run: `npm run build -w packages/shared -w packages/core` (clean)
Run: `npx eslint --max-warnings 0 suites/_orchestrator/services/maintenance-runner.ts` (clean)

- [ ] **Step 3: Commit**

```bash
git add suites/_orchestrator/services/maintenance-runner.ts
```
```bash
git commit -m "feat(schedules): maintenance-runner registers a system-maintenance job (was orphaned)"
```

---

### Task 6: Schedule YAMLs + retire the 4 legacy rows

**Files:**
- Create: `projects/schedules/ticktick-task-sync.yaml`, `autonomous-task-management.yaml`, `pattern-analysis.yaml`, `system-maintenance.yaml`
- Modify: `config/schedules.json`, `suites/proactive-intelligence/schedules.json`
- Create: `migrations/029-drop-service-schedules.sql`

- [ ] **Step 1: Create the four job schedule YAMLs**

`projects/schedules/ticktick-task-sync.yaml`:
```yaml
name: ticktick-task-sync
cron: "*/15 * * * *"
timezone: UTC
enabled: true
run:
  kind: job
  ref: ticktick-task-sync
```
`projects/schedules/autonomous-task-management.yaml`:
```yaml
name: autonomous-task-management
cron: "0 */6 * * *"
timezone: UTC
enabled: true
run:
  kind: job
  ref: autonomous-task-management
```
`projects/schedules/pattern-analysis.yaml`:
```yaml
name: pattern-analysis
cron: "0 */6 * * *"
timezone: UTC
enabled: true
run:
  kind: job
  ref: pattern-analysis
```
`projects/schedules/system-maintenance.yaml`:
```yaml
name: system-maintenance
cron: "0 2 * * 0"
timezone: UTC
enabled: true
run:
  kind: job
  ref: system-maintenance
```

(The `ref` values must exactly match the job ids registered in Tasks 2-5: `ticktick-task-sync`, `autonomous-task-management`, `pattern-analysis`, `system-maintenance`.)

- [ ] **Step 2: Empty out the legacy seed sources**

Edit `config/schedules.json` — remove `autonomous-task-management`, `ticktick-task-sync`, `system-maintenance`. The file becomes `[]`. Verify:
Run: `node -e "console.log(require('./config/schedules.json'))"`
Expected: `[]`.

Edit `suites/proactive-intelligence/schedules.json` — remove the `pattern-analysis` entry (likely becomes `[]`). Verify:
Run: `cat suites/proactive-intelligence/schedules.json`

- [ ] **Step 3: Migration to delete the persisted legacy rows**

Create `migrations/029-drop-service-schedules.sql`:
```sql
-- ticktick-task-sync, autonomous-task-management, pattern-analysis, system-maintenance now
-- run as Job-Registry jobs via the unified schedule engine. Remove the legacy DB rows so the
-- legacy Scheduler fires nothing.
DELETE FROM schedules WHERE id IN (
  'ticktick-task-sync',
  'autonomous-task-management',
  'pattern-analysis',
  'system-maintenance'
);
```

- [ ] **Step 4: Check for any other seed of these ids**

Run: `grep -rn "ticktick-task-sync\|autonomous-task-management\|pattern-analysis\|system-maintenance" config/ suites/**/schedules.json 2>/dev/null`
Expected: no remaining schedule-seed entries (only code/doc references). Remove any stragglers found in a `schedules.json`.

- [ ] **Step 5: Commit**

```bash
git add projects/schedules/ticktick-task-sync.yaml projects/schedules/autonomous-task-management.yaml projects/schedules/pattern-analysis.yaml projects/schedules/system-maintenance.yaml config/schedules.json suites/proactive-intelligence/schedules.json migrations/029-drop-service-schedules.sql
```
```bash
git commit -m "feat(schedules): move 4 service schedules to run:{kind:job}, retire their legacy rows"
```

---

### Task 7: Full verification

- [ ] **Step 1: Build + targeted tests**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.
Run: `npx vitest run packages/core/src/__tests__/job-registry.test.ts packages/core/src/__tests__/schedule-engine.test.ts packages/core/src/__tests__/schedule-engine-template.test.ts`
Expected: all PASS.

- [ ] **Step 2: Full suite vs baseline**

Run: `npm test`
Expected: only the documented baseline failures — zero NEW failures. (If a service test you converted now fails, fix it to invoke the job rather than emit the event.)

- [ ] **Step 3: Lint/check**

Run: `npm run check`
Expected: our changed files clean (baseline lint debt elsewhere is not ours).

- [ ] **Step 4: Boot smoke — 8 schedules on the engine, legacy empty**

Run: `RAVEN_PORT=4015 timeout 30 node packages/core/dist/index.js > /tmp/raven-1c.log 2>&1`
Then:
Run: `grep -iE "Registered (job|template) schedule|Schedule engine started|Registered job:|029" /tmp/raven-1c.log`
Expected: `Schedule engine started with 8 schedules`; job schedules registered for `ticktick-task-sync`, `autonomous-task-management`, `pattern-analysis`, `system-maintenance` (+ the 3 from 1a + morning-digest template); `Registered job:` lines for the new jobs (from the services + maintenance-runner); migration 029 applied.

- [ ] **Step 5: Legacy scheduler now fires nothing**

Run: `grep -iE "Scheduler initialized with|Registered: " /tmp/raven-1c.log`
Expected: the legacy `Scheduler` reports **0 jobs** ("Scheduler initialized with 0 jobs") and there are no legacy `Registered: <Name>` lines — the `schedules` DB table is empty of user schedules.

Run: `node -e "const db=require('better-sqlite3')('data/raven.db'); console.log(db.prepare('SELECT id FROM schedules').all().map(r=>r.id)); db.close();"`
Expected: `[]` (all legacy rows deleted across migrations 026/028/029).

- [ ] **Step 6: Push**

```bash
git push
```

---

## Follow-up — Plan 1d (NOT in this plan)

Retire the now-idle legacy `Scheduler` class + `ApiDeps.scheduler`; replace health/dashboard `getActiveJobCount`/`getUpcomingRuns` with engine-backed equivalents; rebuild `GET /api/schedules` (unified: YAML defs + computed next-run + preferences-backed `enabled`), `PATCH /api/schedules/:id {enabled}` (a `setEnabled` that starts/stops the cron + persists to the `preferences` table keyed `schedule:enabled:<name>`), `POST /api/schedules/:id/trigger` (run-now via engine); remove the embedded `schedule` triggers from `morning-briefing.yaml` + `system-maintenance.yaml` and the template-scheduler cron loop; remove `orchestrator.handleSchedule` + its dead knowledge cases; update the web `Schedule` type/client; add `?scheduleId=` filter on the task/tree list endpoints; address the `briefing-formatter.ts` taskType coupling so morning-digest's content still delivers.
