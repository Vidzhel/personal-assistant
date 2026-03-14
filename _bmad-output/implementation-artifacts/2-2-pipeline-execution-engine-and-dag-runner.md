# Story 2.2: Pipeline Execution Engine & DAG Runner

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want pipelines to execute their nodes in dependency order with parallel execution where possible,
so that automation workflows run efficiently and correctly.

## Acceptance Criteria

1. **Sequential Execution** — Given a pipeline with nodes A→B→C (sequential), When the pipeline executes, Then A completes before B starts, B completes before C starts.

2. **Parallel Execution** — Given a pipeline with nodes A and B (no dependencies) both feeding into C, When the pipeline executes, Then A and B execute in parallel, C executes after both complete.

3. **Condition Branching** — Given a node of type `condition` with expression `{{ fetch-emails.output.urgentCount > 0 }}`, When the condition evaluates, Then downstream connections follow the matching branch (true/false via `condition` field on connections).

4. **Skill-Action Node Execution** — Given a skill-action node executes, When the agent manager spawns the sub-agent, Then the permission gate is checked and the node output is captured for downstream use.

5. **Execution History** — Given a pipeline execution completes (success or failure), When the result is stored, Then a `pipeline_runs` record is written with pipeline_name, trigger_type, status, started_at, completed_at, node_results (JSON blob of per-node outputs/status).

6. **Pipeline Events** — Given pipeline execution state changes, When a node completes or fails, or the pipeline completes or fails, Then typed events are emitted (`pipeline:started`, `pipeline:step:complete`, `pipeline:step:failed`, `pipeline:complete`, `pipeline:failed`).

7. **Manual Trigger API** — Given a `POST /api/pipelines/:name/trigger` request, When the pipeline exists and is enabled, Then the pipeline executes immediately as a manual trigger.

## Tasks / Subtasks

