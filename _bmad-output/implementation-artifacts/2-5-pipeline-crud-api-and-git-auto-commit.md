# Story 2.5: Pipeline CRUD API & Git Auto-Commit

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want to manage pipelines through an API with automatic git versioning,
so that pipeline changes are accessible programmatically and reversible through git history.

## Acceptance Criteria

1. **PUT Creates/Updates Pipeline YAML** — Given a valid pipeline YAML body is PUT to `/api/pipelines/:name`, When the file is written, Then the YAML is saved to `config/pipelines/<name>.yaml`, validated with `PipelineConfigSchema`, and auto-committed to git.

2. **PUT Validates Before Writing** — Given an invalid pipeline YAML body is PUT to `/api/pipelines/:name`, When validation fails, Then a 400 error is returned with the Zod validation error and no file is written.

3. **PUT Name Mismatch Rejected** — Given the YAML body `name` field does not match the `:name` URL param, When the request is processed, Then a 400 error is returned (`Pipeline name in body must match URL parameter`).

4. **DELETE Removes Pipeline** — Given a `DELETE /api/pipelines/:name` request for an existing pipeline, When processed, Then the YAML file is deleted from disk, the pipeline is removed from the in-memory registry, and the deletion is auto-committed to git.

5. **DELETE Returns 404 for Missing** — Given a `DELETE /api/pipelines/:name` request for a non-existent pipeline, When processed, Then a 404 error is returned.

6. **Git Auto-Commit Non-Blocking** — Given any pipeline CRUD write operation, When git auto-commit is attempted, Then the commit runs asynchronously (fire-and-forget) — git failure is logged but never blocks the API response.

7. **Git Auto-Commit Failure Tolerant** — Given the git auto-commit fails (git not available, conflict, not a repo), When the pipeline YAML was already written/deleted on disk, Then the config change applies successfully — git failure is logged as a warning but does not cause an error response.

8. **Existing Routes Preserved** — Given the existing routes `GET /api/pipelines`, `GET /api/pipelines/:name`, `POST /api/pipelines/:name/trigger`, and `GET /api/pipelines/:name/runs`, When this story is complete, Then all existing routes continue to work exactly as before with no regressions.

## Tasks / Subtasks

