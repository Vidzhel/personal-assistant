# Story 2.1: Pipeline YAML Loader & Validation

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want to define automation pipelines as YAML files that are validated on load,
so that pipeline configurations are reliable and errors are caught before execution.

## Acceptance Criteria

1. **Valid Pipeline Loaded** — Given a valid pipeline YAML file in `config/pipelines/`, When the pipeline loader starts, Then it parses and validates the file against the Zod schema, making it available for execution via the pipeline engine's in-memory registry.

2. **Cycle Detection** — Given a pipeline YAML with a cycle in its `connections` graph, When DAG validation runs, Then the pipeline is rejected with a clear error message identifying the cycle, logged via Pino, and other valid pipelines continue loading.

3. **Invalid YAML Rejected** — Given an invalid YAML file (missing required fields, bad types, unknown node references in connections), When Zod validation fails, Then the file is rejected, the error is logged with the filename and validation details, and other valid pipelines continue loading normally.

4. **Hot-Reload on File Change** — Given a new YAML file is added to `config/pipelines/` (or an existing one is modified/deleted), When the file watcher detects it, Then the pipeline is loaded and validated (or removed from the in-memory registry) without restart.

5. **Pipeline Listing API** — Given pipelines have been loaded, When `GET /api/pipelines` is called, Then all loaded pipeline definitions are returned with their validation status.

6. **Single Pipeline API** — Given a specific pipeline exists, When `GET /api/pipelines/:name` is called, Then the full pipeline definition is returned. Returns 404 if not found.

7. **Pipeline Type Definitions** — Given the pipeline engine needs shared types, When `packages/shared/src/types/pipelines.ts` is created, Then it exports Zod schemas and TypeScript types for `PipelineConfig`, `PipelineNode`, `PipelineConnection`, `PipelineTrigger`, and `PipelineSettings`.

## Tasks / Subtasks

