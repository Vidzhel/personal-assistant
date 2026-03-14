# Story 2.3: Pipeline Scheduling & Event Triggers

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want pipelines to trigger on cron schedules and in response to system events,
so that automation runs at the right time without manual intervention.

## Acceptance Criteria

1. **Cron Trigger** — Given a pipeline with `trigger.type: cron` and `schedule: "0 6 * * *"`, When the scheduler ticks at 06:00, Then the pipeline execution starts automatically.

2. **Event Trigger** — Given a pipeline with `trigger.type: event` and `event: "email:new"`, When an `email:new` event is emitted on the bus, Then the pipeline execution starts automatically.

3. **Execution Recording** — Given a pipeline execution completes (triggered by cron or event), When the result is stored, Then a `pipeline_runs` record is written with pipeline_name, trigger_type (`cron` or `event`), status, started_at, completed_at, node_results.

4. **Disabled Pipeline Ignored** — Given a pipeline is disabled (`enabled: false`), When its cron time arrives or matching event fires, Then no execution occurs.

5. **Hot-Reload Support** — Given pipelines are reloaded (file watcher or API), When new/changed pipelines have cron triggers, Then cron jobs are re-registered accordingly (old jobs stopped, new jobs created).

6. **Event Filter** — Given a pipeline with `trigger.type: event`, `event: "email:new"`, and `filter: { sender: "@important.com" }`, When an `email:new` event fires, Then the pipeline only triggers if the event payload matches the filter.

7. **Concurrent Execution Guard** — Given a cron-triggered pipeline is already running, When the same cron fires again, Then the second execution is skipped with a log warning (no duplicate runs).

## Tasks / Subtasks

