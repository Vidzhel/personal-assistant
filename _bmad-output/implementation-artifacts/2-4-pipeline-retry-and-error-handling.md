# Story 2.4: Pipeline Retry & Error Handling

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want failed pipeline steps to retry with configurable backoff and clear error reporting,
so that transient failures resolve automatically and persistent failures surface clearly.

## Acceptance Criteria

1. **Retry with Exponential Backoff** — Given a pipeline step fails and `settings.retry.maxAttempts` is 3, When the step is retried, Then it retries up to 3 times with exponential backoff (baseMs * 2^attempt) before marking as failed.

2. **onError: stop** — Given a pipeline with `onError: stop`, When a step fails after all retries, Then the pipeline halts, status is set to `failed`, and a `pipeline:failed` event is emitted with all remaining nodes marked as `skipped`.

3. **onError: continue** — Given a pipeline with `onError: continue`, When a step fails after all retries, Then remaining independent nodes continue executing and the pipeline completes with partial results (status `completed` if any node succeeded, `failed` if all failed).

4. **Step Events with Retry Info** — Given any pipeline step completes or fails, When the event is emitted, Then `pipeline:step:complete` or `pipeline:step:failed` fires with node ID, output/error, duration, and retry attempt count.

5. **Default Retry Behavior** — Given a pipeline with no `settings.retry` configured, When a step fails, Then no retry is attempted (maxAttempts defaults to 1 via Zod schema, meaning one attempt total = no retries). The step fails immediately.

6. **Retry Events** — Given a step is being retried, When each retry attempt starts, Then a `pipeline:step:retry` event is emitted with nodeId, attempt number, maxAttempts, and backoff delay.

7. **No Retry on Condition/Merge/Delay Nodes** — Given a non-skill node (condition, merge, delay) fails, When the error is evaluated, Then no retry is attempted regardless of retry settings (retries only apply to skill-action nodes).

## Tasks / Subtasks