- [x] Task 1: Pipeline Type Definitions in @raven/shared (AC: #7)
  - [x] 1.1 Create `packages/shared/src/types/pipelines.ts` with Zod schemas: `PipelineTriggerSchema`, `PipelineSettingsSchema`, `PipelineNodeSchema`, `PipelineConnectionSchema`, `PipelineConfigSchema`
  - [x] 1.2 Export TypeScript types inferred from Zod schemas: `PipelineConfig`, `PipelineNode`, `PipelineConnection`, `PipelineTrigger`, `PipelineSettings`
  - [x] 1.3 Add `export * from './pipelines.ts'` to `packages/shared/src/types/index.ts`
  - [x] 1.4 Add pipeline event types to `packages/shared/src/types/events.ts`: `config:pipelines:reloaded` event
  - [x] 1.5 Build shared package to verify type exports

- [x] Task 2: DAG Validation Utility (AC: #2)
  - [x] 2.1 Create `packages/core/src/pipeline-engine/dag-validator.ts` — pure function `validateDag(nodes: Record<string, PipelineNode>, connections: PipelineConnection[]): DagValidationResult`
  - [x] 2.2 Implement topological sort using Kahn's algorithm (BFS-based, deterministic)
  - [x] 2.3 Return execution order on success, or cycle description on failure
  - [x] 2.4 Validate all connection `from`/`to` references exist in nodes map
  - [x] 2.5 Validate entry points exist (nodes with no inbound connections)
  - [x] 2.6 Return `{ valid: true, executionOrder: string[] }` or `{ valid: false, error: string }`

- [x] Task 3: Pipeline Loader Module (AC: #1, #3)
  - [x] 3.1 Create `packages/core/src/pipeline-engine/pipeline-loader.ts` — factory function `createPipelineLoader(deps: { eventBus: EventBus })` returning `PipelineLoader` interface
  - [x] 3.2 `loadFromDirectory(dir: string): void` — reads all `*.yaml`/`*.yml` files from directory, parses with `yaml` package, validates each with `PipelineConfigSchema.safeParse()`
  - [x] 3.3 On validation failure: log error with filename and Zod error details, skip file, continue loading remaining files
  - [x] 3.4 On DAG validation failure: log error with cycle details, skip file
  - [x] 3.5 Store valid pipelines in internal `Map<string, ValidatedPipeline>` keyed by pipeline name
  - [x] 3.6 `getPipeline(name: string): ValidatedPipeline | undefined`
  - [x] 3.7 `getAllPipelines(): ValidatedPipeline[]`
  - [x] 3.8 `removePipeline(name: string): boolean`
  - [x] 3.9 `reloadPipeline(filePath: string): void` — parse, validate, update or add to map

- [x] Task 4: File Watcher for Hot-Reload (AC: #4)
  - [x] 4.1 Add `watch(dir: string): void` method to PipelineLoader — uses `node:fs` `watch()` with 200ms debounce (same pattern as permission-engine.ts)
  - [x] 4.2 On file add/change: call `reloadPipeline(filePath)`
  - [x] 4.3 On file delete: call `removePipeline(name)` where name is derived from filename
  - [x] 4.4 Emit `config:pipelines:reloaded` event after successful reload
  - [x] 4.5 Add `shutdown(): void` to close watcher
  - [x] 4.6 Ignore non-YAML files and temporary editor files (`.swp`, `~`, `.tmp`)

- [x] Task 5: Pipeline Engine Facade (AC: #1, #4)
  - [x] 5.1 Create `packages/core/src/pipeline-engine/pipeline-engine.ts` — factory function `createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine`
  - [x] 5.2 Interface: `{ initialize(configDir: string): void, getPipeline(name: string), getAllPipelines(), shutdown(): void }`
  - [x] 5.3 `initialize()` calls loader's `loadFromDirectory()` then `watch()`
  - [x] 5.4 Delegates get/list to loader
  - [x] 5.5 `shutdown()` calls loader's `shutdown()`

- [x] Task 6: API Routes (AC: #5, #6)
  - [x] 6.1 Create `packages/core/src/api/routes/pipelines.ts`
  - [x] 6.2 `GET /api/pipelines` — returns all loaded pipeline definitions as array
  - [x] 6.3 `GET /api/pipelines/:name` — returns single pipeline definition, 404 if not found
  - [x] 6.4 Add `pipelineEngine` to `ApiDeps` interface in `server.ts`
  - [x] 6.5 Register pipeline routes in `server.ts`

- [x] Task 7: Boot Sequence Integration (AC: #1)
  - [x] 7.1 Create `config/pipelines/` directory (empty, with `.gitkeep`)
  - [x] 7.2 Wire `createPipelineEngine()` in `packages/core/src/index.ts` boot sequence — after scheduler, before API server
  - [x] 7.3 Call `pipelineEngine.initialize(pipelinesDir)` during boot
  - [x] 7.4 Pass `pipelineEngine` to `createApiServer()` deps
  - [x] 7.5 Call `pipelineEngine.shutdown()` in graceful shutdown handler

- [x] Task 8: Example Pipeline YAML (AC: #1)
  - [x] 8.1 Create `config/pipelines/morning-briefing.yaml` — example pipeline following the architecture schema with `trigger.type: cron`, multiple nodes, connections
  - [x] 8.2 Verify it loads and validates successfully on boot

- [x] Task 9: Tests (AC: all)
  - [x] 9.1 Unit tests for Zod schema validation: valid configs, missing fields, bad types, extra fields
  - [x] 9.2 Unit tests for DAG validator: linear chain, parallel branches, diamond merge, cycle detection, missing node references, no entry points
  - [x] 9.3 Unit tests for pipeline loader: load from directory (valid/invalid/mixed), get/list/remove, reload
  - [x] 9.4 Integration test for file watcher: add file → detected, modify → reloaded, delete → removed
  - [x] 9.5 Integration tests for API routes: GET /api/pipelines (list), GET /api/pipelines/:name (found + 404)
  - [x] 9.6 Integration test for boot sequence: pipeline engine initializes, example pipeline loaded

## Dev Notes

### Architecture Constraints

- **Pipeline YAML is source of truth** — YAML files on disk in `config/pipelines/`, git-tracked, human-editable
- **Validated with Zod at load time** — invalid configs rejected with clear error message
- **DAG validation** — cycles rejected, all node references in connections must exist
- **Graph-based schema** — nodes are a map keyed by unique kebab-case ID, connections are explicit directed edges
- **Parallel execution is implicit** — nodes with no dependency execute concurrently (execution order computed by topological sort)
- **No DB storage for pipeline definitions** — definitions live as YAML files only. DB stores execution history (Story 2.3+)
- **`pipeline_runs` table already exists** — from `migrations/003-pipeline-runs.sql`. Do NOT create a new migration for pipeline definitions.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|-----------|----------|-----------|
| `pipeline_runs` table | Migration 003 | Already exists — used in Story 2.2+ for execution history |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | `emit()`, `on()`, `off()` — for `config:pipelines:reloaded` event |
| `SuiteRegistry` | `packages/core/src/suite-registry/suite-registry.ts` | Collects agents/MCPs that pipeline nodes will delegate to (Story 2.2) |
| Permission Engine | `packages/core/src/permission-engine/permission-engine.ts` | **Pattern to follow** for factory function, file watcher with debounce, Zod validation |
| `createLogger()` | `@raven/shared` | Structured Pino logging |
| `generateId()` | `@raven/shared` | For any IDs needed |
| `DatabaseInterface` | `packages/core/src/db/database.ts` | Not needed for this story (no DB operations) |
| Config loader | `packages/core/src/config.ts` | Pattern for loading JSON/YAML config |
| `ApiDeps` | `packages/core/src/api/server.ts` | Add `pipelineEngine` to interface |
| Boot sequence | `packages/core/src/index.ts` | Wire pipeline engine after scheduler, before API |

### Pipeline YAML Schema (from Architecture Doc)

```yaml
name: morning-briefing
description: Compile and send daily morning briefing
version: 1                          # schema version for future migrations

trigger:
  type: cron                        # cron | event | manual | webhook
  schedule: "0 6 * * *"
  # event: "email:new"
  # filter: { sender: "@important.com" }

settings:
  retry:
    maxAttempts: 3
    backoffMs: 5000
  timeout: 600000
  onError: stop                     # stop | continue | goto:<node-id>

nodes:
  fetch-emails:                     # unique node ID (kebab-case)
    skill: gmail
    action: get-unread-summary
    params: {}

  fetch-tasks:
    skill: ticktick
    action: get-overdue-tasks
    params: {}

  check-urgency:
    type: condition                 # condition | switch | merge | delay | code
    expression: "{{ fetch-emails.output.urgentCount > 0 }}"

  compile-briefing:
    skill: digest
    action: compile-briefing
    params:
      include: [email-summary, overdue-tasks]

  send-message:
    skill: telegram
    action: send-message
    params:
      topic: general

connections:
  - from: fetch-emails
    to: check-urgency
  - from: check-urgency
    to: compile-briefing
    condition: "false"
  - from: compile-briefing
    to: send-message

enabled: true
```

### Zod Schema Design

```typescript
import { z } from 'zod';

// Trigger types
const PipelineTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    schedule: z.string(),
  }),
  z.object({
    type: z.literal('event'),
    event: z.string(),
    filter: z.record(z.unknown()).optional(),
  }),
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('webhook'),
    path: z.string().optional(),
  }),
]);

// Retry settings
const PipelineRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(100).max(60000).default(5000),
});

// Pipeline settings
const PipelineSettingsSchema = z.object({
  retry: PipelineRetrySchema.optional(),
  timeout: z.number().int().min(1000).max(3600000).default(600000),
  onError: z.string().regex(/^(stop|continue|goto:.+)$/).default('stop'),
});

// Node types
const PipelineNodeSchema = z.object({
  skill: z.string().optional(),         // required for skill-action nodes
  action: z.string().optional(),        // required for skill-action nodes
  params: z.record(z.unknown()).optional(),
  type: z.enum(['condition', 'switch', 'merge', 'delay', 'code']).optional(),
  expression: z.string().optional(),    // for condition/switch nodes
  duration: z.number().optional(),      // for delay nodes
});

// Connection
const PipelineConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
  errorPath: z.boolean().optional(),
  label: z.string().optional(),
});

// Full pipeline config
const PipelineConfigSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  version: z.number().int().min(1).default(1),
  trigger: PipelineTriggerSchema,
  settings: PipelineSettingsSchema.optional(),
  nodes: z.record(z.string(), PipelineNodeSchema).refine(
    (nodes) => Object.keys(nodes).length > 0,
    { message: 'Pipeline must have at least one node' }
  ),
  connections: z.array(PipelineConnectionSchema).default([]),
  enabled: z.boolean().default(true),
});
```

### DAG Validation Algorithm

Use **Kahn's algorithm** (BFS-based topological sort):
1. Build adjacency list and in-degree map from `connections`
2. Validate all `from`/`to` references exist in `nodes`
3. Find all nodes with in-degree 0 (entry points)
4. If no entry points → error: "No entry point nodes found"
5. BFS: process queue, decrementing in-degrees, adding to sorted order
6. If sorted order length < total nodes → cycle detected
7. Return execution order or error

```typescript
interface DagValidationResult {
  valid: boolean;
  executionOrder?: string[];  // topological order
  entryPoints?: string[];     // nodes with no inbound connections
  error?: string;
}
```

### Key Code Patterns to Follow

**Factory Function Pattern (from permission-engine.ts):**
```typescript
export interface PipelineEngine {
  initialize: (configDir: string) => void;
  getPipeline: (name: string) => ValidatedPipeline | undefined;
  getAllPipelines: () => ValidatedPipeline[];
  shutdown: () => void;
}

interface PipelineEngineDeps {
  eventBus: EventBus;
}

export function createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine {
  // closure-based private state
  let loader: PipelineLoader | null = null;

  return {
    initialize(configDir) { ... },
    getPipeline(name) { ... },
    getAllPipelines() { ... },
    shutdown() { ... },
  };
}
```

**File Watcher Pattern (from permission-engine.ts):**
```typescript
import { watch, type FSWatcher } from 'node:fs';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcher: FSWatcher | null = null;

watcher = watch(dir, (_eventType, filename) => {
  if (!filename || !filename.match(/\.ya?ml$/)) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => handleFileChange(filename), 200);
});
```

**Route Registration (from audit-logs.ts):**
```typescript
export function registerPipelineRoutes(
  app: FastifyInstance,
  deps: { pipelineEngine: PipelineEngine }
): void {
  app.get('/api/pipelines', async () => {
    return deps.pipelineEngine.getAllPipelines();
  });

  app.get<{ Params: { name: string } }>('/api/pipelines/:name', async (req, reply) => {
    const pipeline = deps.pipelineEngine.getPipeline(req.params.name);
    if (!pipeline) return reply.status(404).send({ error: 'Pipeline not found' });
    return pipeline;
  });
}
```

**YAML Parsing:**
```bash
# yaml package already available or add to @raven/core
npm install yaml
```
```typescript
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

const content = readFileSync(filePath, 'utf-8');
const raw = parseYaml(content);
const result = PipelineConfigSchema.safeParse(raw);
```

### ValidatedPipeline Type

```typescript
interface ValidatedPipeline {
  config: PipelineConfig;       // Zod-validated config
  executionOrder: string[];     // topological sort result
  entryPoints: string[];        // nodes with no inbound connections
  filePath: string;             // source file path for reload/watch
  loadedAt: string;             // ISO 8601 timestamp
}
```

### File Structure

**New files:**
- `packages/shared/src/types/pipelines.ts` — Zod schemas + inferred types
- `packages/core/src/pipeline-engine/pipeline-engine.ts` — facade factory function
- `packages/core/src/pipeline-engine/pipeline-loader.ts` — YAML loading, validation, in-memory registry
- `packages/core/src/pipeline-engine/dag-validator.ts` — cycle detection, topological sort
- `packages/core/src/api/routes/pipelines.ts` — REST endpoints
- `config/pipelines/.gitkeep` — empty pipelines directory
- `config/pipelines/morning-briefing.yaml` — example pipeline
- `packages/core/src/__tests__/pipeline-engine.test.ts` — tests

**Modified files:**
- `packages/shared/src/types/index.ts` — add pipeline type exports
- `packages/shared/src/types/events.ts` — add `config:pipelines:reloaded` event type
- `packages/core/src/api/server.ts` — add `pipelineEngine` to `ApiDeps`, register routes
- `packages/core/src/index.ts` — wire pipeline engine in boot sequence + shutdown

**Dependencies to add:**
- `yaml` package to `packages/core/package.json` (for YAML parsing)

### Previous Story Intelligence

**From Story 1-7 (last in Epic 1):**
- Factory function with DI pattern is standard — `createExecutionLogger({ db })`
- Route registration: `registerAgentTaskRoutes(app, deps)` — follow same pattern
- Boot sequence wiring: create instance → pass to agent manager/API → shutdown in reverse
- `ApiDeps` grows with each story — add `pipelineEngine` alongside existing deps
- 198+ tests passing — don't break existing tests when modifying `ApiDeps` (add to test mocks)

**From suite-based architecture refactoring (most recent):**
- `SuiteRegistry` replaced `SkillRegistry` — pipelines reference suites, not skills
- Suite names are the entity identifiers (e.g., `task-management`, `email`)
- Agent definitions collected via `suiteRegistry.collectAgentDefinitions()`
- MCP servers collected via `suiteRegistry.collectMcpServers()`
- The pipeline `skill` field in node definitions maps to suite names

**Code review patterns learned:**
- DI pattern: use object-based deps, not positional params
- `vi.mock()` must be at top level (hoisted), not inside `it()` blocks
- Always add new deps to test mocks when `ApiDeps` interface changes
- Update `api.test.ts` and `e2e.test.ts` mock deps

### Git Intelligence

**Recent commits (last 5):**
```
5ffa00e feat: extract MCP/suite constants, fail loudly on missing env vars, isolate spawned agents
ab4f4f6 feat: add raw debug output, session fixes, stop-processes, and test fixes
78e5cca feat: wire suite-based architecture into core (Phases 2-4)
1034bfc feat: add suite-based architecture (Phase 1)
169e97d chore: update docs
```

**Patterns:**
- `feat: story X-Y — description` for features
- kebab-case file naming strictly enforced
- Tests in `packages/core/src/__tests__/`
- Suite-based architecture is the current paradigm — pipeline nodes reference suites

### Testing Strategy

- **Unit tests** for Zod schema: valid pipeline, missing name, invalid trigger type, bad node, empty nodes
- **Unit tests** for DAG validator: linear A→B→C, parallel A+B→C, diamond A→B+C→D, cycle A→B→A, missing node ref, no entry points, disconnected nodes
- **Unit tests** for pipeline loader: load directory with mix of valid/invalid files, get/list/remove, reload on change
- **Integration test** for file watcher: write file → verify detected + loaded (use `setTimeout` for debounce)
- **Integration tests** for API: `GET /api/pipelines` list, `GET /api/pipelines/:name` found/404
- **Real filesystem** for loader tests (use `mkdtempSync()` pattern from existing tests)
- **Mock EventBus** for loader tests to verify `config:pipelines:reloaded` emission

### Project Structure Notes

- Pipeline engine lives at `packages/core/src/pipeline-engine/` — new directory matching existing subsystem pattern (`permission-engine/`, `agent-manager/`, etc.)
- Pipeline YAML files in `config/pipelines/` — matches `config/` convention for git-tracked configs
- No database changes needed for this story — `pipeline_runs` table (migration 003) already exists for future stories
- Types in `packages/shared/src/types/pipelines.ts` — follows shared type centralization pattern

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2-Story-2.1]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline-YAML-Schema]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline-schema-conventions]
- [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Implementation-Patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md#Project-Structure-Boundaries]
- [Source: packages/core/src/permission-engine/permission-engine.ts] — file watcher + factory function pattern
- [Source: packages/core/src/api/routes/audit-logs.ts] — route registration pattern
- [Source: packages/core/src/index.ts] — boot sequence integration point
- [Source: packages/core/src/api/server.ts] — ApiDeps interface
- [Source: _bmad-output/implementation-artifacts/1-7-agent-execution-logging-and-system-health-monitoring.md] — previous story patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Zod 4 breaking changes: `z.record()` requires two args (keyType, valueType) instead of one
- `LoggerInterface` uses `(msg: string, ...args)` not Pino object style `(obj, msg)`

### Completion Notes List

- Task 1: Created pipeline Zod schemas + TypeScript types in `@raven/shared`, added `config:pipelines:reloaded` event type
- Task 2: Implemented Kahn's algorithm DAG validator with cycle detection, entry point identification, and topological sort
- Task 3: Built pipeline loader with YAML parsing, Zod validation, DAG validation, in-memory registry (Map)
- Task 4: Added file watcher with 200ms debounce, handles add/modify/delete, ignores `.swp`/`~`/`.tmp` files
- Task 5: Created pipeline engine facade delegating to loader
- Task 6: Added `GET /api/pipelines` and `GET /api/pipelines/:name` (404 on not found) routes
- Task 7: Wired pipeline engine into boot sequence (after scheduler, before API), added to graceful shutdown, created `config/pipelines/` directory
- Task 8: Created `morning-briefing.yaml` example pipeline with cron trigger, 4 nodes, diamond-merge topology
- Task 9: 37 tests covering: schema validation (8), DAG validator (8), pipeline loader (8), file watcher (3), pipeline engine (3), API routes (3), plus updated existing test mocks for `pipelineEngine` in ApiDeps

### File List

**New files:**
- `packages/shared/src/types/pipelines.ts`
- `packages/core/src/pipeline-engine/dag-validator.ts`
- `packages/core/src/pipeline-engine/pipeline-loader.ts`
- `packages/core/src/pipeline-engine/pipeline-engine.ts`
- `packages/core/src/api/routes/pipelines.ts`
- `packages/core/src/__tests__/pipeline-engine.test.ts`
- `config/pipelines/.gitkeep`
- `config/pipelines/morning-briefing.yaml`

**Modified files:**
- `packages/shared/src/types/index.ts` — added pipeline type exports
- `packages/shared/src/types/events.ts` — added `ConfigPipelinesReloadedEvent` type
- `packages/core/src/api/server.ts` — added `pipelineEngine` to `ApiDeps`, registered pipeline routes
- `packages/core/src/index.ts` — wired pipeline engine in boot sequence + shutdown
- `packages/core/src/__tests__/api.test.ts` — added `pipelineEngine` mock to test deps
- `packages/core/src/__tests__/e2e.test.ts` — added `pipelineEngine` mock to test deps
- `packages/core/package.json` — added `yaml` dependency
- `package-lock.json` — updated from `yaml` dependency addition
