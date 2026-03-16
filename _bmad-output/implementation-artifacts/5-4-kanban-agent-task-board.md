# Story 5.4: Kanban Agent Task Board

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the dashboard user,
I want a Kanban-style board showing active and completed agent tasks,
So that I can see what Raven is working on right now.

## Acceptance Criteria

1. **Kanban Board Layout** — Given 2 agent tasks are running and 5 completed today, When the user views the task board, Then 2 cards are in the "Running" column and 5 in the "Completed" column.

2. **Live Streaming Detail** — Given a running task card is clicked, When the detail panel opens, Then the agent's output streams in real-time via SSE.

3. **Real-Time Task Appearance** — Given a new task starts, When the board polls, Then a new card appears in the "Running" column.

4. **Failed Task Display** — Given a task fails, When it moves to "Failed", Then the card shows the error summary and the full error is viewable on click.

## Tasks / Subtasks

- [x] Task 1: Add `getAgentTasks` and `TaskRecord` type to api-client (AC: #1, #3, #4)
  - [x] 1.1 In `packages/web/src/lib/api-client.ts`, add `TaskRecord` interface matching the backend shape (id, sessionId?, projectId?, skillName, actionName?, prompt, status, priority, result?, durationMs?, errors?, blocked, createdAt, startedAt?, completedAt?)
  - [x] 1.2 Add `getAgentTasks(params?: { status?, skillName?, limit?, offset? }): Promise<TaskRecord[]>` — calls `GET /api/agent-tasks` with query params
  - [x] 1.3 Add `getAgentTask(id: string): Promise<TaskRecord>` — calls `GET /api/agent-tasks/:id`

- [x] Task 2: Create task display helpers (AC: #1, #4)
  - [x] 2.1 Create `packages/web/src/lib/task-helpers.ts` — utility functions for task presentation
  - [x] 2.2 `getTaskStatusColor(status: string): string` — maps status to CSS variable (`completed` → `var(--success)`, `failed` → `var(--error)`, `running` → `var(--warning)`, `queued` → `var(--text-muted)`, `blocked` → `var(--accent)`, `cancelled` → `var(--text-muted)`)
  - [x] 2.3 `getTaskStatusIcon(status: string): string` — maps status to character icon
  - [x] 2.4 `getTaskPriorityLabel(priority: string): string` — returns display label with optional emphasis for `urgent`/`high`
  - [x] 2.5 `formatTaskDuration(ms?: number): string` — formats duration as "1.2s", "45s", "2m 30s", etc.
  - [x] 2.6 `truncatePrompt(prompt: string, maxLen?: number): string` — safely truncates task prompt for card display

- [x] Task 3: Create Kanban Board page (AC: #1, #3)
  - [x] 3.1 Create `packages/web/src/app/tasks/page.tsx` — main Kanban task board page
  - [x] 3.2 Use `usePolling` on `/agent-tasks/active` (3s interval) for live running/queued tasks
  - [x] 3.3 Use `usePolling` on `/agent-tasks?status=completed&limit=20` (10s interval) for recent completed tasks
  - [x] 3.4 Use `usePolling` on `/agent-tasks?status=failed&limit=20` (10s interval) for recent failed tasks
  - [x] 3.5 Render 4 Kanban columns: Queued, Running, Completed, Failed — each with task cards
  - [x] 3.6 Click on a card opens a detail panel (client-side state toggle)
  - [x] 3.7 Loading state: skeleton placeholders per column
  - [x] 3.8 Empty state per column: "No [status] tasks" message

- [x] Task 4: Create TaskCard component (AC: #1, #3, #4)
  - [x] 4.1 Create `packages/web/src/components/tasks/TaskCard.tsx`
  - [x] 4.2 Display: status icon circle, skill name, truncated prompt, priority badge, relative time, duration (if completed)
  - [x] 4.3 Running tasks: show animated running indicator (reuse `pipeline-running` CSS class from globals.css)
  - [x] 4.4 Failed tasks: show error summary (first line of first error) below the prompt
  - [x] 4.5 Clickable — invokes `onSelect(taskId)` callback

- [x] Task 5: Create TaskDetail panel with SSE streaming (AC: #2, #4)
  - [x] 5.1 Create `packages/web/src/components/tasks/TaskDetail.tsx`
  - [x] 5.2 Header: task ID (truncated), skill name, status badge, priority, timestamps (created, started, completed)
  - [x] 5.3 For running tasks: connect `useSSE` to `/agent-tasks/:id/stream` — display streaming output in a scrollable monospace container
  - [x] 5.4 For completed tasks: show the `result` field in a formatted read-only area
  - [x] 5.5 For failed tasks: show `errors` array with each error on its own line, styled with `var(--error)`
  - [x] 5.6 Cancel button for running/queued tasks — calls `api.cancelTask(id)` then refreshes
  - [x] 5.7 Close button to dismiss the detail panel

- [x] Task 6: Add Tasks to Sidebar navigation (AC: #1)
  - [x] 6.1 In `packages/web/src/components/layout/Sidebar.tsx`, add `{ href: '/tasks', label: 'Tasks', icon: '=' }` to the nav array — insert after Pipelines (`|`), before Schedules (`@`)

- [x] Task 7: Tests (AC: #1, #4)
  - [x] 7.1 Add tests to `packages/core/src/__tests__/api.test.ts` (extend existing):
    - Test: `GET /api/agent-tasks` returns paginated task list
    - Test: `GET /api/agent-tasks?status=completed` filters by status
    - Test: `GET /api/agent-tasks/:id` returns single task or 404
  - [x] 7.2 No frontend tests needed — page is a UI composition using tested hooks and backend API. Verify through browser testing.

## Dev Notes

### Architecture Constraints

- **Flat page structure** — `/tasks` is a top-level route, self-contained page (architecture doc: "Each view is top-level")
- **No classes** — all utilities are plain functions
- **usePolling for data refresh** — story 5.1 established this pattern. Use `usePolling` from `packages/web/src/hooks/usePolling.ts`
- **useSSE for streaming** — story 5.1 established this hook. Use `useSSE` from `packages/web/src/hooks/useSSE.ts` for real-time agent output in detail panel
- **CSS variables for theming** — use `var(--bg-card)`, `var(--border)`, `var(--text-muted)`, `var(--success)`, `var(--warning)`, `var(--error)`, `var(--accent)` from `globals.css`. DO NOT use hardcoded colors
- **Tailwind CSS 4** — use utility classes, no custom CSS except reusing existing `pipeline-running` animation for running status
- **No new npm dependencies** — everything needed is already available
- **Character icons, not emoji** — Sidebar uses ASCII characters. Task board icon should be `=`. Status icons in task cards should also use characters.
- **ESLint guardrails** — `max-lines-per-function` (50), `complexity` (10), `no-magic-numbers`. Extract sub-components and use lookup maps (not if-chains) to stay compliant.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Usage |
|---|---|---|
| Agent task API routes | `packages/core/src/api/routes/agent-tasks.ts` | **USE AS-IS** — `GET /api/agent-tasks` (paginated, filterable), `GET /api/agent-tasks/active`, `GET /api/agent-tasks/:id`, `POST /api/agent-tasks/:id/cancel` |
| SSE stream endpoint | `packages/core/src/api/sse/stream.ts` | **USE AS-IS** — `GET /api/agent-tasks/:id/stream` streams `agent-output`, `agent-complete`, `agent-error` events |
| Execution logger | `packages/core/src/agent-manager/execution-logger.ts` | **REFERENCE** — defines `TaskRecord`, `TaskQueryOpts`, `TaskStats` shapes |
| Agent manager | `packages/core/src/agent-manager/agent-manager.ts` | **REFERENCE** — `getActiveTasks()` returns `{ running: ActiveTaskInfo[], queued: ActiveTaskInfo[] }` |
| usePolling hook | `packages/web/src/hooks/usePolling.ts` | **USE** — returns `{ data, loading, error, refresh }` |
| useSSE hook | `packages/web/src/hooks/useSSE.ts` | **USE** — returns `{ connected, lastEvent, close }`. Events: `agent-output` (chunk + messageType), `agent-complete`, `agent-error` |
| api-client.ts | `packages/web/src/lib/api-client.ts` | **EXTEND** — add task query methods + TaskRecord type |
| Processes page | `packages/web/src/app/processes/page.tsx` | **REFERENCE** — existing active tasks table (this Kanban board REPLACES its functionality with richer UX) |
| event-helpers.ts | `packages/web/src/lib/event-helpers.ts` | **IMPORT** — reuse `formatRelativeTime()` for timestamp display |
| pipeline-helpers.ts | `packages/web/src/lib/pipeline-helpers.ts` | **REFERENCE** — follow same lookup-map pattern for task-helpers.ts |
| PipelineDetail.tsx | `packages/web/src/components/pipelines/PipelineDetail.tsx` | **REFERENCE** — design pattern for detail panel overlay |
| Activity page | `packages/web/src/app/activity/page.tsx` | **REFERENCE** — card-based layout with icon circles and polling |
| Sidebar | `packages/web/src/components/layout/Sidebar.tsx` | **MODIFY** — add Tasks nav item |
| globals.css | `packages/web/src/app/globals.css` | **USE** — `pipeline-running` animation for running task indicators |

### API Response Shapes

**`GET /api/agent-tasks/active`** returns:
```typescript
interface ActiveTasks {
  running: ActiveTaskInfo[];  // In-memory, includes computed durationMs
  queued: ActiveTaskInfo[];   // In-memory, ordered by priority
}
interface ActiveTaskInfo {
  taskId: string;
  skillName: string;
  sessionId?: string;
  projectId?: string;
  priority: string;           // 'urgent' | 'high' | 'normal' | 'low'
  status: string;
  startedAt?: number;         // epoch ms
  createdAt: number;          // epoch ms
  durationMs?: number;        // computed elapsed time
}
```

**`GET /api/agent-tasks`** returns `TaskRecord[]` (from DB):
```typescript
interface TaskRecord {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: string;             // 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'
  priority: string;
  result?: string;
  durationMs?: number;
  errors?: string[];          // parsed JSON array
  blocked: boolean;
  createdAt: string;          // ISO 8601
  startedAt?: string;         // ISO 8601
  completedAt?: string;       // ISO 8601
}
```
Query params: `?status=completed&skillName=gmail&limit=20&offset=0`

**SSE stream** (`GET /api/agent-tasks/:id/stream`):
- If task is already completed/failed: returns JSON `{ event, taskId, status }` (NOT SSE)
- If running: streams SSE events:
  - `agent-output` → `{ chunk: string, taskId: string, messageType: 'thinking'|'assistant'|'tool_use'|'result' }`
  - `agent-complete` → `{ taskId: string, status: 'completed'|'failed', result?: string, errors?: string[] }`
  - `agent-error` → error payload

### Kanban Column Data Strategy

**Critical design decision:** Running/Queued columns use `/agent-tasks/active` (in-memory, real-time, 3s poll). Completed/Failed columns use `/agent-tasks?status=X` (DB query, 10s poll). This prevents stale data for active tasks while keeping DB load low for historical data.

- **Queued column:** `data.queued` from `/agent-tasks/active`
- **Running column:** `data.running` from `/agent-tasks/active`
- **Completed column:** `GET /api/agent-tasks?status=completed&limit=20` (most recent 20)
- **Failed column:** `GET /api/agent-tasks?status=failed&limit=20` (most recent 20)

### SSE Streaming in Detail Panel

When the detail panel opens for a **running** task:
1. Connect `useSSE` to `/agent-tasks/${taskId}/stream`
2. Accumulate `agent-output` chunks into a display buffer
3. Auto-scroll to bottom on each new chunk
4. On `agent-complete`, disconnect SSE and refresh the board data
5. Pass `url: null` to `useSSE` when panel is closed (this closes the connection)

When the detail panel opens for a **completed/failed** task:
- Do NOT connect SSE — just display `result` or `errors` from the `TaskRecord`
- Fetch the full task via `getAgentTask(id)` to get the `result` field (not available in `ActiveTaskInfo`)

### Design Pattern Reference

Follow the Activity page pattern (story 5.2):
- Card-based layout with icon circles, status badges, and relative timestamps
- Skeleton loading state on first load
- Empty state with descriptive message per column
- CSS variables from `globals.css` for all colors

**Kanban layout approach:**
- Use CSS `grid` or `flex` layout for columns — `grid-template-columns: repeat(4, 1fr)` for wide screens
- Each column has a header (status name + count badge) and scrollable card list
- Column height: `calc(100vh - header)` with overflow-y auto
- Responsive: on narrow screens, stack columns vertically (use Tailwind responsive classes)

**Color mapping:**
- `queued` → `var(--text-muted)` (#737373)
- `running` → `var(--warning)` (#eab308)
- `completed` → `var(--success)` (#22c55e)
- `failed` → `var(--error)` (#ef4444)
- `blocked` → `var(--accent)` (#6d28d9)
- `cancelled` → `var(--text-muted)` (#737373)

**Priority display:**
- `urgent` → `var(--error)` with bold label
- `high` → `var(--warning)`
- `normal` → `var(--text-muted)` (or omit label)
- `low` → `var(--text-muted)` with dimmed text

### Previous Story Intelligence (5.3)

Key patterns from story 5.3 (Pipeline Monitor) to follow:
- ESLint guardrail rules required extracting sub-components (e.g., PipelineCard → EnabledBadge, LastRunStatus) to stay under `max-lines-per-function` and `complexity` limits
- Magic numbers must be extracted to constants (e.g., `DISABLED_OPACITY = 0.7`, `TASK_ID_DISPLAY_LENGTH = 8`)
- `usePolling` URL changes when state changes → triggers fresh fetch automatically
- `formatRelativeTime()` from `event-helpers.ts` is reusable — import it for timestamps
- Separate helper files keep page files clean and under 300 lines
- Character-based icons in styled circles are the established UI pattern
- Detail panels use client-side state toggle, not separate routes

### Git Intelligence

Recent commits:
- `34e44ca feat: pipeline monitor page with real-time status and run history (story 5.3)` — established pipeline card + detail panel patterns
- `6ff944b feat: polling and SSE infrastructure with hooks (story 5.1)` — established `usePolling`/`useSSE` hooks
- `2ee3e0d feat: activity timeline with rich cards, filters, and review fixes (story 5.2)` — established rich card UI pattern, event helpers
- Commit message pattern: `feat: <description> (story X.Y)`
- ESLint strict compliance required (`npm run check` must pass)
- `.ts` extensions in imports enforced

### NFR Compliance

- **NFR15 (200ms API):** `GET /api/agent-tasks` uses indexed columns (`status`, `created_at`) — fast queries. Active tasks are in-memory.
- **NFR18 (Non-blocking I/O):** All data fetching via async `usePolling` + async Fastify handlers
- **NFR29 (Structured logging):** No logging needed in frontend. Backend routes already have logging.

### Project Structure Notes

- **New files:**
  - `packages/web/src/app/tasks/page.tsx` — Kanban task board page
  - `packages/web/src/lib/task-helpers.ts` — task display utility functions
  - `packages/web/src/components/tasks/TaskCard.tsx` — task card component
  - `packages/web/src/components/tasks/TaskDetail.tsx` — detail panel with SSE streaming
- **Modified files:**
  - `packages/web/src/lib/api-client.ts` — add `TaskRecord` type + task query methods
  - `packages/web/src/components/layout/Sidebar.tsx` — add Tasks nav item
  - `packages/core/src/__tests__/api.test.ts` — add agent task query API tests
- **No changes to:**
  - Backend API routes — all needed endpoints exist (`/api/agent-tasks`, `/api/agent-tasks/active`, `/api/agent-tasks/:id`, `/api/agent-tasks/:id/stream`, `/api/agent-tasks/:id/cancel`)
  - SSE infrastructure — use as-is
  - `usePolling` / `useSSE` hooks — use as-is
  - Database/migrations — no schema changes
  - `globals.css` — reuse existing `pipeline-running` animation

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 5, Story 5.4]
- [Source: _bmad-output/planning-artifacts/prd.md — FR28: Kanban-style board of active and completed agent tasks]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Architecture (usePolling + flat page), SSE streaming, Agent task API]
- [Source: _bmad-output/project-context.md — TypeScript ESM, Fastify patterns, CSS variables, Vitest testing]
- [Source: _bmad-output/implementation-artifacts/5-3-pipeline-monitor.md — usePolling patterns, detail panel, component extraction for ESLint]
- [Source: packages/core/src/api/routes/agent-tasks.ts — 4 existing agent task API endpoints]
- [Source: packages/core/src/api/sse/stream.ts — SSE streaming endpoint for agent tasks]
- [Source: packages/core/src/agent-manager/execution-logger.ts — TaskRecord, TaskQueryOpts, TaskStats interfaces]
- [Source: packages/core/src/agent-manager/agent-manager.ts — getActiveTasks() returns { running, queued }]
- [Source: packages/web/src/hooks/usePolling.ts — Generic polling hook]
- [Source: packages/web/src/hooks/useSSE.ts — EventSource hook with agent-output/complete/error events]
- [Source: packages/web/src/lib/api-client.ts — Existing getActiveTasks(), cancelTask() methods]
- [Source: packages/web/src/lib/event-helpers.ts — formatRelativeTime() and lookup-map patterns]
- [Source: packages/web/src/lib/pipeline-helpers.ts — Helper function pattern with status color/icon maps]
- [Source: packages/web/src/app/processes/page.tsx — Existing active task table (reference for data shape)]
- [Source: packages/web/src/components/layout/Sidebar.tsx — Nav array with character icons]
- [Source: packages/web/src/app/globals.css — CSS variables and pipeline-running animation]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- No issues encountered during implementation.

### Completion Notes List
- Task 1: Added `TaskRecord` interface and `getAgentTasks`/`getAgentTask` methods to api-client.ts
- Task 2: Created task-helpers.ts with status color/icon maps, priority helpers, duration formatting, and prompt truncation
- Task 3: Created Kanban board page at /tasks with 4 columns (Queued, Running, Completed, Failed), usePolling at 3s/10s intervals, skeleton loading, empty states, and detail panel toggle
- Task 4: Created TaskCard component with StatusCircle, PriorityBadge, ErrorSummary, and CardMeta sub-components. Follows ESLint guardrail rules by extracting sub-components
- Task 5: Created TaskDetail panel with SSE streaming for running tasks, result display for completed tasks, error display for failed tasks, and cancel button for running/queued tasks
- Task 6: Added Tasks nav item to Sidebar after Pipelines with icon '='
- Task 7: Added 4 API tests: GET /api/agent-tasks returns paginated list, filters by status, GET /api/agent-tasks/:id returns single task, and 404 for nonexistent task

### File List
- packages/web/src/lib/api-client.ts (modified — added TaskRecord interface, getAgentTasks, getAgentTask methods)
- packages/web/src/lib/task-helpers.ts (new — task display utility functions)
- packages/web/src/app/tasks/page.tsx (new — Kanban task board page)
- packages/web/src/components/tasks/TaskCard.tsx (new — task card component)
- packages/web/src/components/tasks/TaskDetail.tsx (new — detail panel with SSE streaming)
- packages/web/src/components/layout/Sidebar.tsx (modified — added Tasks nav item)
- packages/core/src/__tests__/api.test.ts (modified — added agent task API tests)

### Change Log
- 2026-03-16: Implemented story 5.4 — Kanban Agent Task Board with all 7 tasks complete
- 2026-03-16: Code review fixes — M1: SSE agent-complete now triggers board refresh via onComplete callback; M2: TaskDetail shows error state instead of silently swallowing fetch failures; removed unused initialStatus fallback (also fixes L1: broken SSE for non-existent tasks); extracted useStreamChunks hook to satisfy max-lines-per-function