- [x] Task 1: Create git auto-commit utility (AC: #6, #7)
  - [x] 1.1 Create `packages/shared/src/utils/git-commit.ts` with `gitAutoCommit(filePaths: string[], message: string): Promise<void>` function
  - [x] 1.2 Use `execFile` from `node:child_process` (promisified) — NOT `exec` (no shell injection risk)
  - [x] 1.3 Run `git add <files>` then `git commit -m <message>` — two sequential `execFile` calls
  - [x] 1.4 Catch ALL errors (git not installed, not a repo, nothing to commit, conflicts) — log warning via Pino, never throw
  - [x] 1.5 Export from `packages/shared/src/index.ts`

- [x] Task 2: Extend PipelineEngine with CRUD methods (AC: #1, #4)
  - [x] 2.1 Add to `PipelineEngine` interface: `savePipeline(name: string, yamlContent: string): { config: PipelineConfig }` and `deletePipeline(name: string): boolean`
  - [x] 2.2 `savePipeline`: parse YAML string → validate with `PipelineConfigSchema.safeParse()` → validate DAG → write file to `configDir/<name>.yaml` → trigger reload → fire-and-forget `gitAutoCommit` → return parsed config. Throw on validation failure with descriptive error.
  - [x] 2.3 `deletePipeline`: check file exists → `unlinkSync` file → remove from loader → fire-and-forget `gitAutoCommit` → return true. Return false if file doesn't exist.
  - [x] 2.4 Store `configDir` from `initialize()` call so CRUD methods know where to read/write files

- [x] Task 3: Add PUT and DELETE routes (AC: #1, #2, #3, #4, #5)
  - [x] 3.1 Add `PUT /api/pipelines/:name` route in `pipelines.ts`: parse raw body as YAML string, validate name match, call `pipelineEngine.savePipeline()`, return 200 with saved config
  - [x] 3.2 Add `DELETE /api/pipelines/:name` route: call `pipelineEngine.deletePipeline()`, return 204 on success, 404 if not found
  - [x] 3.3 PUT request body is raw YAML text (content-type `text/yaml` or `application/x-yaml`) — use Fastify `addContentTypeParser` or accept as string body
  - [x] 3.4 PUT returns the validated `PipelineConfig` object (JSON) on success

- [x] Task 4: Tests (AC: all)
  - [x] 4.1 Unit tests for `gitAutoCommit` in `packages/shared/src/__tests__/git-commit.test.ts`:
    - Successfully runs git add + commit
    - Handles git not available (ENOENT) — logs warning, doesn't throw
    - Handles "nothing to commit" exit code — logs, doesn't throw
    - Handles other git errors — logs warning, doesn't throw
  - [x] 4.2 Integration tests for pipeline CRUD in `packages/core/src/__tests__/pipeline-engine.test.ts` (extend existing):
    - PUT valid YAML creates file on disk and returns config
    - PUT invalid YAML returns 400 with validation error
    - PUT with name mismatch returns 400
    - PUT updates existing pipeline (overwrites file)
    - DELETE existing pipeline removes file and returns 204
    - DELETE non-existent pipeline returns 404
    - Existing GET/POST routes still work after changes
  - [x] 4.3 Mock `execFile` in git tests — never run real git commands in tests
  - [x] 4.4 Use temp directories for pipeline YAML files in CRUD tests

## Dev Notes

### Architecture Constraints

- **Git auto-commit is fire-and-forget** — use `execFile` (no shell), catch all errors, log warnings, never throw. Per architecture: "Async utility using `execFile` (not `exec`) for `git add` + `git commit`. Fire-and-forget, failure logged but doesn't block config changes (NFR25)."
- **Pipeline YAML files are source of truth** — API reads/writes YAML files directly on disk. The loader's file watcher will auto-reload changes. DB stores execution history only, not definitions.
- **Pipeline name validation** — names must match `/^[a-z0-9-]+$/` (enforced by `PipelineConfigSchema`). The URL param `:name` and YAML `name` field must match.
- **Content-type for PUT** — accept raw YAML string. Fastify needs a content-type parser for `text/yaml` / `application/x-yaml`, OR use `application/json` with a `{ yaml: "..." }` wrapper. Simplest approach: register a plain text content-type parser for YAML media types.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|-----------|----------|-----------|
| `PipelineEngine` | `packages/core/src/pipeline-engine/pipeline-engine.ts` | Extend with `savePipeline` and `deletePipeline` methods |
| `PipelineLoader` | `packages/core/src/pipeline-engine/pipeline-loader.ts` | Already has `reloadPipeline(filePath)` and `removePipeline(name)` — call these after file write/delete |
| `PipelineConfigSchema` | `packages/shared/src/types/pipelines.ts` | Use for validation — `safeParse()` the parsed YAML |
| `validateDag` | `packages/core/src/pipeline-engine/dag-validator.ts` | Call after Zod validation to check DAG structure |
| `pipeline routes` | `packages/core/src/api/routes/pipelines.ts` | Add PUT and DELETE routes to existing file (4 routes → 6 routes) |
| `API server` | `packages/core/src/api/server.ts` | Already registers pipeline routes with `pipelineEngine` and `pipelineStore` deps |
| `pipelinesDir` | `packages/core/src/index.ts:141` | `resolve(projectRoot, 'config/pipelines')` — this is the configDir passed to `initialize()` |
| `yaml` package | Already installed | `import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'` — use `stringify` if needed |
| `pipeline-engine.test.ts` | `packages/core/src/__tests__/pipeline-engine.test.ts` | Extend with CRUD tests |

### How CRUD Operations Work (End-to-End)

```
PUT /api/pipelines/morning-briefing
  → Route handler receives raw YAML body
  → Parses YAML string to object
  → Checks body.name === params.name (400 if mismatch)
  → Calls pipelineEngine.savePipeline("morning-briefing", yamlString)
    → PipelineConfigSchema.safeParse(parsedYaml) — validates all fields
    → validateDag(config.nodes, config.connections) — checks for cycles
    → writeFileSync(join(configDir, "morning-briefing.yaml"), yamlString)
    → loader.reloadPipeline(filePath) — refreshes in-memory state
    → gitAutoCommit([filePath], "chore: update pipeline morning-briefing") — fire-and-forget
    → Returns { config } to route handler
  → Route returns 200 with PipelineConfig JSON

DELETE /api/pipelines/morning-briefing
  → Route handler calls pipelineEngine.deletePipeline("morning-briefing")
    → Checks file exists at join(configDir, "morning-briefing.yaml")
    → unlinkSync(filePath) — removes file
    → loader.removePipeline("morning-briefing") — clears in-memory state
    → gitAutoCommit([filePath], "chore: remove pipeline morning-briefing") — fire-and-forget
    → Returns true
  → Route returns 204 No Content
```

### Key Code Patterns

**Git auto-commit utility:**
```typescript
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.ts';

const execFile = promisify(execFileCb);
const log = createLogger('git-commit');

export async function gitAutoCommit(filePaths: string[], message: string): Promise<void> {
  try {
    await execFile('git', ['add', ...filePaths]);
    await execFile('git', ['commit', '-m', message]);
  } catch (err) {
    log.warn(`Git auto-commit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

**Fastify YAML content-type parser:**
```typescript
app.addContentTypeParser(
  ['text/yaml', 'application/x-yaml', 'text/x-yaml'],
  { parseAs: 'string' },
  (_req, body, done) => { done(null, body); },
);
```

**Extending PipelineEngine interface:**
```typescript
export interface PipelineEngine {
  // ... existing methods
  savePipeline: (name: string, yamlContent: string) => { config: PipelineConfig };
  deletePipeline: (name: string) => boolean;
}
```

**savePipeline implementation sketch:**
```typescript
savePipeline(name: string, yamlContent: string): { config: PipelineConfig } {
  const parsed: unknown = parseYaml(yamlContent);
  const result = PipelineConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Validation failed: ${result.error.message}`);
  }
  if (result.data.name !== name) {
    throw new Error('Pipeline name in body must match URL parameter');
  }
  const dagResult = validateDag(result.data.nodes, result.data.connections);
  if (!dagResult.valid) {
    throw new Error(`DAG validation failed: ${dagResult.error}`);
  }
  const filePath = join(configDir!, `${name}.yaml`);
  writeFileSync(filePath, yamlContent, 'utf-8');
  loader!.reloadPipeline(filePath);
  gitAutoCommit([filePath], `chore: update pipeline ${name}`).catch(() => {});
  return { config: result.data };
},
```

### Previous Story Intelligence

**From Story 2-4 (Pipeline Retry & Error Handling):**
- 314 tests passing — don't break them
- DI via factory functions with typed deps — `createPipelineEngine(deps)`
- Tests extend existing test files — add new `describe` blocks
- Code review feedback: keep implementations minimal, don't over-engineer
- `pipeline-executor.ts` is now ~290 lines — respect the 300-line limit per file

**From Story 2-3 (Pipeline Scheduling & Event Triggers):**
- `triggerPipeline` is non-blocking (fire-and-forget pattern) — same pattern for git auto-commit
- Event bus emissions work correctly — `config:pipelines:reloaded` event emitted on reload

**From Story 2-2 (Pipeline Execution Engine):**
- `validateDag` imported from `dag-validator.ts` — reuse in `savePipeline`
- Pipeline loader uses `readFileSync` / `existsSync` — same sync patterns for write/delete are acceptable since these are small config files

### Git Intelligence

**Recent commits:**
```
fb76c3a feat: story 2-4 — pipeline retry and error handling with code review fixes
3c6eb2a feat: story 2-3 — pipeline scheduling and event triggers
cf8db9c feat: story 2-2 — pipeline execution engine, DAG runner, and condition evaluator
b78c04e feat: story 2-1 — pipeline YAML loader, validation, and hot-reload
```

**Patterns:**
- `feat: story X-Y — description` for story commit messages
- DI via factory functions — `createPipelineEngine(deps)`
- Tests in `packages/core/src/__tests__/`
- Extend existing test files when adding to existing modules
- `@raven/shared` exports through barrel `index.ts`

### Testing Strategy

- **Git utility tests** in new file `packages/shared/src/__tests__/git-commit.test.ts` — mock `execFile` to test success/failure scenarios
- **CRUD tests** extend `pipeline-engine.test.ts` — new `describe('pipeline CRUD', ...)` block
- **Use temp directories** (`mkdtempSync`) for pipeline YAML files — write real files, test actual file I/O
- **Mock git** in CRUD tests — don't depend on git being available
- **No API-level tests needed** — route handlers are thin wrappers; test the engine methods directly
- **Verify existing tests pass** — all 314 tests must still pass

### File Structure

**New files:**
- `packages/shared/src/utils/git-commit.ts` — git auto-commit utility

**Modified files:**
- `packages/shared/src/index.ts` — export `gitAutoCommit`
- `packages/core/src/pipeline-engine/pipeline-engine.ts` — add `savePipeline`, `deletePipeline` methods + `configDir` state
- `packages/core/src/api/routes/pipelines.ts` — add PUT, DELETE routes + YAML content-type parser
- `packages/core/src/__tests__/pipeline-engine.test.ts` — add CRUD test suite

**New test file:**
- `packages/shared/src/__tests__/git-commit.test.ts` — git utility tests

### Project Structure Notes

- `gitAutoCommit` lives in `@raven/shared` (utility, shared across packages) — consistent with `generateId`, `createLogger`
- Pipeline CRUD methods live in `PipelineEngine` (not a separate service) — keeps the interface cohesive
- Routes stay in existing `pipelines.ts` — no new route files
- No new database tables — pipeline definitions are YAML files, DB is execution-only
- No schema migration needed

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-2-Story-2.5] — acceptance criteria and user story
- [Source: _bmad-output/planning-artifacts/architecture.md#API-Patterns] — Pipeline CRUD API as file-passthrough, git auto-commit with execFile
- [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure-Deployment] — Git auto-commit: execFile wrapper, fire-and-forget, failure-tolerant (NFR25)
- [Source: _bmad-output/planning-artifacts/prd.md#FR14] — Pipeline configurations are automatically git-committed on every change
- [Source: _bmad-output/planning-artifacts/prd.md#FR15] — User can view pipeline execution history and status
- [Source: _bmad-output/planning-artifacts/prd.md#NFR25] — Non-blocking git ops
- [Source: packages/core/src/pipeline-engine/pipeline-engine.ts] — PipelineEngine interface to extend
- [Source: packages/core/src/pipeline-engine/pipeline-loader.ts] — reloadPipeline(), removePipeline() methods to leverage
- [Source: packages/core/src/api/routes/pipelines.ts] — existing routes to preserve
- [Source: packages/shared/src/types/pipelines.ts] — PipelineConfigSchema for validation
- [Source: packages/core/src/pipeline-engine/dag-validator.ts] — validateDag() for DAG validation
- [Source: _bmad-output/implementation-artifacts/2-4-pipeline-retry-and-error-handling.md] — previous story patterns and learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation with no blockers.

### Completion Notes List

- ✅ Task 1: Created `gitAutoCommit` utility in `@raven/shared` — uses callback-based `execFile` (no shell injection), catches all errors, logs warnings, never throws. 5 unit tests.
- ✅ Task 2: Extended `PipelineEngine` interface with `savePipeline` and `deletePipeline`. savePipeline validates YAML → Zod schema → DAG → writes file → reloads loader → fire-and-forget git commit. deletePipeline removes file + loader entry + fire-and-forget git. 7 engine-level tests.
- ✅ Task 3: Added PUT and DELETE routes with YAML content-type parser (`text/yaml`, `application/x-yaml`, `text/x-yaml`). PUT returns 200 with config JSON, DELETE returns 204. Error cases return 400/404. 7 route-level tests.
- ✅ Task 4: All tests written and passing — 14 new tests (5 git + 7 CRUD engine + 7 CRUD API routes = 19 new tests total, but some tests cover multiple subtasks). Full suite: 334 passed, 0 regressions.
- Also updated mock PipelineEngine objects in `pipeline-event-trigger.test.ts` and `pipeline-scheduler.test.ts` to include new interface methods.

### Change Log

- 2026-03-14: Story 2-5 implementation complete — pipeline CRUD API and git auto-commit
- 2026-03-14: Code review fixes — PUT route error differentiation (400 vs 500), removed redundant .catch on gitAutoCommit, added tests for CRUD before initialize, added vi.mock hoisting comment

### File List

**New files:**
- `packages/shared/src/utils/git-commit.ts` — git auto-commit utility
- `packages/shared/src/__tests__/git-commit.test.ts` — git auto-commit tests

**Modified files:**
- `packages/shared/src/index.ts` — export `gitAutoCommit`
- `packages/core/src/pipeline-engine/pipeline-engine.ts` — added `savePipeline`, `deletePipeline`, `storedConfigDir`
- `packages/core/src/api/routes/pipelines.ts` — added PUT/DELETE routes, YAML content-type parser
- `packages/core/src/__tests__/pipeline-engine.test.ts` — added CRUD engine + API route tests
- `packages/core/src/__tests__/pipeline-event-trigger.test.ts` — updated mock PipelineEngine
- `packages/core/src/__tests__/pipeline-scheduler.test.ts` — updated mock PipelineEngine