- [x] Task 1: Create Pipeline Scheduler Module (AC: #1, #4, #5, #7)
  - [x] 1.1 Create `packages/core/src/pipeline-engine/pipeline-scheduler.ts` — factory function `createPipelineScheduler(deps: PipelineSchedulerDeps): PipelineScheduler`
  - [x] 1.2 `PipelineSchedulerDeps`: `{ pipelineEngine: PipelineEngine, eventBus: EventBus, timezone: string }`
  - [x] 1.3 `registerPipelines(): void` — iterates all pipelines from `pipelineEngine.getAllPipelines()`, registers cron jobs for those with `trigger.type === 'cron'` and `enabled: true`
  - [x] 1.4 For each cron pipeline: create a `Cron` job (from `croner`) using `pipeline.config.trigger.schedule` and timezone. On fire: call `pipelineEngine.triggerPipeline(name, 'cron')` (non-blocking — uses `triggerPipeline` not `executePipeline`)
  - [x] 1.5 Track running pipelines in a `Set<string>` — skip cron fire if pipeline name already in the set. Remove from set when `pipeline:complete` or `pipeline:failed` event received
  - [x] 1.6 `handlePipelinesReloaded(): void` — stop all existing cron jobs, re-register from current pipeline state. Listen for `config:pipelines:reloaded` event to trigger this
  - [x] 1.7 `shutdown(): void` — stop all cron jobs, clean up event listeners
  - [x] 1.8 Interface: `PipelineScheduler { registerPipelines, shutdown }`
  - [x] 1.9 Skip disabled pipelines and non-cron trigger types silently

- [x] Task 2: Create Pipeline Event Trigger Module (AC: #2, #4, #6)
  - [x] 2.1 Create `packages/core/src/pipeline-engine/pipeline-event-trigger.ts` — factory function `createPipelineEventTrigger(deps: PipelineEventTriggerDeps): PipelineEventTrigger`
  - [x] 2.2 `PipelineEventTriggerDeps`: `{ pipelineEngine: PipelineEngine, eventBus: EventBus }`
  - [x] 2.3 `registerPipelines(): void` — iterates all pipelines, finds those with `trigger.type === 'event'` and `enabled: true`, subscribes to the specified event type on the event bus
  - [x] 2.4 On event match: call `pipelineEngine.triggerPipeline(name, 'event')` (non-blocking)
  - [x] 2.5 `matchesFilter(event: RavenEvent, filter: Record<string, unknown>): boolean` — shallow key-value match on `event.payload`. All filter keys must match (AND logic). String values support substring matching (e.g., `{ sender: "@important.com" }` matches `sender: "alice@important.com"`)
  - [x] 2.6 Skip disabled pipelines silently
  - [x] 2.7 `handlePipelinesReloaded(): void` — unsubscribe all event listeners, re-register from current state. Listen for `config:pipelines:reloaded` event
  - [x] 2.8 `shutdown(): void` — unsubscribe all event listeners
  - [x] 2.9 Interface: `PipelineEventTrigger { registerPipelines, shutdown }`

- [x] Task 3: Wire into Boot Sequence (AC: #1, #2, #3)
  - [x] 3.1 In `packages/core/src/index.ts`, after `pipelineEngine.initialize()`:
    - Create `pipelineScheduler` via `createPipelineScheduler({ pipelineEngine, eventBus, timezone: config.RAVEN_TIMEZONE })`
    - Create `pipelineEventTrigger` via `createPipelineEventTrigger({ pipelineEngine, eventBus })`
    - Call `pipelineScheduler.registerPipelines()`
    - Call `pipelineEventTrigger.registerPipelines()`
  - [x] 3.2 Add `pipelineScheduler.shutdown()` and `pipelineEventTrigger.shutdown()` to the graceful shutdown handler
  - [x] 3.3 Log initialized counts: `"Pipeline scheduler: X cron jobs, Y event triggers"`

- [x] Task 4: Tests (AC: all)
  - [x] 4.1 Unit tests for `pipeline-scheduler.ts`:
    - Registers cron job for cron-triggered pipeline
    - Skips disabled pipelines (no cron job created)
    - Skips non-cron trigger types
    - Calls `triggerPipeline` when cron fires (mock Cron callback)
    - Skips execution when pipeline already running (concurrent guard)
    - Removes pipeline from running set on `pipeline:complete` / `pipeline:failed` event
    - Re-registers on `config:pipelines:reloaded` event (old jobs stopped, new jobs created)
    - Shutdown stops all cron jobs
  - [x] 4.2 Unit tests for `pipeline-event-trigger.ts`:
    - Subscribes to correct event type for event-triggered pipeline
    - Skips disabled pipelines
    - Calls `triggerPipeline` on matching event
    - Filter matching: exact match works
    - Filter matching: substring match for string values
    - Filter matching: skips when filter doesn't match
    - Filter matching: no filter means all events of that type trigger
    - Re-registers on `config:pipelines:reloaded`
    - Shutdown unsubscribes all listeners
  - [x] 4.3 Update existing test mocks in `api.test.ts` and `e2e.test.ts` if boot sequence changes affect them
  - [x] 4.4 Do NOT mock Croner directly — mock `pipelineEngine.triggerPipeline` and invoke the cron callback directly in tests

## Dev Notes

### Architecture Constraints

- **Non-blocking execution** — Use `pipelineEngine.triggerPipeline(name, triggerType)` which returns `{ runId, execution: Promise }` immediately. The execution runs in background. NEVER use `await pipelineEngine.executePipeline()` from a cron callback or event handler — this would block the scheduler/event loop.
- **Croner library** — Already a dependency (`croner` ^9.0.0). Import as `import { Cron } from 'croner'`. Constructor: `new Cron(pattern, { timezone }, callback)`. Methods: `job.stop()`, `job.nextRun()`.
- **Pipeline engine is the authority** — Don't bypass it. Always go through `pipelineEngine.triggerPipeline()` which validates existence and enabled status.
- **Event bus subscription model** — `eventBus.on(eventType, handler)` and `eventBus.off(eventType, handler)`. Handlers receive `RavenEvent`. Keep references to handlers for cleanup.
- **No database involvement** — Pipeline scheduling is purely in-memory (Croner jobs + event listeners). The pipeline engine already handles DB recording via `pipeline_runs` table. The scheduler/trigger modules just fire and forget.
- **Separation of concerns** — Pipeline scheduler (cron) and pipeline event trigger (events) are SEPARATE modules, not one combined module. They have different lifecycle concerns and different testing needs.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|-----------|----------|-----------|
| `Scheduler` class | `packages/core/src/scheduler/scheduler.ts` | Existing skill scheduler — uses Croner, emits `schedule:triggered`. Pipeline scheduler is SEPARATE from this. Do NOT extend the Scheduler class. |
| `PipelineEngine` | `packages/core/src/pipeline-engine/pipeline-engine.ts` | Has `triggerPipeline(name, triggerType)` returning `{ runId, execution: Promise }` — use this for non-blocking execution |
| `PipelineLoader` | `packages/core/src/pipeline-engine/pipeline-loader.ts` | Emits `config:pipelines:reloaded` event when pipelines change — listen for this |
| `PipelineTriggerSchema` | `packages/shared/src/types/pipelines.ts` | Discriminated union: `cron` (has `schedule`), `event` (has `event`, optional `filter`), `manual`, `webhook` |
| `ValidatedPipeline` | `packages/core/src/pipeline-engine/pipeline-loader.ts` | Has `config.trigger` — access trigger type and schedule/event details |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | `emit()`, `on(type, handler)`, `off(type, handler)` |
| `ConfigPipelinesReloadedEvent` | `packages/shared/src/types/events.ts` | Type: `config:pipelines:reloaded` — fired when pipeline YAML files are reloaded |
| `PipelineCompleteEvent` | `packages/shared/src/types/events.ts` | Type: `pipeline:complete` — payload has `runId`, `pipelineName` |
| `PipelineFailedEvent` | `packages/shared/src/types/events.ts` | Type: `pipeline:failed` — payload has `runId`, `pipelineName` |
| `morning-briefing.yaml` | `config/pipelines/morning-briefing.yaml` | Example pipeline with `trigger.type: cron`, `schedule: "0 6 * * *"` — this should auto-register when pipeline scheduler starts |

### How the Pipeline Scheduler Works (End-to-End)

```
Boot Sequence:
1. PipelineEngine.initialize() → loads YAML files, validates
2. PipelineScheduler.registerPipelines() → reads all pipelines, creates Cron jobs for cron-triggered ones
3. PipelineEventTrigger.registerPipelines() → reads all pipelines, subscribes to events for event-triggered ones

Cron Trigger Flow:
Croner fires callback
  → PipelineScheduler checks if pipeline already running (concurrent guard)
  → If not running: pipelineEngine.triggerPipeline(name, 'cron')
  → Pipeline executor runs in background
  → On pipeline:complete/failed event → remove from running set

Event Trigger Flow:
EventBus receives email:new (or other event)
  → PipelineEventTrigger handler fires
  → matchesFilter(event, filter) checks payload
  → If match: pipelineEngine.triggerPipeline(name, 'event')
  → Pipeline executor runs in background

Hot-Reload Flow:
config:pipelines:reloaded event
  → PipelineScheduler.handlePipelinesReloaded() → stop all Cron jobs, re-register
  → PipelineEventTrigger.handlePipelinesReloaded() → unsubscribe all, re-subscribe
```

### Key Code Patterns

**Pipeline Scheduler (factory function):**
```typescript
import { Cron } from 'croner';
import { createLogger } from '@raven/shared';
import type { PipelineEngine } from './pipeline-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';

export interface PipelineScheduler {
  registerPipelines: () => void;
  shutdown: () => void;
}

export interface PipelineSchedulerDeps {
  pipelineEngine: PipelineEngine;
  eventBus: EventBus;
  timezone: string;
}

export function createPipelineScheduler(deps: PipelineSchedulerDeps): PipelineScheduler {
  const cronJobs = new Map<string, Cron>();
  const runningPipelines = new Set<string>();
  // ... implementation
}
```

**Event Trigger Filter Matching:**
```typescript
function matchesFilter(
  eventPayload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, filterValue]) => {
    const payloadValue = eventPayload[key];
    if (payloadValue === undefined) return false;
    // String substring match
    if (typeof filterValue === 'string' && typeof payloadValue === 'string') {
      return payloadValue.includes(filterValue);
    }
    // Exact match for other types
    return payloadValue === filterValue;
  });
}
```

**Accessing trigger details from ValidatedPipeline:**
```typescript
const pipeline = pipelineEngine.getPipeline('morning-briefing');
if (pipeline?.config.trigger.type === 'cron') {
  const schedule = pipeline.config.trigger.schedule; // "0 6 * * *"
}
if (pipeline?.config.trigger.type === 'event') {
  const eventType = pipeline.config.trigger.event; // "email:new"
  const filter = pipeline.config.trigger.filter;   // { sender: "@important.com" } | undefined
}
```

**Non-blocking pipeline trigger (from pipeline-engine.ts):**
```typescript
// triggerPipeline returns immediately with runId + background promise
const { runId, execution } = pipelineEngine.triggerPipeline(name, 'cron');
// execution is a Promise<PipelineRunResult> that runs in background
// Do NOT await it from the scheduler — let it run
// The pipeline:complete/failed events will fire when done
execution.catch((err) => {
  log.error(`Pipeline ${name} failed: ${err}`);
});
```

### Previous Story Intelligence

**From Story 2-2 (Pipeline Execution Engine):**
- `triggerPipeline(name, triggerType)` exists and returns `{ runId, execution: Promise }` — use this, NOT `executePipeline`
- Pipeline executor emits `pipeline:started`, `pipeline:step:complete`, `pipeline:step:failed`, `pipeline:complete`, `pipeline:failed` events — use `pipeline:complete` and `pipeline:failed` for the concurrent execution guard
- `PipelineRunResult` includes `runId`, `pipelineName`, `status`, `durationMs`
- Pipeline executor already handles the full lifecycle: insert run record → execute nodes → update run record → emit events
- `PipelineCompleteEvent.payload` and `PipelineFailedEvent.payload` both contain `pipelineName` — use this to remove from `runningPipelines` set
- `LoggerInterface` uses `(msg: string, ...args)` not Pino object style
- `waitForTaskCompletion` was fixed to check `success` field — event-bus handler patterns work correctly
- All 270 tests passing, 0 regressions — don't break them

**From Story 2-1 (Pipeline YAML Loader):**
- Pipeline loader emits `config:pipelines:reloaded` event when hot-reload fires — listen for this event
- `getAllPipelines()` returns `ValidatedPipeline[]` — use to iterate and find cron/event triggers
- Each `ValidatedPipeline` has `config.trigger` which is the parsed `PipelineTrigger` from Zod schema

### Git Intelligence

**Recent commits:**
```
cf8db9c feat: story 2-2 — pipeline execution engine, DAG runner, and condition evaluator
b78c04e feat: story 2-1 — pipeline YAML loader, validation, and hot-reload
5ffa00e feat: extract MCP/suite constants, fail loudly on missing env vars, isolate spawned agents
```

**Patterns:**
- `feat: story X-Y — description` for story implementations
- DI via factory functions with typed deps interfaces — follow this pattern
- Tests in `packages/core/src/__tests__/`
- All new deps added to existing test mocks if boot sequence changes

### Testing Strategy

- **Unit tests for pipeline-scheduler**: Mock `PipelineEngine` (return mock pipelines with cron triggers), mock `EventBus`. Don't mock Croner directly — instead, capture the callback passed to `Cron` constructor and invoke it manually in tests. Verify `triggerPipeline` is called.
- **Unit tests for pipeline-event-trigger**: Mock `PipelineEngine`, use real `EventBus` (it's lightweight). Emit events and verify `triggerPipeline` is called.
- **Filter matching tests**: Pure function — test with various payload/filter combos.
- **Concurrent guard tests**: Trigger cron twice, verify second is skipped. Emit `pipeline:complete`, verify third trigger proceeds.
- **Hot-reload tests**: Register, emit `config:pipelines:reloaded`, verify old jobs stopped and new ones created.
- **Temp SQLite DBs not needed** — these modules are purely in-memory (no DB access).

### File Structure

**New files:**
- `packages/core/src/pipeline-engine/pipeline-scheduler.ts` — Cron registration for cron-triggered pipelines
- `packages/core/src/pipeline-engine/pipeline-event-trigger.ts` — Event bus subscription for event-triggered pipelines
- `packages/core/src/__tests__/pipeline-scheduler.test.ts` — Unit tests for pipeline scheduler
- `packages/core/src/__tests__/pipeline-event-trigger.test.ts` — Unit tests for event trigger

**Modified files:**
- `packages/core/src/index.ts` — Wire pipeline scheduler and event trigger into boot sequence + shutdown

### Project Structure Notes

- Both new modules live in `packages/core/src/pipeline-engine/` alongside existing pipeline code
- Each should be well under 300 lines — they're thin glue layers
- No new types needed in `@raven/shared` — all trigger types already exist in `PipelineTriggerSchema`
- No new database migrations — no DB involvement
- No changes to `@raven/shared` needed — use existing event types

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2-Story-2.3]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline-YAML-Schema] — trigger section
- [Source: _bmad-output/planning-artifacts/architecture.md#Integration-Points] — Scheduler → Pipeline Engine, Event Bus → Pipeline Engine
- [Source: _bmad-output/planning-artifacts/prd.md#FR12] — System executes pipelines on cron schedules
- [Source: _bmad-output/planning-artifacts/prd.md#FR13] — System executes pipelines in response to events
- [Source: _bmad-output/planning-artifacts/prd.md#NFR10] — Scheduled pipelines that fail are retried
- [Source: _bmad-output/planning-artifacts/prd.md#NFR18] — Pipeline step execution must not block event loop
- [Source: packages/core/src/pipeline-engine/pipeline-engine.ts] — triggerPipeline() non-blocking API
- [Source: packages/core/src/pipeline-engine/pipeline-executor.ts] — execution engine, event emissions
- [Source: packages/core/src/pipeline-engine/pipeline-loader.ts] — getAllPipelines(), config:pipelines:reloaded event
- [Source: packages/core/src/scheduler/scheduler.ts] — existing Croner usage pattern (separate from pipeline scheduler)
- [Source: packages/shared/src/types/pipelines.ts] — PipelineTriggerSchema, PipelineConfig
- [Source: packages/shared/src/types/events.ts] — event types for pipeline:complete, pipeline:failed, config:pipelines:reloaded
- [Source: packages/core/src/index.ts] — boot sequence, injection point after line 140
- [Source: config/pipelines/morning-briefing.yaml] — real cron-triggered pipeline example
- [Source: _bmad-output/implementation-artifacts/2-2-pipeline-execution-engine-and-dag-runner.md] — previous story patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- ✅ Task 1: Created `pipeline-scheduler.ts` — factory function with Croner-based cron registration, concurrent execution guard via `Set<string>`, hot-reload via `config:pipelines:reloaded` event, graceful shutdown
- ✅ Task 2: Created `pipeline-event-trigger.ts` — factory function with event bus subscriptions, `matchesFilter()` exported for testing (shallow key-value match with string substring support), hot-reload, graceful shutdown
- ✅ Task 3: Wired both modules into `index.ts` boot sequence after `pipelineEngine.initialize()`, added shutdown calls before `pipelineEngine.shutdown()`, added log with cron/event trigger counts
- ✅ Task 4: 30 tests (11 scheduler + 19 event trigger including 8 matchesFilter tests). No existing mock changes needed — api.test.ts and e2e.test.ts don't import index.ts directly. Croner mocked via class mock, triggerPipeline verified via vi.fn(). All 304 tests pass, 0 regressions.

### Change Log

- 2026-03-14: Story 2-3 implementation complete — pipeline scheduling and event triggers
- 2026-03-14: Code review fixes — sync throw safety in scheduler/event-trigger, runningPipelines cleared on reload, shutdown test assertions strengthened

### File List

**New files:**
- `packages/core/src/pipeline-engine/pipeline-scheduler.ts`
- `packages/core/src/pipeline-engine/pipeline-event-trigger.ts`
- `packages/core/src/__tests__/pipeline-scheduler.test.ts`
- `packages/core/src/__tests__/pipeline-event-trigger.test.ts`

**Modified files:**
- `packages/core/src/index.ts`