- [x] Task 1: Add `pipeline:step:retry` event type (AC: #6)
  - [x] 1.1 In `packages/shared/src/types/events.ts`, add `PipelineStepRetryEvent` interface with type `'pipeline:step:retry'` and payload: `{ runId, pipelineName, nodeId, attempt, maxAttempts, backoffMs, timestamp }`
  - [x] 1.2 Add `'pipeline:step:retry'` to `RavenEventType` union
  - [x] 1.3 Add `PipelineStepRetryEvent` to `RavenEvent` union

- [x] Task 2: Update `PipelineStepFailedEvent` payload (AC: #4)
  - [x] 2.1 Add optional `attempt?: number` and `maxAttempts?: number` fields to `PipelineStepFailedEvent.payload`
  - [x] 2.2 Add same fields to `PipelineStepCompleteEvent.payload` (always `attempt: 1` for non-retried nodes)

- [x] Task 3: Implement retry logic in `pipeline-executor.ts` (AC: #1, #2, #3, #5, #6, #7)
  - [x] 3.1 Extract retry settings from `pipeline.config.settings?.retry` — default `maxAttempts: 1` (Zod default is 3, but `retry` itself is optional — when `settings.retry` is undefined, treat as no retry = 1 attempt)
  - [x] 3.2 Create `executeNodeWithRetry(ctx: NodeContext, retryConfig: { maxAttempts: number; backoffMs: number }): Promise<{ output?: unknown; error?: string; attempts: number }>` function
  - [x] 3.3 Retry logic: only retry skill-action nodes (check `node.type` — if it's `condition`, `delay`, `merge`, `code`, `switch`, skip retry). For skill-action nodes (no `type` field or `type` is undefined), retry up to `maxAttempts` times
  - [x] 3.4 Exponential backoff: `backoffMs * Math.pow(2, attempt - 1)` where attempt is 0-indexed retry number. First attempt has no delay. Second attempt waits `backoffMs`. Third waits `backoffMs * 2`. Fourth waits `backoffMs * 4`, etc.
  - [x] 3.5 Emit `pipeline:step:retry` event before each retry wait (not before first attempt)
  - [x] 3.6 Update the `executeNode` call site in `executePipeline` to use `executeNodeWithRetry`
  - [x] 3.7 Include `attempt` and `maxAttempts` in `pipeline:step:complete` and `pipeline:step:failed` event payloads
  - [x] 3.8 The `onError: continue` behavior already works correctly in the existing code — failed nodes don't block independent downstream nodes. Verify this still works with retries (the retry loop completes before the node result is evaluated by the level-processing logic)

- [x] Task 4: Tests (AC: all)
  - [x] 4.1 Unit tests for retry logic in `pipeline-executor.test.ts` (extend existing file):
    - Step retries up to maxAttempts with exponential backoff delays
    - Step succeeds on retry (fails first, succeeds on second attempt)
    - Step fails after all retries exhausted — final error reported
    - No retry when `settings.retry` is undefined (single attempt)
    - No retry for condition/merge/delay nodes even with retry config
    - `pipeline:step:retry` event emitted before each retry
    - `pipeline:step:failed` event includes attempt and maxAttempts
    - `pipeline:step:complete` event includes attempt number (1 for first try, 2 for first retry success)
    - `onError: stop` still works — pipeline halts after node fails all retries
    - `onError: continue` still works — remaining nodes execute after node fails all retries
  - [x] 4.2 Verify all existing pipeline-executor tests still pass (no regressions)
  - [x] 4.3 Do NOT add tests to other test files — all retry logic is internal to the executor

## Dev Notes

### Architecture Constraints

- **Retry is INTERNAL to the executor** — the retry loop wraps individual `executeNode` calls inside `executePipeline`. The pipeline engine, scheduler, and event triggers are unaware of retries. They just see a node that takes longer to complete.
- **Exponential backoff uses `setTimeout`** — use `await new Promise(resolve => setTimeout(resolve, delayMs))` for the delay. This is non-blocking (NFR18).
- **Retry config comes from `pipeline.config.settings?.retry`** — when undefined, no retries (1 attempt). When defined, `maxAttempts` (Zod default 3) and `backoffMs` (Zod default 5000) are used.
- **Only skill-action nodes retry** — condition, delay, merge, code, switch nodes do not retry. These are deterministic or internal — if they fail, it's a logic error, not a transient failure.
- **`onError` behavior unchanged** — the existing `onError: stop` / `continue` logic in `executePipeline` already works correctly. The retry loop just wraps the `executeNode` call so that a node only reports as "failed" after all retry attempts are exhausted.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|-----------|----------|-----------|
| `PipelineExecutor` | `packages/core/src/pipeline-engine/pipeline-executor.ts` | Add retry logic here — wrap `executeNode` call in retry loop |
| `PipelineRetrySchema` | `packages/shared/src/types/pipelines.ts` | Already exists: `maxAttempts` (default 3), `backoffMs` (default 5000). Schema is correct, no changes needed |
| `PipelineSettingsSchema` | `packages/shared/src/types/pipelines.ts` | Already has `retry: PipelineRetrySchema.optional()`, `onError`. No changes needed |
| `PipelineStepFailedEvent` | `packages/shared/src/types/events.ts` | Extend payload with `attempt?` and `maxAttempts?` fields |
| `PipelineStepCompleteEvent` | `packages/shared/src/types/events.ts` | Extend payload with `attempt?` and `maxAttempts?` fields |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | Used to emit retry events — already available via `emitEvent` helper in executor |
| `morning-briefing.yaml` | `config/pipelines/morning-briefing.yaml` | Has `settings.retry.maxAttempts: 3, backoffMs: 5000` — will benefit from this story |
| `waitForTaskCompletion` | `pipeline-executor.ts` | Existing function — used by `executeSkillActionNode`. No changes needed |
| `pipeline-executor.test.ts` | `packages/core/src/__tests__/pipeline-executor.test.ts` | Add retry tests here — extend existing file |

### How Retry Works (End-to-End)

```
Pipeline execution starts
  → For each topological level, nodes execute in parallel
  → For each node in level:
    → executeNodeWithRetry(ctx, retryConfig) called
    → Attempt 1: executeNode(ctx) runs
      → If success: return { output, attempts: 1 }
      → If failure AND node is skill-action AND attempts < maxAttempts:
        → Emit pipeline:step:retry event
        → Wait backoffMs * 2^(attempt-1) ms
        → Attempt 2: executeNode(ctx) runs
          → If success: return { output, attempts: 2 }
          → If failure AND attempts < maxAttempts:
            → Emit pipeline:step:retry event
            → Wait backoffMs * 2^(attempt-1) ms
            → Attempt 3: ...
    → Final result (success or failure after all attempts) flows into existing level-processing logic
    → Existing onError: stop/continue behavior handles the final result
```

### Key Code Patterns

**Retry wrapper function:**
```typescript
async function executeNodeWithRetry(
  ctx: NodeContext,
  retryConfig: { maxAttempts: number; backoffMs: number },
): Promise<{ output?: unknown; error?: string; attempts: number }> {
  const node = ctx.pipeline.config.nodes[ctx.nodeId];
  // Only retry skill-action nodes (no type field = skill-action)
  const isRetryable = !node?.type;
  const maxAttempts = isRetryable ? retryConfig.maxAttempts : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await executeNode(ctx);

    if (!result.error || attempt === maxAttempts) {
      return { ...result, attempts: attempt };
    }

    // Emit retry event
    const backoffMs = retryConfig.backoffMs * Math.pow(2, attempt - 1);
    emitEvent({
      id: generateId(),
      timestamp: Date.now(),
      source: 'pipeline-executor',
      type: 'pipeline:step:retry',
      payload: {
        runId: /* from outer scope */,
        pipelineName: ctx.pipeline.config.name,
        nodeId: ctx.nodeId,
        attempt,
        maxAttempts,
        backoffMs,
        error: result.error,
        timestamp: new Date().toISOString(),
      },
    });

    log.warn(`Retrying node ${ctx.nodeId} (attempt ${attempt + 1}/${maxAttempts}) after ${backoffMs}ms`);
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }

  // Should not reach here, but TypeScript needs it
  return { error: 'Retry logic error', attempts: maxAttempts };
}
```

**Extracting retry config:**
```typescript
// Inside executePipeline, before the level loop:
const retrySettings = pipeline.config.settings?.retry;
const retryConfig = {
  maxAttempts: retrySettings?.maxAttempts ?? 1,
  backoffMs: retrySettings?.backoffMs ?? 5000,
};
```

**Updated node execution in level loop:**
```typescript
// Replace: const result = await executeNode({ ... });
// With:
const retryResult = await executeNodeWithRetry(
  { pipeline, nodeId, nodeOutputs, conditionResults, timeoutMs },
  retryConfig,
);
const result = { output: retryResult.output, error: retryResult.error };
const attempts = retryResult.attempts;

// Include in step events:
// pipeline:step:complete payload: { ..., attempt: attempts, maxAttempts: retryConfig.maxAttempts }
// pipeline:step:failed payload: { ..., attempt: attempts, maxAttempts: retryConfig.maxAttempts }
```

**Testing retry with timer mocks:**
```typescript
// Use vi.useFakeTimers() for backoff delay tests
// But be careful — waitForTaskCompletion also uses setTimeout
// Better approach: mock the delay function separately
// Or test with real timers and small backoffMs (e.g., 10ms)

// Simplest approach — use small backoffMs in test pipelines:
const pipeline = makeValidatedPipeline({
  settings: { retry: { maxAttempts: 3, backoffMs: 10 } }, // 10ms for fast tests
  // ...
});
```

### Previous Story Intelligence

**From Story 2-3 (Pipeline Scheduling & Event Triggers):**
- Pipeline scheduler uses `triggerPipeline` (non-blocking) — retry delays inside executor don't block the scheduler
- Concurrent execution guard uses `pipeline:complete` / `pipeline:failed` events — these fire AFTER all retries are exhausted, so the guard works correctly
- 304 tests passing — don't break them
- Code review feedback: sync throw safety in scheduler/event-trigger — the executor's retry logic is all async, so no sync throw concerns

**From Story 2-2 (Pipeline Execution Engine):**
- `executeNode` is the function to wrap with retry — it already returns `{ output?, error? }`
- `executePipeline` has the level-by-level loop with `onError` handling — retry is transparent to this loop
- `emitEvent` helper available in closure — use for retry events
- `NodeContext` interface has all needed context — `pipeline`, `nodeId`, `nodeOutputs`, `conditionResults`, `timeoutMs`
- `waitForTaskCompletion` handles task completion/failure events — each retry attempt gets a fresh `waitForTaskCompletion` call since `executeSkillActionNode` creates a new `taskId` per call
- `LoggerInterface` uses `(msg: string, ...args)` format

**From Story 2-1 (Pipeline YAML Loader):**
- `PipelineRetrySchema` already validated at load time — no need to re-validate in executor
- `settings.retry` is optional — when undefined, no retries

### Git Intelligence

**Recent commits:**
```
3c6eb2a feat: story 2-3 — pipeline scheduling and event triggers
cf8db9c feat: story 2-2 — pipeline execution engine, DAG runner, and condition evaluator
b78c04e feat: story 2-1 — pipeline YAML loader, validation, and hot-reload
```

**Patterns:**
- `feat: story X-Y — description` for story commit messages
- DI via factory functions with typed deps — `createPipelineExecutor(deps)`
- Tests in `packages/core/src/__tests__/`
- Extend existing test files when adding to existing modules

### Testing Strategy

- **Extend `pipeline-executor.test.ts`** — all retry tests go in the existing file, new `describe('retry behavior', ...)` block
- **Use real timers with small backoffMs** (10ms) — simpler than fake timers, avoids conflicts with `waitForTaskCompletion` setTimeout
- **Mock task completion** — use existing pattern: emit `agent:task:complete` on `eventBus` to resolve `waitForTaskCompletion`. For retry tests, emit failure first, then success on subsequent attempts
- **Track emitted events** — use `eventBus.on('pipeline:step:retry', handler)` to capture and assert retry events
- **No new mock helpers needed** — existing `makeMockSuiteRegistry`, `makeMockMcpManager`, `makeMockPipelineStore`, `makeValidatedPipeline` are sufficient
- **Temp SQLite DBs not needed** — executor uses mock `PipelineStore`

### File Structure

**Modified files:**
- `packages/shared/src/types/events.ts` — Add `PipelineStepRetryEvent`, extend step event payloads
- `packages/core/src/pipeline-engine/pipeline-executor.ts` — Add `executeNodeWithRetry` function, update level loop
- `packages/core/src/__tests__/pipeline-executor.test.ts` — Add retry test suite

**No new files needed** — this is purely an enhancement to existing modules.

### Project Structure Notes

- All changes are within existing files — no new modules or directories
- `pipeline-executor.ts` is currently ~250 lines — adding retry (~40 lines) keeps it well under 300
- No changes to `@raven/shared` types beyond event extensions (no new Zod schemas needed)
- No database changes — retry is purely in-memory logic
- No changes to boot sequence (`index.ts`), pipeline engine, scheduler, or event trigger

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2-Story-2.4]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline-YAML-Schema] — settings.retry section
- [Source: _bmad-output/planning-artifacts/architecture.md#Process-Patterns] — error handling, pipeline step failures
- [Source: _bmad-output/planning-artifacts/prd.md#FR16] — System retries failed pipeline steps with configurable retry policy
- [Source: _bmad-output/planning-artifacts/prd.md#NFR10] — Scheduled pipelines that fail are retried with exponential backoff (max 3 retries)
- [Source: _bmad-output/planning-artifacts/prd.md#NFR18] — Pipeline step execution must not block event loop
- [Source: packages/core/src/pipeline-engine/pipeline-executor.ts] — executeNode, executePipeline, emitEvent
- [Source: packages/shared/src/types/pipelines.ts] — PipelineRetrySchema, PipelineSettingsSchema
- [Source: packages/shared/src/types/events.ts] — PipelineStepCompleteEvent, PipelineStepFailedEvent
- [Source: packages/core/src/__tests__/pipeline-executor.test.ts] — existing test patterns, mock helpers
- [Source: _bmad-output/implementation-artifacts/2-3-pipeline-scheduling-and-event-triggers.md] — previous story patterns
- [Source: _bmad-output/implementation-artifacts/2-2-pipeline-execution-engine-and-dag-runner.md] — executor implementation details

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- ✅ Task 1: Added `PipelineStepRetryEvent` interface and added to `RavenEvent` union and `RavenEventType`
- ✅ Task 2: Extended `PipelineStepCompleteEvent` and `PipelineStepFailedEvent` with optional `attempt` and `maxAttempts` fields
- ✅ Task 3: Implemented `executeNodeWithRetry` function wrapping `executeNode` with configurable retry + exponential backoff. Only skill-action nodes retry. Retry events emitted before each wait. Attempt counts included in step complete/failed events.
- ✅ Task 4: Added 10 retry-specific tests covering all ACs. All 314 tests pass (0 regressions). All tests in single file as specified.

### Change Log

- 2026-03-14: Implemented pipeline retry & error handling (Story 2-4) — all ACs satisfied

### File List

- `packages/shared/src/types/events.ts` — Added `PipelineStepRetryEvent`, extended step event payloads with attempt/maxAttempts
- `packages/core/src/pipeline-engine/pipeline-executor.ts` — Added `executeNodeWithRetry`, `RetryConfig` interface, updated level loop to use retry wrapper
- `packages/core/src/__tests__/pipeline-executor.test.ts` — Added `autoFailThenSucceedAgentTasks` helper, 10 retry behavior tests, code review fixes
- `packages/core/src/__tests__/pipeline-scheduler.test.ts` — Formatting only (object literal multi-line)