- [x] Task 1: Pipeline Event Types in @raven/shared (AC: #6)
  - [x] 1.1 Add pipeline execution event types to `packages/shared/src/types/events.ts`: `PipelineStartedEvent`, `PipelineStepCompleteEvent`, `PipelineStepFailedEvent`, `PipelineCompleteEvent`, `PipelineFailedEvent`
  - [x] 1.2 Add event types to `RavenEvent` union and `RavenEventType`
  - [x] 1.3 Add `PipelineRunRecord` type to `packages/shared/src/types/pipelines.ts` matching the `pipeline_runs` table schema
  - [x] 1.4 Build shared package to verify type exports

- [x] Task 2: Pipeline Run Store — DB Read/Write (AC: #5)
  - [x] 2.1 Create `packages/core/src/pipeline-engine/pipeline-store.ts` — factory function `createPipelineStore(deps: { db: DatabaseInterface }): PipelineStore`
  - [x] 2.2 `insertRun(run: PipelineRunRecord): void` — inserts into `pipeline_runs` table
  - [x] 2.3 `updateRun(id: string, updates: Partial<Pick<PipelineRunRecord, 'status' | 'completed_at' | 'node_results' | 'error'>>): void` — updates in-progress run
  - [x] 2.4 `getRun(id: string): PipelineRunRecord | undefined`
  - [x] 2.5 `getRecentRuns(pipelineName: string, limit?: number): PipelineRunRecord[]` — ordered by `started_at` DESC
  - [x] 2.6 Interface: `PipelineStore { insertRun, updateRun, getRun, getRecentRuns }`

- [x] Task 3: Condition Evaluator (AC: #3)
  - [x] 3.1 Create `packages/core/src/pipeline-engine/condition-evaluator.ts` — pure function `evaluateCondition(expression: string, nodeOutputs: Record<string, unknown>): boolean`
  - [x] 3.2 Parse `{{ node-id.output.field }}` template expressions — resolve against `nodeOutputs` map
  - [x] 3.3 Support basic comparisons: `>`, `<`, `>=`, `<=`, `==`, `!=`, truthiness checks
  - [x] 3.4 Return `false` on evaluation errors (log warning, don't crash pipeline)
  - [x] 3.5 SECURITY: No dynamic code execution — use safe expression parser (simple recursive descent or regex-based)

- [x] Task 4: Pipeline Executor — Core DAG Runner (AC: #1, #2, #3, #4, #5, #6)
  - [x] 4.1 Create `packages/core/src/pipeline-engine/pipeline-executor.ts` — factory function `createPipelineExecutor(deps: PipelineExecutorDeps): PipelineExecutor`
  - [x] 4.2 `PipelineExecutorDeps`: `{ eventBus, suiteRegistry, mcpManager, agentManager, permissionEngine?, auditLog?, pendingApprovals?, pipelineStore, db }`
  - [x] 4.3 `executePipeline(pipeline: ValidatedPipeline, triggerType: string): Promise<PipelineRunResult>` — main entry point
  - [x] 4.4 Build execution state: `nodeOutputs: Map<string, unknown>`, `nodeStatus: Map<string, 'pending' | 'running' | 'complete' | 'failed' | 'skipped'>`, `runId: string`
  - [x] 4.5 Insert `pipeline_runs` record with status `running` at start
  - [x] 4.6 Walk the DAG using `executionOrder` from `ValidatedPipeline`:
    - For each node in topological order, check if all upstream dependencies (from `connections`) are complete
    - If all upstream complete → execute node
    - If any upstream failed and `onError: stop` → skip node (mark `skipped`)
    - Nodes at the same topological level with all deps satisfied run in parallel (`Promise.all`)
  - [x] 4.7 Execute skill-action nodes by emitting `agent:task:request` event with `skillName`, `actionName` from node config, collecting MCPs/agents from `suiteRegistry.collectMcpServers([node.skill])` and `suiteRegistry.collectAgentDefinitions([node.skill])`
  - [x] 4.8 Execute condition nodes using `evaluateCondition()` — result determines which downstream connections are active (connections with `condition: "true"` or `condition: "false"` matching the result)
  - [x] 4.9 Execute delay nodes by awaiting `setTimeout` for `node.duration` ms
  - [x] 4.10 Execute merge nodes as no-ops — they just wait for all upstream deps
  - [x] 4.11 Capture node outputs in `nodeOutputs` map for downstream template resolution
  - [x] 4.12 Emit `pipeline:step:complete` or `pipeline:step:failed` after each node
  - [x] 4.13 On pipeline completion: update `pipeline_runs` with status `completed`, `completed_at`, serialized `node_results`
  - [x] 4.14 On pipeline failure: update `pipeline_runs` with status `failed`, `error`, serialized `node_results`
  - [x] 4.15 Emit `pipeline:complete` or `pipeline:failed` at end
  - [x] 4.16 Interface: `PipelineExecutor { executePipeline }`

- [x] Task 5: Wire Executor into Pipeline Engine Facade (AC: #1, #7)
  - [x] 5.1 Extend `PipelineEngine` interface: add `executePipeline(name: string, triggerType: string): Promise<PipelineRunResult>`
  - [x] 5.2 Extend `PipelineEngineDeps` to include executor dependencies: `suiteRegistry`, `mcpManager`, `agentManager`, `permissionEngine?`, `auditLog?`, `pendingApprovals?`, `pipelineStore`, `db`
  - [x] 5.3 Create executor in `createPipelineEngine()`, delegate `executePipeline` to it
  - [x] 5.4 `executePipeline` validates pipeline exists and is enabled before delegating

- [x] Task 6: Manual Trigger API Route (AC: #7)
  - [x] 6.1 Add `POST /api/pipelines/:name/trigger` to `packages/core/src/api/routes/pipelines.ts`
  - [x] 6.2 Returns 404 if pipeline not found, 400 if pipeline disabled
  - [x] 6.3 Calls `pipelineEngine.executePipeline(name, 'manual')` — returns run ID and status
  - [x] 6.4 Non-blocking: returns `202 Accepted` with `{ runId }` immediately, execution continues in background
  - [x] 6.5 Add `GET /api/pipelines/:name/runs?limit=10` to return recent execution history from `pipelineStore`

- [x] Task 7: Boot Sequence Updates (AC: all)
  - [x] 7.1 Update `createPipelineEngine()` call in `packages/core/src/index.ts` to pass new deps (suiteRegistry, mcpManager, agentManager, permissionEngine, auditLog, pendingApprovals, db)
  - [x] 7.2 Create `pipelineStore` via `createPipelineStore({ db })` and pass to engine
  - [x] 7.3 Ensure pipeline engine initialized after all deps are available (after suiteRegistry, agentManager, permissionEngine)

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Unit tests for condition evaluator: simple truthiness, field access (`node.output.count > 0`), nested access, comparison operators, missing node output (returns false), malformed expression (returns false)
  - [x] 8.2 Unit tests for pipeline store: insertRun, updateRun, getRun, getRecentRuns (ordering, limit)
  - [x] 8.3 Unit tests for pipeline executor: sequential A→B→C execution order, parallel A+B→C execution, condition branching (true/false paths), delay node, merge node, skill-action node dispatching (verify `agent:task:request` emitted with correct payload), node output threading, pipeline failure handling (onError: stop skips downstream)
  - [x] 8.4 Integration tests for manual trigger API: `POST /api/pipelines/:name/trigger` (success 202, not found 404, disabled 400), `GET /api/pipelines/:name/runs` (returns history)
  - [x] 8.5 Update existing test mocks: add new deps to `PipelineEngineDeps` mocks in `api.test.ts`, `e2e.test.ts`

## Dev Notes

### Architecture Constraints

- **Pipeline execution uses the existing agent task queue** — skill-action nodes emit `agent:task:request` events, picked up by `AgentManager`, respecting concurrency semaphore (`RAVEN_MAX_CONCURRENT_AGENTS`, default 3)
- **Permission gate enforced per node** — each skill-action node passes through `enforcePermissionGate()` in `agent-session.ts` via the `actionName` field on the task request; `pipelineName` context already supported
- **No direct Claude SDK calls from executor** — always delegate through AgentManager's event-driven queue
- **`pipeline_runs` table already exists** — migration `003-pipeline-runs.sql` created it. Do NOT create a new migration
- **YAML files are source of truth** — executor reads `ValidatedPipeline` from loader, no DB storage for definitions
- **Suite-based architecture** — pipeline node `skill` field maps to suite names (e.g., `gmail` → `email` suite). Use `suiteRegistry.collectMcpServers([suiteName])` and `suiteRegistry.collectAgentDefinitions([suiteName])` to get the right MCPs/agents for each node

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|-----------|----------|-----------|
| `pipeline_runs` table | `migrations/003-pipeline-runs.sql` | Already exists — columns: id, pipeline_name, trigger_type, status, started_at, completed_at, node_results (JSON TEXT), error |
| `ValidatedPipeline` | `packages/core/src/pipeline-engine/pipeline-loader.ts` | Contains `config`, `executionOrder`, `entryPoints`, `filePath`, `loadedAt` |
| `PipelineConfig` + Zod schemas | `packages/shared/src/types/pipelines.ts` | All pipeline types: `PipelineNode`, `PipelineConnection`, `PipelineTrigger`, `PipelineSettings` |
| `validateDag()` | `packages/core/src/pipeline-engine/dag-validator.ts` | Returns `executionOrder` (topological sort) and `entryPoints` — used by executor |
| `PipelineLoader` | `packages/core/src/pipeline-engine/pipeline-loader.ts` | YAML loading, validation, in-memory registry, hot-reload watcher |
| `PipelineEngine` | `packages/core/src/pipeline-engine/pipeline-engine.ts` | Current facade — read-only (getPipeline, getAllPipelines). Extend with `executePipeline` |
| `AgentManager` | `packages/core/src/agent-manager/agent-manager.ts` | Listens for `agent:task:request` events, manages concurrency queue, calls `runAgentTask()` |
| `runAgentTask()` | `packages/core/src/agent-manager/agent-session.ts` | Sub-agent spawning with permission gate. Accepts `actionName`, `pipelineName` for attribution |
| `enforcePermissionGate()` | `packages/core/src/agent-manager/agent-session.ts` | Green/Yellow/Red tier enforcement. Already supports `pipelineName` context field |
| `SuiteRegistry` | `packages/core/src/suite-registry/suite-registry.ts` | `getSuite()`, `collectMcpServers([names])`, `collectAgentDefinitions([names])` |
| `McpManager` | `packages/core/src/mcp-manager/mcp-manager.ts` | `resolveForSuite(name)` — returns MCP configs for a suite |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | `emit()`, `on()`, `off()` — for pipeline events + agent task requests |
| `DatabaseInterface` | `@raven/shared` | `run()`, `get()`, `all()` — used by pipeline store |
| `createLogger()` | `@raven/shared` | Structured Pino logging |
| `generateId()` | `@raven/shared` | `crypto.randomUUID()` for run IDs |
| `ConfigPipelinesReloadedEvent` | `@raven/shared` types/events.ts | Existing pipeline-related event (config reload only) |

### How Skill-Action Node Execution Works

```
Pipeline Executor                    AgentManager                    agent-session.ts
       |                                  |                                |
       |-- emit agent:task:request ------>|                                |
       |   { taskId, skillName,           |                                |
       |     prompt, mcpServers,          |                                |
       |     agentDefinitions,            |                                |
       |     actionName, pipelineName }   |                                |
       |                                  |-- enqueue() ------------------>|
       |                                  |-- processQueue() ------------->|
       |                                  |                                |-- enforcePermissionGate()
       |                                  |                                |-- query() (Claude SDK)
       |                                  |                                |-- return result
       |<-- listen agent:task:complete ---|                                |
       |   { taskId, result }             |                                |
```

The executor needs to:
1. Emit `agent:task:request` with skill-action node details
2. Wait for the corresponding `agent:task:complete` or `agent:task:failed` event (match by taskId)
3. Extract the result from the completion event and store in `nodeOutputs`
4. Proceed to downstream nodes

### Condition Node Evaluation

Condition nodes use `{{ node-id.output.field }}` template expressions resolved against `nodeOutputs`:

```typescript
// Expression: "{{ fetch-emails.output.urgentCount > 0 }}"
// nodeOutputs: { 'fetch-emails': { urgentCount: 3, subjects: [...] } }
// Resolves to: 3 > 0 -> true

// Downstream connections:
// { from: 'check-urgency', to: 'urgent-path', condition: 'true' }   -> ACTIVE
// { from: 'check-urgency', to: 'normal-path', condition: 'false' }  -> SKIPPED
```

Connections WITHOUT a `condition` field are always active (unconditional edges).
Connections WITH `condition: "true"` or `condition: "false"` are conditional on the result.

### DAG Execution Algorithm

```
1. Start: insert pipeline_runs record (status: running)
2. Emit pipeline:started event
3. Initialize: nodeStatus = all 'pending', nodeOutputs = empty
4. Group nodes by topological level (nodes at same depth can run in parallel)
5. For each level (in order):
   a. Filter to nodes whose upstream deps are ALL complete
   b. Skip nodes whose upstream has failures (if onError: stop)
   c. Execute all ready nodes at this level in parallel (Promise.all)
   d. For each node:
      - If skill-action: emit agent:task:request, await completion event
      - If condition: evaluate expression, mark result
      - If delay: await setTimeout(duration)
      - If merge: no-op (just gate for upstream completion)
      - If code: (Future — not needed for MVP, skip with warning)
      - If switch: (Future — similar to condition but multi-branch)
   e. Update nodeStatus and nodeOutputs
   f. Emit pipeline:step:complete or pipeline:step:failed
6. On all nodes done: update pipeline_runs (status: completed), emit pipeline:complete
7. On failure: update pipeline_runs (status: failed), emit pipeline:failed
```

### Event Payload Designs

```typescript
// pipeline:started
{ type: 'pipeline:started', payload: { runId, pipelineName, triggerType, timestamp } }

// pipeline:step:complete
{ type: 'pipeline:step:complete', payload: { runId, pipelineName, nodeId, output, durationMs, timestamp } }

// pipeline:step:failed
{ type: 'pipeline:step:failed', payload: { runId, pipelineName, nodeId, error, durationMs, timestamp } }

// pipeline:complete
{ type: 'pipeline:complete', payload: { runId, pipelineName, status: 'completed', durationMs, timestamp } }

// pipeline:failed
{ type: 'pipeline:failed', payload: { runId, pipelineName, status: 'failed', error, durationMs, timestamp } }
```

### Key Code Patterns to Follow

**Factory Function Pattern (from pipeline-engine.ts):**
```typescript
export interface PipelineExecutor {
  executePipeline: (pipeline: ValidatedPipeline, triggerType: string) => Promise<PipelineRunResult>;
}

export interface PipelineExecutorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  mcpManager: McpManager;
  agentManager: AgentManager;
  permissionEngine?: PermissionEngine;
  auditLog?: AuditLog;
  pendingApprovals?: PendingApprovals;
  pipelineStore: PipelineStore;
  db: DatabaseInterface;
}

export function createPipelineExecutor(deps: PipelineExecutorDeps): PipelineExecutor {
  return {
    async executePipeline(pipeline, triggerType) { ... },
  };
}
```

**Awaiting Agent Task Completion:**
```typescript
// Create a promise that resolves when the specific task completes
function waitForTaskCompletion(eventBus: EventBus, taskId: string): Promise<{ result?: string; error?: string }> {
  return new Promise((resolve) => {
    const onComplete = (event: AgentTaskCompleteEvent) => {
      if (event.payload.taskId === taskId) {
        eventBus.off('agent:task:complete', onComplete);
        eventBus.off('agent:task:failed', onFailed);
        resolve({ result: event.payload.result });
      }
    };
    const onFailed = (event: AgentTaskFailedEvent) => {
      if (event.payload.taskId === taskId) {
        eventBus.off('agent:task:complete', onComplete);
        eventBus.off('agent:task:failed', onFailed);
        resolve({ error: event.payload.error });
      }
    };
    eventBus.on('agent:task:complete', onComplete);
    eventBus.on('agent:task:failed', onFailed);
  });
}
```

**Route Registration (extend existing pipelines.ts):**
```typescript
// Add to existing registerPipelineRoutes
app.post<{ Params: { name: string } }>('/api/pipelines/:name/trigger', async (req, reply) => {
  const pipeline = deps.pipelineEngine.getPipeline(req.params.name);
  if (!pipeline) return reply.status(404).send({ error: 'Pipeline not found' });
  if (!pipeline.config.enabled) return reply.status(400).send({ error: 'Pipeline is disabled' });

  const runId = await deps.pipelineEngine.executePipeline(req.params.name, 'manual');
  return reply.status(202).send({ runId, status: 'started' });
});

app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
  '/api/pipelines/:name/runs',
  async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 100);
    const runs = deps.pipelineStore.getRecentRuns(req.params.name, limit);
    return runs;
  },
);
```

### Pipeline Run Result Type

```typescript
interface PipelineRunResult {
  runId: string;
  pipelineName: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  nodeResults: Record<string, { status: string; output?: unknown; error?: string; durationMs: number }>;
  error?: string;
}
```

### `pipeline_runs` Table Schema (Already Exists)

```sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,       -- 'cron' | 'event' | 'manual' | 'webhook'
  status TEXT NOT NULL,             -- 'running' | 'completed' | 'failed' | 'cancelled'
  started_at TEXT NOT NULL,         -- ISO 8601
  completed_at TEXT,                -- ISO 8601
  node_results TEXT,                -- JSON blob: Record<nodeId, { status, output?, error?, durationMs }>
  error TEXT                        -- top-level error message if failed
);
```

### Suite Name Mapping

Pipeline YAML node `skill` field maps to suite names. The mapping may not always be 1:1 — check `suiteRegistry.getSuite(node.skill)` to verify the suite exists before execution. If a suite isn't found, the node fails with a clear error.

Current suites:
- `task-management` — TickTick MCP
- `email` — Gmail MCP + IMAP
- `digest` — Digest compilation (no MCP)
- `telegram` — Telegram bot (no MCP)

### File Structure

**New files:**
- `packages/core/src/pipeline-engine/pipeline-executor.ts` — DAG runner, node dispatch, parallel execution
- `packages/core/src/pipeline-engine/pipeline-store.ts` — DB read/write for `pipeline_runs` table
- `packages/core/src/pipeline-engine/condition-evaluator.ts` — safe expression evaluation

**Modified files:**
- `packages/shared/src/types/events.ts` — add pipeline execution event types
- `packages/shared/src/types/pipelines.ts` — add `PipelineRunRecord` type
- `packages/shared/src/types/index.ts` — re-export new types (if needed)
- `packages/core/src/pipeline-engine/pipeline-engine.ts` — extend interface with `executePipeline`, add executor deps
- `packages/core/src/api/routes/pipelines.ts` — add `POST /:name/trigger`, `GET /:name/runs`
- `packages/core/src/api/server.ts` — add `pipelineStore` to `ApiDeps` (if needed for runs route)
- `packages/core/src/index.ts` — pass new deps to `createPipelineEngine()`, create `pipelineStore`
- `packages/core/src/__tests__/pipeline-engine.test.ts` — add execution tests
- `packages/core/src/__tests__/api.test.ts` — update mock deps
- `packages/core/src/__tests__/e2e.test.ts` — update mock deps

### Previous Story Intelligence

**From Story 2-1 (Pipeline YAML Loader):**
- Factory function with DI pattern is standard — `createPipelineLoader({ eventBus })`
- `ValidatedPipeline` has `executionOrder` and `entryPoints` already computed — use directly
- `PipelineConfigSchema` Zod validation on load — executor gets pre-validated configs
- File watcher emits `config:pipelines:reloaded` — executor should handle mid-execution reload gracefully (don't interrupt running pipeline)
- 37 tests covering schema, DAG, loader, watcher, engine, API — don't break them
- `yaml` package already in `@raven/core` dependencies
- Zod 4 uses `z.record(keyType, valueType)` not `z.record(valueType)`
- `LoggerInterface` uses `(msg: string, ...args)` not Pino object style `(obj, msg)`

**From Story 1-5 (Permission Gate):**
- `enforcePermissionGate()` already supports `pipelineName` in context — pass it when executing pipeline nodes
- Permission gate returns `{ allowed: boolean, tier, reason? }` — if not allowed and Red tier, node should be marked as `blocked` not `failed`

**From suite-based architecture (recent refactoring):**
- Suite names are entity identifiers — `suiteRegistry.getSuite('gmail')` may return undefined if suite name doesn't match
- Use `suiteRegistry.collectMcpServers([suiteName])` for MCP configs
- Use `suiteRegistry.collectAgentDefinitions([suiteName])` for sub-agent definitions
- MCP server keys are namespaced: `suiteName_mcpKey` (e.g., `email_gmail`)

### Git Intelligence

**Recent commits:**
```
b78c04e feat: story 2-1 — pipeline YAML loader, validation, and hot-reload
5ffa00e feat: extract MCP/suite constants, fail loudly on missing env vars, isolate spawned agents
ab4f4f6 feat: add raw debug output, session fixes, stop-processes, and test fixes
78e5cca feat: wire suite-based architecture into core (Phases 2-4)
1034bfc feat: add suite-based architecture (Phase 1)
```

**Patterns:**
- `feat: story X-Y — description` for story implementations
- kebab-case file naming strictly enforced
- Tests co-located in `packages/core/src/__tests__/`
- DI via factory functions with typed deps interfaces
- All new deps added to existing test mocks (`api.test.ts`, `e2e.test.ts`)

### Testing Strategy

- **Unit tests** for condition evaluator: truthiness, field access, comparisons, missing data (returns false), malformed expressions
- **Unit tests** for pipeline store: CRUD operations on `pipeline_runs` table with temp SQLite DB
- **Unit tests** for pipeline executor: mock `EventBus`, `SuiteRegistry`, `AgentManager`, `PipelineStore`
  - Sequential execution order verified
  - Parallel execution (A+B then C) — both start before C
  - Condition branching — true/false path routing
  - Delay nodes — await duration
  - Merge nodes — wait for all upstream
  - Node output threading — downstream receives upstream outputs
  - Pipeline failure — onError: stop skips downstream nodes
  - Event emissions verified (pipeline:started, pipeline:step:complete, pipeline:complete)
  - DB record creation/update verified
- **Integration tests** for API: `POST /api/pipelines/:name/trigger` (202, 404, 400), `GET /api/pipelines/:name/runs`
- **Mock EventBus** for executor tests — capture emitted events
- **Mock AgentManager** — verify `agent:task:request` events emitted with correct payloads
- **Temp SQLite DB** for store tests (use `mkdtempSync()` pattern)

### Project Structure Notes

- New files follow existing `pipeline-engine/` directory pattern
- `pipeline-executor.ts` is the core new module — may be close to 300 lines; split if needed (e.g., `node-runner.ts` for individual node execution logic)
- No new database migrations needed — `pipeline_runs` table already exists
- Types in `@raven/shared` — follow centralization pattern
- Pipeline store follows same pattern as `audit-log.ts` (factory function, DB interface)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2-Story-2.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline-YAML-Schema]
- [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Implementation-Patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md#Integration-Points]
- [Source: _bmad-output/planning-artifacts/prd.md#FR11-FR16] — Pipeline automation requirements
- [Source: _bmad-output/planning-artifacts/prd.md#NFR18] — Pipeline step execution must not block event loop
- [Source: packages/core/src/pipeline-engine/pipeline-engine.ts] — current facade (extend)
- [Source: packages/core/src/pipeline-engine/pipeline-loader.ts] — ValidatedPipeline type
- [Source: packages/core/src/pipeline-engine/dag-validator.ts] — execution order computation
- [Source: packages/core/src/agent-manager/agent-manager.ts] — task queue and concurrency
- [Source: packages/core/src/agent-manager/agent-session.ts] — permission gate, sub-agent spawning
- [Source: packages/core/src/suite-registry/suite-registry.ts] — MCP/agent collection
- [Source: packages/core/src/mcp-manager/mcp-manager.ts] — MCP resolution per suite
- [Source: packages/core/src/event-bus/event-bus.ts] — event emission/subscription
- [Source: packages/core/src/db/database.ts] — DatabaseInterface
- [Source: migrations/003-pipeline-runs.sql] — existing pipeline_runs table
- [Source: _bmad-output/implementation-artifacts/2-1-pipeline-yaml-loader-and-validation.md] — previous story patterns and learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Fixed `waitForTaskCompletion` to check `success` field on `agent:task:complete` events (was resolving all completions as success)
- Refactored 4-param functions (`executeNode`, `executeConditionNode`, `executeSkillActionNode`) to use `NodeContext` object to satisfy `max-params` lint rule
- Removed unused `getActiveConnections` helper (condition routing handled inline in readyNodes filter)

### Completion Notes List

- **Task 1**: Added 5 pipeline execution event types (`PipelineStartedEvent`, `PipelineStepCompleteEvent`, `PipelineStepFailedEvent`, `PipelineCompleteEvent`, `PipelineFailedEvent`) to shared types + `PipelineRunRecord` interface
- **Task 2**: Created `pipeline-store.ts` with factory function pattern for `pipeline_runs` table CRUD (insert, update, get, getRecentRuns)
- **Task 3**: Created `condition-evaluator.ts` with safe regex-based expression parser supporting `{{ node.output.field }}` resolution, comparisons (`>`,`<`,`>=`,`<=`,`==`,`!=`), truthiness, string/numeric/boolean literals. No dynamic code execution.
- **Task 4**: Created `pipeline-executor.ts` — DAG runner that groups nodes by topological level, executes in parallel with `Promise.all`, supports skill-action (via `agent:task:request` events), condition (with true/false branch routing), delay, and merge nodes. Records execution history to DB, emits typed events.
- **Task 5**: Extended `PipelineEngine` facade with `executePipeline(name, triggerType)`, optional executor deps, pipeline existence/enabled validation
- **Task 6**: Added `POST /api/pipelines/:name/trigger` (202 non-blocking), `GET /api/pipelines/:name/runs` with limit support
- **Task 7**: Updated boot sequence in `index.ts` to create `pipelineStore` and pass full deps to engine
- **Task 8**: 34 new tests across 3 test files: 14 condition-evaluator, 8 pipeline-store, 12 pipeline-executor + 4 API integration tests. All existing 236 tests pass (0 regressions).

### File List

**New files:**
- `packages/core/src/pipeline-engine/pipeline-executor.ts`
- `packages/core/src/pipeline-engine/pipeline-store.ts`
- `packages/core/src/pipeline-engine/condition-evaluator.ts`
- `packages/core/src/__tests__/pipeline-executor.test.ts`
- `packages/core/src/__tests__/pipeline-store.test.ts`
- `packages/core/src/__tests__/condition-evaluator.test.ts`

**Modified files:**
- `packages/shared/src/types/events.ts` — added 5 pipeline execution event types + union members
- `packages/shared/src/types/pipelines.ts` — added `PipelineRunRecord` interface
- `packages/core/src/pipeline-engine/pipeline-engine.ts` — extended interface with `executePipeline`, added executor deps
- `packages/core/src/api/routes/pipelines.ts` — added trigger + runs routes
- `packages/core/src/api/server.ts` — added `pipelineStore` to `ApiDeps`
- `packages/core/src/index.ts` — create pipelineStore, pass new deps to engine
- `packages/core/src/__tests__/pipeline-engine.test.ts` — added 4 API integration tests
- `packages/core/src/__tests__/api.test.ts` — updated mock with `executePipeline`
- `packages/core/src/__tests__/e2e.test.ts` — updated mock with `executePipeline`
