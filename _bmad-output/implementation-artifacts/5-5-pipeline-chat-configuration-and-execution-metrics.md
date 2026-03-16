# Story 5.5: Pipeline Chat Configuration & Execution Metrics

Status: done

## Story

As the dashboard user,
I want to configure pipelines via chat with YAML preview and view execution metrics,
So that I can create automations conversationally and track system performance.

## Acceptance Criteria

1. **Given** the user describes a pipeline in the chat panel, **When** Raven generates the YAML, **Then** a formatted YAML preview is shown with `[Save] [Edit] [Cancel]` actions
2. **Given** the user clicks "Save" on a pipeline preview, **When** the pipeline is PUT to the API, **Then** it is validated, saved to disk, and git-committed
3. **Given** the user navigates to execution metrics, **When** the metrics load, **Then** they show total tasks run, success rate, average duration, and per-skill breakdown for the selected time period

## Tasks / Subtasks

- [x] Task 1: Backend — Pipeline metrics API endpoint (AC: #3)
  - [x] 1.1 Add `getGlobalStats(sinceMs)` to `PipelineStore` — aggregate total runs, success/fail counts, avg duration across all pipelines
  - [x] 1.2 Add `getPerSkillStats(sinceMs)` to `ExecutionLogger` — group agent task stats by `skill_name`
  - [x] 1.3 Register `GET /api/metrics` route returning combined pipeline + task stats with `?period=1h|24h|7d|30d` query param
  - [x] 1.4 Add tests for the new metrics endpoint

- [x] Task 2: Backend — Pipeline save via API enhancement (AC: #1, #2)
  - [x] 2.1 Verify existing `PUT /api/pipelines/:name` handles raw YAML string body correctly (already implemented — confirm content-type handling)
  - [x] 2.2 Verify git auto-commit fires on pipeline save (already wired in pipeline engine — confirm)

- [x] Task 3: Frontend — YAML preview component for chat (AC: #1, #2)
  - [x] 3.1 Create `PipelinePreview.tsx` component in `packages/web/src/components/chat/`
  - [x] 3.2 Renders YAML in a syntax-highlighted `<pre>` block with Save / Edit / Cancel buttons
  - [x] 3.3 Save calls `PUT /api/pipelines/:name` with YAML body (text/yaml content-type)
  - [x] 3.4 Edit toggles an editable `<textarea>` for manual YAML tweaks
  - [x] 3.5 Cancel dismisses the preview

- [x] Task 4: Frontend — Chat message type detection for pipeline YAML (AC: #1)
  - [x] 4.1 Add pipeline YAML detection in `ChatPanel.tsx` message rendering — detect YAML code blocks containing `name:`, `trigger:`, `nodes:`, `connections:` keys
  - [x] 4.2 When detected, render `PipelinePreview` instead of plain markdown
  - [x] 4.3 Track preview state (idle / saving / saved / error) per message

- [x] Task 5: Frontend — Execution metrics page (AC: #3)
  - [x] 5.1 Create `packages/web/src/app/metrics/page.tsx`
  - [x] 5.2 Add metrics API client method: `api.getMetrics(period)`
  - [x] 5.3 Period selector: 1h / 24h / 7d / 30d buttons (default: 24h)
  - [x] 5.4 Summary cards: total tasks, success rate (%), avg duration, total pipeline runs
  - [x] 5.5 Per-skill breakdown table: skill name, task count, success rate, avg duration
  - [x] 5.6 Per-pipeline breakdown table: pipeline name, run count, success rate, avg duration

- [x] Task 6: Frontend — Sidebar & navigation (AC: #3)
  - [x] 6.1 Add "Metrics" nav item to `Sidebar.tsx` with `%` icon character

- [x] Task 7: Integration tests (AC: #1, #2, #3)
  - [x] 7.1 Test `GET /api/metrics` returns correct shape with period param
  - [x] 7.2 Test metrics aggregation accuracy (insert known runs, verify counts)

## Dev Notes

### Architecture Constraints

- **Flat page structure** — `/metrics` is a top-level route, self-contained page
- **No classes** — all utilities are plain functions
- **usePolling for data refresh** — established pattern, 10s interval for metrics is fine (not time-critical)
- **CSS variables for theming** — use `var(--bg-card)`, `var(--border)`, `var(--text-muted)`, `var(--success)`, `var(--warning)`, `var(--error)`, `var(--accent)` from `globals.css`
- **Tailwind CSS 4** — utility classes, no custom CSS
- **No new npm dependencies** — everything already available (no syntax highlighting library needed — use simple `<pre>` with CSS)
- **Character icons, not emoji** — Sidebar uses ASCII characters. Metrics icon: `%`
- **ESLint guardrails** — `max-lines-per-function` (50), `complexity` (10), `no-magic-numbers`. Extract sub-components and use lookup maps

### Chat YAML Preview — Critical Design Decisions

The chat panel already streams assistant messages via WebSocket. When the orchestrator generates pipeline YAML in response to a user request, it will arrive as a markdown code block in the assistant message stream.

**Detection strategy:** Parse rendered assistant messages for YAML code blocks (` ```yaml `) that contain pipeline-signature keys (`name:`, `trigger:`, `nodes:`, `connections:`). This is frontend-only detection — no backend changes to the chat/orchestrator flow.

**Save flow:**
1. User clicks Save → extract YAML string from the code block
2. Parse YAML client-side to extract `name` field
3. `PUT /api/pipelines/${name}` with YAML string body and `Content-Type: text/yaml`
4. The existing pipeline route already validates, saves to disk, and triggers git auto-commit
5. Show success/error feedback inline

**Edit flow:** Toggle the `<pre>` to a `<textarea>` with the raw YAML. User edits, then can Save or Cancel.

**Important:** The `request()` helper in `api-client.ts` currently sets `Content-Type: application/json` when body is present. The pipeline save call needs `Content-Type: text/yaml` with a raw string body. Add a new `api.savePipeline(name, yamlString)` method that sends raw text.

### Metrics API — Backend Design

**New endpoint:** `GET /api/metrics?period=24h`

**Existing infrastructure to reuse:**
- `ExecutionLogger.getTaskStats(sinceMs)` — already returns `{total1h, succeeded1h, failed1h, avgDurationMs, lastTaskAt}` but is hardcoded to 1h column names. The `sinceMs` param already works for any window — the column names are just misleading.
- `PipelineStore.getRecentRuns(name, limit)` — per-pipeline only. Need a new global aggregation query.

**New queries needed:**
1. **Global pipeline stats:** `SELECT COUNT(*), SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), ... FROM pipeline_runs WHERE started_at > ?`
2. **Per-skill task stats:** `SELECT skill_name, COUNT(*), ... FROM agent_tasks WHERE created_at > ? GROUP BY skill_name`
3. **Per-pipeline stats:** `SELECT pipeline_name, COUNT(*), ... FROM pipeline_runs WHERE started_at > ? GROUP BY pipeline_name`

**Response shape:**
```typescript
interface MetricsResponse {
  period: string;
  tasks: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    avgDurationMs: number | null;
  };
  pipelines: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    avgDurationMs: number | null;
  };
  perSkill: Array<{
    skillName: string;
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    avgDurationMs: number | null;
  }>;
  perPipeline: Array<{
    pipelineName: string;
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    avgDurationMs: number | null;
  }>;
}
```

**Period mapping:** `1h` → 3600000ms, `24h` → 86400000ms, `7d` → 604800000ms, `30d` → 2592000000ms

### Existing Infrastructure to Reuse (DO NOT Recreate)

| Component | Location | Reuse How |
|---|---|---|
| `PUT /api/pipelines/:name` | `packages/core/src/api/routes/pipelines.ts` | Already handles YAML save + validation. Just call it from frontend |
| `PipelineStore` | `packages/core/src/pipeline-engine/pipeline-store.ts` | Extend with `getGlobalStats()` |
| `ExecutionLogger` | `packages/core/src/agent-manager/execution-logger.ts` | Extend with `getPerSkillStats()` |
| `TaskStats` interface | `packages/core/src/agent-manager/execution-logger.ts:35` | Reference for task stats shape |
| `usePolling` hook | `packages/web/src/hooks/usePolling.ts` | Use for metrics page polling |
| `formatDuration()` | `packages/web/src/lib/pipeline-helpers.ts` | Reuse for duration display |
| `formatRelativeTime()` | `packages/web/src/lib/event-helpers.ts` | Reuse for timestamps |
| `ChatPanel.tsx` | `packages/web/src/components/chat/ChatPanel.tsx` | Extend message rendering (don't rewrite) |
| `api-client.ts` | `packages/web/src/lib/api-client.ts` | Add `savePipeline()` and `getMetrics()` methods |
| `Sidebar.tsx` | `packages/web/src/components/layout/Sidebar.tsx` | Add Metrics nav item |
| Health endpoint | `packages/core/src/api/routes/health.ts` | Reference for how `taskStats` is already exposed |
| `pipeline-helpers.ts` | `packages/web/src/lib/pipeline-helpers.ts` | Follow same lookup-map pattern for any new helpers |
| `task-helpers.ts` | `packages/web/src/lib/task-helpers.ts` | Reference for helper patterns |

### Pipeline YAML Schema Reference

The dev agent MUST know the valid pipeline YAML structure for client-side validation feedback:

```yaml
name: kebab-case-name          # required, [a-z0-9-]+
description: optional string
version: 1
trigger:
  type: cron | event | manual | webhook
  schedule: "cron expression"   # if type=cron
  event: "event:type"           # if type=event
nodes:
  node-id:                      # kebab-case, unique
    skill: skill-name
    action: action-name
    params: {}
connections:
  - from: node-id
    to: node-id
enabled: true | false
```

### File Structure — New Files

```
packages/core/src/api/routes/metrics.ts          # NEW: metrics endpoint
packages/web/src/app/metrics/page.tsx             # NEW: metrics page
packages/web/src/components/chat/PipelinePreview.tsx  # NEW: YAML preview in chat
packages/web/src/lib/metrics-helpers.ts           # NEW: metrics display helpers (if needed)
```

### File Structure — Modified Files

```
packages/core/src/pipeline-engine/pipeline-store.ts  # Add getGlobalStats()
packages/core/src/agent-manager/execution-logger.ts  # Add getPerSkillStats()
packages/core/src/api/server.ts                       # Register metrics route
packages/web/src/lib/api-client.ts                    # Add savePipeline(), getMetrics()
packages/web/src/components/chat/ChatPanel.tsx         # Pipeline YAML detection + PipelinePreview rendering
packages/web/src/components/layout/Sidebar.tsx         # Add Metrics nav item
```

### Project Structure Notes

- All new files follow existing `kebab-case.ts` naming
- New route follows established pattern in `packages/core/src/api/routes/` — factory function, dependency injection via `ApiDeps`
- Metrics page follows flat page architecture at `/metrics`
- `PipelinePreview` goes in `components/chat/` since it's a chat message sub-component
- No new shared types needed — the `MetricsResponse` interface can live in the route file or api-client

### Previous Story Intelligence (Story 5.4 — Kanban Task Board)

**Key learnings to apply:**
- ESLint guardrails required extracting sub-components to stay under `max-lines-per-function` (50). Plan for this from the start.
- Magic numbers must be extracted to constants (e.g., `POLL_INTERVAL_MS = 10_000`, `DEFAULT_PERIOD = '24h'`)
- `usePolling` URL changes trigger fresh fetch automatically — use this for period selector
- `formatRelativeTime()` from `event-helpers.ts` is reusable
- Separate helper files keep page files clean and under 300 lines
- Character-based icons in styled circles are the established UI pattern
- Detail panels use client-side state toggle, not separate routes
- Code review caught: unused fallbacks, silent error swallowing, missing refresh callbacks. Avoid these.

### Git Intelligence

Recent commits show:
- Story 5.4 (kanban) added task card components, SSE streaming detail, task helpers
- Story 5.3 (pipeline monitor) established PipelineCard, PipelineDetail patterns
- Story 5.1 established usePolling and useSSE hooks
- Commit `ef72db7` fixed polling staleness and sidebar accessibility — aria-current is now on sidebar links

### Testing Strategy

- **Backend integration tests** in `packages/core/src/__tests__/api.test.ts` (extend existing):
  - `GET /api/metrics` returns valid shape
  - `GET /api/metrics?period=1h` respects period param
  - Metrics reflect inserted test data accurately
- **No frontend unit tests** — UI composition verified via browser testing
- **Manual verification:** Describe a pipeline in chat, verify YAML preview renders, Save persists to API

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 5, Story 5.5]
- [Source: _bmad-output/planning-artifacts/architecture.md — Pipeline CRUD API, SSE Stream Format, Frontend Architecture]
- [Source: _bmad-output/planning-artifacts/prd.md — FR31 (pipeline config via chat), FR67 (execution metrics)]
- [Source: packages/core/src/api/routes/pipelines.ts — existing PUT endpoint]
- [Source: packages/core/src/pipeline-engine/pipeline-store.ts — PipelineStore interface]
- [Source: packages/core/src/agent-manager/execution-logger.ts — TaskStats, getTaskStats()]
- [Source: packages/web/src/lib/api-client.ts — existing API methods]
- [Source: _bmad-output/implementation-artifacts/5-4-kanban-agent-task-board.md — previous story learnings]
- [Source: _bmad-output/project-context.md — coding conventions and anti-patterns]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 621 tests pass (42 test files), 0 regressions
- `npm run check` passes (format, lint, type-check, strip-types)
- Next.js build compiles `/metrics` page successfully

### Completion Notes List
- **Task 1**: Added `getGlobalStats()`, `getPerPipelineStats()` to PipelineStore; `getPerSkillStats()` to ExecutionLogger; created `GET /api/metrics` route with period param (1h/24h/7d/30d); added 4 integration tests
- **Task 2**: Verified existing `PUT /api/pipelines/:name` handles YAML content-type and git auto-commit already works
- **Task 3**: Created `PipelinePreview.tsx` with Save/Edit/Cancel actions, YAML editor toggle, API save via `text/yaml` content-type
- **Task 4**: Added pipeline YAML detection in ChatPanel — detects YAML code blocks with 3+ pipeline-signature keys (name, trigger, nodes, connections), renders PipelinePreview instead of markdown
- **Task 5**: Created `/metrics` page with period selector, summary cards (total tasks, success rate, avg duration, pipeline runs), per-skill and per-pipeline breakdown tables using usePolling
- **Task 6**: Added "Metrics" nav item to Sidebar with `%` icon; changed Settings icon to `&` to avoid conflict
- **Task 7**: Integration tests already covered in Task 1.4 — metrics shape, period param, aggregation accuracy

### Change Log
- 2026-03-16: Implemented all 7 tasks for Story 5.5 — pipeline metrics API, chat YAML preview, execution metrics page
- 2026-03-17: Code review fixes — ChatPanel renders surrounding markdown around YAML preview (M1), savePipeline surfaces server validation errors (M2)

### File List
- `packages/core/src/api/routes/metrics.ts` (NEW)
- `packages/core/src/pipeline-engine/pipeline-store.ts` (MODIFIED — added getGlobalStats, getPerPipelineStats)
- `packages/core/src/agent-manager/execution-logger.ts` (MODIFIED — added getPerSkillStats)
- `packages/core/src/api/server.ts` (MODIFIED — registered metrics route)
- `packages/core/src/__tests__/api.test.ts` (MODIFIED — added metrics tests)
- `packages/core/src/__tests__/pipeline-engine.test.ts` (MODIFIED — updated mock PipelineStore)
- `packages/core/src/__tests__/pipeline-executor.test.ts` (MODIFIED — updated mock PipelineStore)
- `packages/web/src/components/chat/PipelinePreview.tsx` (NEW)
- `packages/web/src/components/chat/ChatPanel.tsx` (MODIFIED — pipeline YAML detection, sub-components)
- `packages/web/src/lib/api-client.ts` (MODIFIED — added savePipeline, getMetrics, MetricsResponse)
- `packages/web/src/app/metrics/page.tsx` (NEW)
- `packages/web/src/components/layout/Sidebar.tsx` (MODIFIED — added Metrics nav item)
