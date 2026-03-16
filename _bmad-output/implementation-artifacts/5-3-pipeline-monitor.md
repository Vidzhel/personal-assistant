# Story 5.3: Pipeline Monitor

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the dashboard user,
I want to see pipeline execution status and health in real-time,
So that I can verify automations are running correctly.

## Acceptance Criteria

1. **Pipeline List View** — Given 3 pipelines are configured, When the user opens the pipelines page, Then all 3 are listed with name, trigger type (cron/event/manual), enabled/disabled status, last run time, and next run time (cron pipelines only).

2. **Running Pipeline Indicator** — Given a pipeline is currently running, When the page polls, Then the status shows an animated "running" indicator (e.g., pulsing dot or spinner).

3. **Pipeline Detail View** — Given the user clicks a pipeline, When the detail view opens, Then the last 10 executions are shown with status (completed/failed/running/cancelled), duration, and per-node results.

4. **Failed Execution Details** — Given a pipeline execution failed, When the error details are viewed, Then the specific failed node, error message, and retry history are displayed.

## Tasks / Subtasks

- [x] Task 1: Add `nextRun` enrichment to pipeline list API (AC: #1)
  - [x] 1.1 In `packages/core/src/pipeline-engine/pipeline-scheduler.ts`, expose the `cronJobs` Map via a new `getNextRun(name: string): string | null` method on the `PipelineScheduler` interface
  - [x] 1.2 In `packages/core/src/api/routes/pipelines.ts`, extend `GET /api/pipelines` to enrich each pipeline with `lastRun` (most recent `pipeline_runs` row) and `nextRun` (from scheduler). Return an enriched array with the added fields.
  - [x] 1.3 Add `GET /api/pipelines/:name/runs` endpoint already exists — verify it returns `PipelineRunRecord[]` correctly (no changes expected)

- [x] Task 2: Add pipeline API methods to `api-client.ts` (AC: #1, #3, #4)
  - [x] 2.1 In `packages/web/src/lib/api-client.ts`, add:
    - `getPipelines(): Promise<EnrichedPipeline[]>` — calls `GET /api/pipelines`
    - `getPipeline(name: string): Promise<EnrichedPipeline>` — calls `GET /api/pipelines/:name`
    - `getPipelineRuns(name: string, limit?: number): Promise<PipelineRunRecord[]>` — calls `GET /api/pipelines/:name/runs`
    - `triggerPipeline(name: string): Promise<{ runId: string; status: string }>` — calls `POST /api/pipelines/:name/trigger`
  - [x] 2.2 Define frontend types: `EnrichedPipeline` (pipeline config + lastRun + nextRun), `PipelineRunRecord` matching the DB schema

- [x] Task 3: Create pipeline display helpers (AC: #1, #2, #3, #4)
  - [x] 3.1 Create `packages/web/src/lib/pipeline-helpers.ts` — utility functions for pipeline presentation
  - [x] 3.2 `getPipelineStatusColor(status: string): string` — maps run status to CSS variable (`completed` → success, `failed` → error, `running` → warning, `cancelled` → muted)
  - [x] 3.3 `getPipelineStatusIcon(status: string): string` — maps status to character icon
  - [x] 3.4 `getTriggerLabel(trigger: object): string` — human-readable trigger description (e.g., "Cron: 0 6 * * *" or "Event: email:new")
  - [x] 3.5 `formatDuration(ms: number): string` — formats duration as "1.2s", "45s", "2m 30s", etc.
  - [x] 3.6 `parseNodeResults(nodeResultsJson: string | null): NodeResult[]` — safely parses the JSON blob into typed node results with status/duration/error per node

- [x] Task 4: Create Pipeline List page (AC: #1, #2)
  - [x] 4.1 Create `packages/web/src/app/pipelines/page.tsx` — main pipeline monitor page
  - [x] 4.2 Use `usePolling` to fetch `GET /api/pipelines` (5s interval) for live status updates
  - [x] 4.3 Display pipeline cards: name, description, trigger type label, enabled badge, last run status + time, next run time
  - [x] 4.4 Running pipelines show animated indicator (CSS pulse animation on status dot)
  - [x] 4.5 Click on a pipeline card opens detail view (client-side state toggle, NOT a separate route)
  - [x] 4.6 Empty state: "No pipelines configured" with guidance
  - [x] 4.7 Loading state: skeleton placeholders

- [x] Task 5: Create Pipeline Detail panel (AC: #3, #4)
  - [x] 5.1 Create `packages/web/src/components/pipelines/PipelineDetail.tsx` — expandable detail panel
  - [x] 5.2 Fetch runs via `usePolling` on `GET /api/pipelines/:name/runs?limit=10` (10s interval, only when panel is open)
  - [x] 5.3 Display run history: status icon, trigger type, started_at (relative time), duration, expand for node results
  - [x] 5.4 Failed runs: show error message prominently, highlight the failed node in the node results
  - [x] 5.5 Node results: collapsible list showing each node's status, duration, and error (if any)
  - [x] 5.6 Manual trigger button: "Run Now" button that calls `POST /api/pipelines/:name/trigger`

- [x] Task 6: Add Pipelines to Sidebar navigation (AC: #1)
  - [x] 6.1 In `packages/web/src/components/layout/Sidebar.tsx`, add `{ href: '/pipelines', label: 'Pipelines', icon: '|' }` to the nav array — insert after Activity (`>`)

- [x] Task 7: Tests (AC: #1, #3)
  - [x] 7.1 Add tests to `packages/core/src/__tests__/api.test.ts` (extend existing):
    - Test: `GET /api/pipelines` returns enriched pipeline list with lastRun/nextRun
    - Test: `GET /api/pipelines/:name/runs` returns run history
  - [x] 7.2 No frontend tests needed — page is a UI composition using tested hooks and backend API. Verify through browser testing.

## Dev Notes

### Architecture Constraints

- **Flat page structure** — `/pipelines` is a top-level route, self-contained page (architecture doc: "Each view is top-level")
- **No classes** — all utilities are plain functions
- **usePolling for data refresh** — story 5.1 established this pattern. Use `usePolling` from `packages/web/src/hooks/usePolling.ts`
- **CSS variables for theming** — use `var(--bg-card)`, `var(--border)`, `var(--text-muted)`, `var(--success)`, `var(--warning)`, `var(--error)` from `globals.css`. DO NOT use hardcoded colors
- **Tailwind CSS 4** — use utility classes, no custom CSS except `@keyframes` for pulse animation (add to `globals.css`)
- **No new npm dependencies** — everything needed is already available
- **Character icons, not emoji** — Sidebar uses ASCII characters (`~`, `#`, `>`, `@`, `*`, `%`). Pipeline icon should be `|` (pipe character). Status icons in pipeline cards should also use characters.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Pipeline API routes | `packages/core/src/api/routes/pipelines.ts` | **EXTEND** — enrich `GET /api/pipelines` response with lastRun/nextRun |
| Pipeline store | `packages/core/src/pipeline-engine/pipeline-store.ts` | **USE** — `getRecentRuns()` for last run data |
| Pipeline scheduler | `packages/core/src/pipeline-engine/pipeline-scheduler.ts` | **EXTEND** — expose `getNextRun()` for cron job next fire time |
| Pipeline engine | `packages/core/src/pipeline-engine/pipeline-engine.ts` | **USE** — `getAllPipelines()` returns `ValidatedPipeline[]` |
| Pipeline loader | `packages/core/src/pipeline-engine/pipeline-loader.ts` | **REFERENCE** — `ValidatedPipeline` type: `{ config: PipelineConfig, executionOrder: string[], entryPoints: string[], filePath: string, loadedAt: string }` |
| Pipeline types | `packages/shared/src/types/pipelines.ts` | **USE** — `PipelineConfig`, `PipelineRunRecord`, all Zod schemas |
| usePolling hook | `packages/web/src/hooks/usePolling.ts` | **USE** — returns `{ data, loading, error, refresh }` |
| api-client.ts | `packages/web/src/lib/api-client.ts` | **EXTEND** — add pipeline methods |
| event-helpers.ts | `packages/web/src/lib/event-helpers.ts` | **REFERENCE** — follow same pattern for pipeline-helpers.ts |
| Activity page | `packages/web/src/app/activity/page.tsx` | **REFERENCE** — design pattern for polling + card layout |
| Sidebar | `packages/web/src/components/layout/Sidebar.tsx` | **MODIFY** — add Pipelines nav item |
| globals.css | `packages/web/src/app/globals.css` | **EXTEND** — add pulse keyframe animation for running indicator |

### Pipeline API Response Shapes

**`GET /api/pipelines`** currently returns `ValidatedPipeline[]`:
```typescript
interface ValidatedPipeline {
  config: PipelineConfig;      // Full pipeline YAML parsed config
  executionOrder: string[];    // Topological sort of node IDs
  entryPoints: string[];       // Nodes with no inbound connections
  filePath: string;            // Absolute path to YAML file
  loadedAt: string;            // ISO timestamp when loaded
}
```

**Task 1 enriches this to:**
```typescript
interface EnrichedPipeline extends ValidatedPipeline {
  lastRun: PipelineRunRecord | null;  // Most recent run from DB
  nextRun: string | null;             // ISO timestamp of next cron fire (null for non-cron)
}
```

**`GET /api/pipelines/:name/runs`** returns `PipelineRunRecord[]`:
```typescript
interface PipelineRunRecord {
  id: string;
  pipeline_name: string;
  trigger_type: string;        // 'manual' | 'cron' | 'event'
  status: string;              // 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string;          // ISO timestamp
  completed_at?: string;       // ISO timestamp (null if running)
  node_results?: string;       // JSON string: Record<string, { status, output?, error?, durationMs }>
  error?: string;              // Top-level error message
}
```

**`PipelineConfig` key fields:**
```typescript
interface PipelineConfig {
  name: string;                // kebab-case identifier
  description?: string;
  version: number;
  trigger: {
    type: 'cron' | 'event' | 'manual' | 'webhook';
    schedule?: string;         // cron expression (when type=cron)
    event?: string;            // event type (when type=event)
    filter?: Record<string, string>;
  };
  settings?: {
    retry?: { maxAttempts: number; backoffMs: number };
    timeout?: number;
    onError?: 'stop' | 'continue';
  };
  nodes: Record<string, PipelineNode>;
  connections: PipelineConnection[];
  enabled: boolean;
}
```

### Pipeline Scheduler — Exposing nextRun

The `PipelineScheduler` in `pipeline-scheduler.ts` stores cron jobs in a private `cronJobs: Map<string, Cron>`. Croner's `Cron` class has a `.nextRun(): Date | null` method.

**To expose next run times:**
1. Add `getNextRun(name: string): string | null` to the `PipelineScheduler` interface
2. Implementation: `const job = cronJobs.get(name); return job?.nextRun()?.toISOString() ?? null;`
3. Pass the scheduler to the API routes (currently routes get `pipelineEngine` and `pipelineStore` but NOT the scheduler)
4. Update `registerPipelineRoutes` deps to include `pipelineScheduler?: PipelineScheduler`
5. In `packages/core/src/index.ts` boot sequence, pass the scheduler to the API server deps

### API Enrichment Pattern

In `GET /api/pipelines`, map each pipeline to add `lastRun` and `nextRun`:
```typescript
const enriched = pipelines.map(p => ({
  ...p,
  lastRun: pipelineStore?.getRecentRuns(p.config.name, 1)[0] ?? null,
  nextRun: pipelineScheduler?.getNextRun(p.config.name) ?? null,
}));
```

This keeps the enrichment server-side and avoids N+1 API calls from the frontend.

### Node Results JSON Structure

The `node_results` field in `PipelineRunRecord` is a JSON-stringified object:
```typescript
// Stored by the executor as: JSON.stringify(Object.fromEntries(nodeOutputs))
// Each entry is: { status: NodeStatus, output?: unknown, error?: string, durationMs?: number }
type NodeResultMap = Record<string, {
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  durationMs?: number;
}>;
```

The pipeline detail panel should parse this JSON safely (try/catch) and display per-node status.

### Design Pattern Reference

Follow the Activity page pattern (story 5.2):
- `FilterBar` component for any filtering needs (not required for initial pipeline monitor)
- Card-based layout with icon circles, status badges, and relative timestamps
- Skeleton loading state on first load
- Empty state with descriptive message
- CSS variables from `globals.css` for all colors

**Color mapping:**
- `completed` → `var(--success)` (#22c55e)
- `failed` → `var(--error)` (#ef4444)
- `running` → `var(--warning)` (#eab308)
- `cancelled` → `var(--text-muted)` (#737373)
- enabled → `var(--success)`, disabled → `var(--text-muted)`

**Component extraction:** If `page.tsx` exceeds 300 lines, extract components to `packages/web/src/components/pipelines/`:
- `PipelineCard.tsx` — individual pipeline list item
- `PipelineDetail.tsx` — expandable execution history panel
- `RunHistoryItem.tsx` — individual run row with expandable node results

### Previous Story Intelligence (5.2)

Key patterns from story 5.2 (Activity Timeline) to follow:
- ESLint guardrail rules require extracting components and using lookup maps instead of if-chains (`max-lines-per-function`, `complexity`, `no-magic-numbers`)
- `usePolling` URL changes when state changes → triggers fresh fetch automatically
- `formatRelativeTime()` from `event-helpers.ts` is reusable — import it for timestamps
- `FilterSelect` component pattern exists in activity page — reference for any dropdowns needed
- Separate helper files keep page files clean and under 300 lines
- Character-based icons in styled circles are the established UI pattern

### Git Intelligence

Recent commits:
- `6ff944b feat: polling and SSE infrastructure with hooks (story 5.1)` — established `usePolling`/`useSSE` hooks
- `2ee3e0d feat: activity timeline with rich cards, filters, and review fixes (story 5.2)` — established rich card UI pattern
- Commit message pattern: `feat: <description> (story X.Y)`
- ESLint strict compliance required (`npm run check` must pass)
- `.ts` extensions in imports enforced

### NFR Compliance

- **NFR15 (200ms API):** Pipeline list enrichment adds 1 DB query per pipeline for lastRun — acceptable for single-user with few pipelines. If ever needed, batch into a single SQL query.
- **NFR18 (Non-blocking I/O):** All data fetching via async `usePolling` + async Fastify handler
- **NFR29 (Structured logging):** Use `createLogger('pipelines')` if adding logging

### Project Structure Notes

- **New files:**
  - `packages/web/src/app/pipelines/page.tsx` — pipeline monitor page
  - `packages/web/src/lib/pipeline-helpers.ts` — pipeline display utility functions
  - `packages/web/src/components/pipelines/PipelineDetail.tsx` — detail panel component
  - `packages/web/src/components/pipelines/PipelineCard.tsx` — list card component (if needed for 300-line limit)
- **Modified files:**
  - `packages/core/src/pipeline-engine/pipeline-scheduler.ts` — add `getNextRun()` method
  - `packages/core/src/api/routes/pipelines.ts` — enrich `GET /api/pipelines` with lastRun/nextRun
  - `packages/core/src/index.ts` — pass scheduler to API server deps
  - `packages/web/src/lib/api-client.ts` — add pipeline API methods + types
  - `packages/web/src/components/layout/Sidebar.tsx` — add Pipelines nav item
  - `packages/web/src/app/globals.css` — add pulse keyframe animation
  - `packages/core/src/__tests__/api.test.ts` — add pipeline API tests
- **No changes to:**
  - `packages/shared/src/types/` — all needed types exist
  - Database/migrations — no schema changes
  - `usePolling` hook — use as-is
  - Pipeline engine/executor/store — use as-is

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 5, Story 5.3]
- [Source: _bmad-output/planning-artifacts/prd.md — FR29: Pipeline execution status and health in real-time]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Architecture (usePolling + flat page), Pipeline CRUD API, Pipeline concurrency]
- [Source: _bmad-output/project-context.md — TypeScript ESM, Fastify patterns, CSS variables, Vitest testing]
- [Source: _bmad-output/implementation-artifacts/5-2-activity-timeline.md — usePolling patterns, event-helpers.ts, card-based design, component extraction for ESLint]
- [Source: packages/core/src/api/routes/pipelines.ts — Existing 6 pipeline API endpoints]
- [Source: packages/core/src/pipeline-engine/pipeline-store.ts — PipelineStore interface, getRecentRuns()]
- [Source: packages/core/src/pipeline-engine/pipeline-scheduler.ts — Cron job management, cronJobs Map, Croner nextRun()]
- [Source: packages/core/src/pipeline-engine/pipeline-loader.ts — ValidatedPipeline type]
- [Source: packages/shared/src/types/pipelines.ts — PipelineConfig, PipelineRunRecord, PipelineNode Zod schemas]
- [Source: packages/web/src/hooks/usePolling.ts — Generic polling hook: { data, loading, error, refresh }]
- [Source: packages/web/src/lib/api-client.ts — API client pattern, no pipeline methods yet]
- [Source: packages/web/src/components/layout/Sidebar.tsx — Nav array with character icons]
- [Source: packages/web/src/app/globals.css — CSS variables: --bg-card, --border, --success, --warning, --error]
- [Source: packages/web/src/lib/event-helpers.ts — Helper function pattern with lookup maps]
- [Source: migrations/003-pipeline-runs.sql — pipeline_runs table schema]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- ESLint guardrail rules required extracting PipelineCard sub-components (EnabledBadge, LastRunStatus) and PipelineDetail sub-components (RunsSkeleton, RunsList, DetailHeader) to stay under max-lines-per-function and complexity limits
- Magic number 0.7 extracted to DISABLED_OPACITY constant

### Completion Notes List
- Task 1: Added `getNextRun()` to PipelineScheduler interface, enriched `GET /api/pipelines` with lastRun/nextRun, passed scheduler through server deps to API routes
- Task 2: Added `getPipelines`, `getPipeline`, `getPipelineRuns`, `triggerPipeline` to api-client with full frontend types (EnrichedPipeline, PipelineRunRecord, PipelineConfig, PipelineTrigger)
- Task 3: Created pipeline-helpers.ts with status color/icon maps, trigger label formatter, duration formatter, and node results JSON parser
- Task 4: Created `/pipelines` page with usePolling (5s), pipeline cards, skeleton loading, empty state
- Task 5: Created PipelineDetail panel with run history (usePolling 10s), expandable node results, error display, "Run Now" trigger button
- Task 6: Added Pipelines nav item to Sidebar after Activity
- Task 7: Added 2 API integration tests for enriched pipeline list and run history endpoints

### File List
- `packages/core/src/pipeline-engine/pipeline-scheduler.ts` — added `getNextRun()` method to interface and implementation
- `packages/core/src/api/routes/pipelines.ts` — enriched GET /api/pipelines with lastRun/nextRun, added pipelineScheduler dep
- `packages/core/src/api/server.ts` — added pipelineScheduler to ApiDeps, passed to pipeline routes
- `packages/core/src/index.ts` — passed pipelineScheduler to createApiServer deps
- `packages/web/src/lib/api-client.ts` — added pipeline API methods and types
- `packages/web/src/lib/pipeline-helpers.ts` — NEW: display utility functions
- `packages/web/src/app/pipelines/page.tsx` — NEW: pipeline monitor page
- `packages/web/src/components/pipelines/PipelineCard.tsx` — NEW: pipeline list card
- `packages/web/src/components/pipelines/PipelineDetail.tsx` — NEW: detail panel with run history
- `packages/web/src/components/layout/Sidebar.tsx` — added Pipelines nav item
- `packages/web/src/app/globals.css` — added pulse-ring keyframe animation
- `packages/core/src/__tests__/api.test.ts` — added pipeline API tests

### Change Log
- 2026-03-16: Implemented story 5.3 Pipeline Monitor — all 7 tasks complete
- 2026-03-16: Code review fixes — enriched GET /api/pipelines/:name with lastRun/nextRun, added error handling to trigger button, added 2 tests for single-pipeline endpoint
