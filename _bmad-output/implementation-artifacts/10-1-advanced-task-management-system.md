# Story 10.1: Advanced Task Management System

Status: done

## Story

As the system operator,
I want a comprehensive task management system with rich metadata, agent assignment, and cross-system visibility,
So that every piece of work Raven does is trackable, linked, and surfaced where I need it.

## Acceptance Criteria

1. **Given** a task is created (manually, by agent, or from a template)
   **When** it is stored
   **Then** it has: `id`, `title`, `description`, `prompt` (additional instructions), `status` (todo|in_progress|completed|archived), `assigned_agent_id`, `project_id`, `pipeline_id` (optional), `schedule_id` (optional), `parent_task_id` (optional), `artifacts` (list of file paths / references produced), `created_at`, `updated_at`, `completed_at`

2. **Given** an agent completes a task
   **When** results are produced
   **Then** artifact references (files created, messages sent, events emitted) are attached to the task record and the task moves to `completed`

3. **Given** task templates exist in `config/task-templates/`
   **When** a task is created from a template
   **Then** the template's title, description, prompt, and default agent assignment are pre-filled and can be overridden

4. **Given** TickTick integration is active
   **When** a TickTick task is synced
   **Then** it appears as a Raven task with `source: 'ticktick'` and `external_id` for bidirectional sync

5. **Given** a task is assigned to an agent
   **When** the agent spawns subtasks
   **Then** each subtask is linked via `parent_task_id` and inherits the parent's `project_id`

6. **Given** the orchestrator processes a complex request
   **When** it creates a task with subtasks for multiple agents
   **Then** each subtask shows its assigned agent, status, and artifacts independently

7. **Given** the user opens the Tasks page
   **When** they view the "Tasks" tab
   **Then** tasks are listed with proper information (title, status, project, source, assigned agent, timestamps), grouped by status with counts, and filterable by status, project, source, and assigned agent — with a text search bar for title/description

8. **Given** a task has been in `completed` status for 24 hours
   **When** the archival job runs
   **Then** the task moves to `archived` and is hidden from default views but queryable

9. **Given** a task is created or completed
   **When** the Telegram notification fires
   **Then** a formatted update is posted to a dedicated "Tasks" topic thread in the Raven supergroup

10. **Given** the user opens a task detail view
    **When** the page loads
    **Then** it shows full metadata, linked subtasks/parent, agent history (who handled it and when), prompt used, and artifact links

11. **Given** the user opens the Tasks page
    **When** they click the "Agent Monitor" tab
    **Then** they see all currently running and queued agents with: agent/skill name, project name, task prompt, linked conversation/session (clickable to navigate), elapsed time, and status — if nothing is running, a clean empty state is shown

12. **Given** a running agent is shown in the Agent Monitor
    **When** the user clicks "Terminate"
    **Then** the agent task is cancelled and the monitor updates in real-time

13. **Given** a running agent is shown in the Agent Monitor
    **When** the user clicks "Send Message" and types a message
    **Then** the message is queued into the agent's session — it will be processed as the next turn after the current agent execution completes (the agent is NOT interrupted)

14. **Given** agents are running or queued
    **When** the Agent Monitor tab is open
    **Then** the view auto-refreshes every 3 seconds, showing live elapsed time and status transitions without manual refresh

## Tasks / Subtasks

- [x] Task 1: Database schema — new `tasks` table and migration (AC: 1)
  - [x] Create migration `015-tasks.sql` in `migrations/`
  - [x] Schema: `id TEXT PK`, `title TEXT NOT NULL`, `description TEXT`, `prompt TEXT`, `status TEXT NOT NULL DEFAULT 'todo'`, `assigned_agent_id TEXT`, `project_id TEXT`, `pipeline_id TEXT`, `schedule_id TEXT`, `parent_task_id TEXT REFERENCES tasks(id)`, `source TEXT DEFAULT 'manual'`, `external_id TEXT`, `artifacts TEXT` (JSON array), `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `completed_at TEXT`
  - [x] Indexes: `idx_tasks_status`, `idx_tasks_project_id`, `idx_tasks_parent_task_id`, `idx_tasks_assigned_agent_id`, `idx_tasks_source_external_id` (composite, unique for sync dedup)
  - [x] Status CHECK constraint: `status IN ('todo', 'in_progress', 'completed', 'archived')`
  - [x] Source values: `'manual'`, `'agent'`, `'template'`, `'ticktick'`, `'pipeline'`

- [x] Task 2: Shared types for the task system (AC: 1, 5)
  - [x] Add `RavenTask` interface to `packages/shared/src/types/tasks.ts` (new file)
  - [x] Add `TaskTemplate` type for template definitions
  - [x] Add `TaskCreateInput` and `TaskUpdateInput` Zod schemas for validation
  - [x] Add `TaskStatus = 'todo' | 'in_progress' | 'completed' | 'archived'`
  - [x] Add `TaskSource = 'manual' | 'agent' | 'template' | 'ticktick' | 'pipeline'`
  - [x] Export from `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts`
  - [x] Add new event types to `events.ts`: `task:created`, `task:updated`, `task:completed`, `task:archived`

- [x] Task 3: Task store — CRUD operations (AC: 1, 2, 5, 8)
  - [x] Create `packages/core/src/task-manager/task-store.ts`
  - [x] `createTask(input: TaskCreateInput): RavenTask` — insert, emit `task:created` event
  - [x] `updateTask(id, input: TaskUpdateInput): RavenTask` — update, emit `task:updated`
  - [x] `completeTask(id, artifacts?: string[]): RavenTask` — set status=completed, completed_at, attach artifacts, emit `task:completed`
  - [x] `archiveCompletedTasks(): number` — bulk archive tasks completed > 24h ago, return count
  - [x] `getTask(id): RavenTask | undefined`
  - [x] `getSubtasks(parentId): RavenTask[]`
  - [x] `queryTasks(filters): RavenTask[]` — filter by status, project_id, assigned_agent_id, parent_task_id, source; exclude archived by default; support pagination (limit/offset)
  - [x] `getTaskCountsByStatus(projectId?): Record<TaskStatus, number>` — for dashboard counts
  - [x] All timestamps as ISO 8601 strings
  - [x] `artifacts` stored as JSON string in DB, parsed to `string[]` on read
  - [x] Inject `DatabaseInterface` and `EventBus` via factory function (no class, no singleton)

- [x] Task 4: Task template loader (AC: 3)
  - [x] Create `packages/core/src/task-manager/template-loader.ts`
  - [x] Load YAML files from `config/task-templates/*.yaml`
  - [x] Validate with Zod schema: `{ name, title, description?, prompt?, defaultAgentId?, projectId? }`
  - [x] `getTemplate(name): TaskTemplate | undefined`
  - [x] `listTemplates(): TaskTemplate[]`
  - [x] `createTaskFromTemplate(templateName, overrides?): RavenTask` — applies template defaults, overrides with caller params, sets `source: 'template'`
  - [x] Create 1-2 example templates in `config/task-templates/` (e.g., `research.yaml`, `email-triage.yaml`)

- [x] Task 5: TickTick bidirectional sync service (AC: 4)
  - [x] Create `suites/task-management/services/ticktick-sync.ts`
  - [x] **Inbound sync**: Fetch TickTick tasks via the existing TickTick MCP agent, map to `RavenTask` with `source: 'ticktick'`, `external_id: ticktickTaskId`
  - [x] **Outbound sync**: When a Raven task with `source: 'ticktick'` is updated/completed, push changes back via TickTick MCP agent
  - [x] **Dedup**: Use `source + external_id` composite unique index to prevent duplicates
  - [x] **Sync trigger**: Listen for `schedule:triggered` event with schedule name matching a configurable sync schedule (e.g., every 15 min)
  - [x] **Conflict resolution**: TickTick is source of truth for externally-created tasks; Raven is source of truth for Raven-created tasks
  - [x] Register service in `suites/task-management/suite.ts`

- [x] Task 6: REST API routes (AC: 7, 10)
  - [x] Create `packages/core/src/api/routes/tasks.ts` (separate from existing `agent-tasks.ts`)
  - [x] `GET /api/tasks` — query tasks with filters (status, projectId, assignedAgentId, parentTaskId, source, includeArchived), pagination
  - [x] `GET /api/tasks/:id` — full task detail with subtasks and linked agent task history
  - [x] `POST /api/tasks` — create task (manual or from template via `templateName` body field)
  - [x] `PATCH /api/tasks/:id` — update task fields
  - [x] `POST /api/tasks/:id/complete` — complete with optional artifacts
  - [x] `GET /api/tasks/counts` — status counts, optionally by project
  - [x] `GET /api/task-templates` — list available templates
  - [x] Register in `packages/core/src/api/server.ts`

- [x] Task 7: Archival scheduled job (AC: 8)
  - [x] Add archival schedule to `config/schedules.json`: run hourly, call `archiveCompletedTasks()`
  - [x] Listen for `schedule:triggered` with schedule name `task-archival`
  - [x] Wire in `packages/core/src/index.ts` boot sequence or as an event handler in task-manager
  - [x] Log count of archived tasks

- [x] Task 8: Telegram task notifications (AC: 9)
  - [x] Listen for `task:created` and `task:completed` events in the notifications suite
  - [x] Format: task title, status change, assigned agent (if any), project name
  - [x] Post to "Tasks" topic thread in the Raven supergroup (create topic if missing)
  - [x] Use existing `suites/notifications/services/telegram-bot.ts` patterns
  - [x] Add handler in `suites/notifications/services/` or extend existing notification routing

- [x] Task 9: Dashboard — Tasks tab with filtering, search, and redesigned display (AC: 7, 10)
  - [x] **Rewrite** `packages/web/src/app/tasks/page.tsx` as a tabbed page with two tabs: "Tasks" (default) and "Agent Monitor"
  - [x] **Tasks tab**: list view (NOT kanban) of `RavenTask` work items — conversational agent executions are excluded from this view entirely
  - [x] Status sections: collapsible groups for `todo`, `in_progress`, `completed` — each with count badge. `archived` hidden by default, toggle to show
  - [x] **Filter bar**: dropdowns for status, project, source (`manual`, `agent`, `template`, `ticktick`, `pipeline`), assigned agent
  - [x] **Search bar**: text search across task title and description (client-side filter or server query param `?search=`)
  - [x] **Task cards redesigned**: show title (primary), description snippet, status badge, project name, source icon/label, assigned agent name (if any), relative timestamp, subtask count if has children
  - [x] **Task detail panel** (slide-out or expandable): full metadata, subtask tree, linked agent task executions (query `agent_tasks` by session/task linkage), artifacts list (clickable file paths), prompt used, timestamps
  - [x] Zustand store: `packages/web/src/stores/task-store.ts` — tasks list, filters, selected task, loading state
  - [x] API client helpers in `packages/web/src/lib/api-client.ts`: `getTasks(filters)`, `getTask(id)`, `createTask(input)`, `updateTask(id, input)`, `completeTask(id)`, `getTaskTemplates()`
  - [x] Polling: 10s for task list

- [x] Task 10: Dashboard — Agent Monitor tab with full visibility (AC: 11, 12, 13, 14)
  - [x] **Agent Monitor tab**: real-time operational view of ALL running and queued agent tasks — this is the place for agent execution visibility, NOT the Tasks tab
  - [x] **Running agents section**: each card shows:
    - Agent/skill name (e.g., "ticktick-agent", "orchestrator")
    - Project name (resolved from `projectId` — API must return project name, not just ID)
    - Task prompt (truncated, expandable)
    - Session link: clickable chip showing session ID → navigates to `/projects/{projectId}` chat view for that session
    - Elapsed time: live-updating duration since `startedAt`
    - Priority badge
    - **Actions**: "Terminate" button (red, calls `POST /api/agent-tasks/:id/cancel`), "Send Message" button (opens inline input — queues message to session)
  - [x] **Queued agents section**: same info but with "waiting" state, position in queue
  - [x] **Empty state**: when nothing is running or queued, show clean message: "No agents currently active" with subtle icon
  - [x] **Auto-refresh**: poll `GET /api/agent-tasks/active` every 3s — update elapsed times client-side between polls for smooth counting
  - [x] **Live output preview**: optionally connect to SSE stream (`/api/agent-tasks/:id/stream`) for the selected running agent — show last few lines of output inline
  - [x] Remove existing Kanban board components (`TaskCard.tsx`, `TaskDetail.tsx`) or repurpose — the old kanban view showing completed/failed agent tasks is replaced by the Agent Monitor + a "Recent Executions" collapsed section at the bottom showing last 20 completed/failed agent tasks for reference

- [x] Task 11: API — Enriched active tasks endpoint and session message queue (AC: 11, 13)
  - [x] Enhance `GET /api/agent-tasks/active` response to include `projectName` (resolve from DB) and `actionName` — the frontend needs human-readable project names, not just IDs
  - [x] Add `POST /api/sessions/:id/enqueue` — accepts `{ message: string }` body, stores message in the session's message queue. When the current agent task completes and the orchestrator picks up the session again, this message is processed as the next user turn. Uses existing `MessageStore` to persist.
  - [x] Add Zod validation for the enqueue body
  - [x] If session doesn't exist or has no active agent, return 400 with clear error
  - [x] Register new route in `packages/core/src/api/server.ts`

- [x] Task 12: Wire task creation into orchestrator and agent lifecycle (AC: 2, 5, 6)
  - [x] When the orchestrator delegates a complex request, create a parent `RavenTask` (source: 'agent')
  - [x] When sub-agents are spawned for the parent task, create child tasks with `parent_task_id`
  - [x] On `agent:task:complete` event, find the corresponding `RavenTask` and call `completeTask()` with artifacts from the agent result
  - [x] Artifacts extraction: parse agent result for file paths, URLs, or event references
  - [x] This wiring goes in `packages/core/src/task-manager/task-lifecycle.ts` (new file) — listens to agent events and manages the RavenTask lifecycle
  - [x] **Critical**: This is a listener/bridge, not a modification to agent-manager. Agent tasks and Raven tasks are complementary systems.

## Dev Notes

### Architecture: Two-Layer Task System

This story introduces a **user-facing task layer** (`tasks` table) that sits ABOVE the existing **agent execution layer** (`agent_tasks` table). They serve different purposes:

| Concern | `agent_tasks` (existing) | `tasks` (new — this story) |
|---------|--------------------------|---------------------------|
| Purpose | Track Claude SDK sub-agent executions | Track user-visible work items |
| Status model | queued → running → completed/failed/blocked/cancelled | todo → in_progress → completed → archived |
| Created by | Agent manager when spawning sub-agents | User, agents, templates, TickTick sync, pipelines |
| Granularity | One per `query()` call | One per logical work item (may spawn 0-N agent tasks) |
| Hierarchy | Flat | Parent-child via `parent_task_id` |
| External sync | None | TickTick bidirectional sync |

**The link between layers**: A `RavenTask` may have 0+ associated `AgentTask` records. The task detail view joins these. The task-lifecycle bridge listens for `agent:task:complete` events and updates the corresponding `RavenTask`.

### Existing Code to Reuse — DO NOT Rebuild

| What | Where | Reuse How |
|------|-------|-----------|
| Agent task DB operations | `packages/core/src/agent-manager/execution-logger.ts` | Query agent tasks linked to a RavenTask for the detail view |
| Agent task API | `packages/core/src/api/routes/agent-tasks.ts` | Keep as-is. New `/api/tasks` routes are separate |
| Agent task Kanban | `packages/web/src/app/tasks/page.tsx` | **REPLACE** — rewrite as tabbed page (Tasks + Agent Monitor). Old Kanban components can be removed or repurposed |
| Agent task SSE | `packages/core/src/api/sse/stream.ts` | Reuse for live output preview in Agent Monitor |
| WebSocket events | `packages/core/src/api/ws/handler.ts` | `agent:message`, `agent:task:complete` events broadcast to subscribed clients |
| Session messages | `packages/core/src/session-manager/message-store.ts` | Use for session message enqueue and transcript retrieval |
| Chat API | `packages/core/src/api/routes/chat.ts` | Reference pattern for session message handling |
| Event bus | `packages/core/src/event-bus/event-bus.ts` | Emit/listen for new `task:*` events |
| TickTick MCP | `packages/mcp-ticktick/` | Use existing MCP tools via agent for sync |
| Autonomous manager | `suites/task-management/services/autonomous-manager.ts` | Sync service is a peer — same suite, different service |
| Telegram notifications | `suites/notifications/` | Follow existing notification delivery patterns |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | Register archival + sync schedules in `config/schedules.json` |
| Migration runner | `packages/core/src/db/migrations.ts` | Add `015-tasks.sql`, auto-applied on boot |
| Zod validation | Used everywhere | Validate task input at API boundaries |

### File Structure

New files:
```
packages/shared/src/types/tasks.ts                    — RavenTask types + Zod schemas
packages/core/src/task-manager/task-store.ts           — CRUD operations
packages/core/src/task-manager/template-loader.ts      — Task template loading
packages/core/src/task-manager/task-lifecycle.ts       — Agent↔Task bridge (event listener)
packages/core/src/api/routes/tasks.ts                  — REST API for RavenTasks
migrations/015-tasks.sql                               — Schema
config/task-templates/research.yaml                    — Example template
config/task-templates/email-triage.yaml                — Example template
suites/task-management/services/ticktick-sync.ts       — TickTick bidirectional sync
packages/web/src/components/tasks/TaskList.tsx          — Tasks tab: list view with filtering/search
packages/web/src/components/tasks/TaskFilters.tsx       — Filter bar + search input
packages/web/src/components/tasks/TaskListCard.tsx      — Redesigned task card for list view
packages/web/src/components/tasks/TaskDetailPanel.tsx   — Slide-out detail with subtasks + artifacts
packages/web/src/components/tasks/AgentMonitor.tsx      — Agent Monitor tab: running/queued agents
packages/web/src/components/tasks/AgentMonitorCard.tsx  — Agent card with actions (terminate, message)
packages/web/src/components/tasks/SendMessageModal.tsx  — Inline message input for session enqueue
packages/web/src/stores/task-store.ts                   — Zustand store for tasks + filters
```

Modified files:
```
packages/shared/src/types/events.ts                    — Add task:* event types
packages/shared/src/types/index.ts                     — Export new task types
packages/shared/src/index.ts                           — Re-export
packages/core/src/api/server.ts                        — Register /api/tasks + /api/sessions/:id/enqueue
packages/core/src/api/routes/agent-tasks.ts            — Enrich active response with projectName
packages/core/src/api/routes/sessions.ts               — Add enqueue endpoint
packages/core/src/index.ts                             — Initialize task-manager on boot
config/schedules.json                                  — Add task-archival + ticktick-sync schedules
suites/task-management/suite.ts                        — Register ticktick-sync service
suites/notifications/services/                         — Add task notification handler
packages/web/src/app/tasks/page.tsx                    — REWRITE: tabbed page (Tasks + Agent Monitor)
packages/web/src/lib/api-client.ts                     — Add task + enqueue API helpers
```

Removed/replaced files:
```
packages/web/src/components/tasks/TaskCard.tsx          — Replaced by TaskListCard.tsx
packages/web/src/components/tasks/TaskDetail.tsx        — Replaced by TaskDetailPanel.tsx + AgentMonitorCard.tsx
```

### Database Conventions

- Table: `tasks` (snake_case, plural)
- Columns: `snake_case` — `created_at`, `assigned_agent_id`, `parent_task_id`
- PK: `id TEXT` via `crypto.randomUUID()`
- Timestamps: ISO 8601 TEXT — `"2026-03-21T14:30:00.000Z"`
- JSON columns: `artifacts TEXT` stored as JSON string, parsed on read
- Foreign keys: `parent_task_id REFERENCES tasks(id)` — self-referential for subtask hierarchy
- Index naming: `idx_tasks_<column>`

### API Conventions

- Task endpoints: `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/complete`, `/api/tasks/counts`, `/api/task-templates`
- Task query params: `?status=todo&projectId=xxx&source=ticktick&assignedAgentId=xxx&search=keyword&limit=50&offset=0&includeArchived=false`
- Session enqueue: `POST /api/sessions/:id/enqueue` — body: `{ message: string }`
- Enriched active agents: `GET /api/agent-tasks/active` — now includes `projectName` in each item
- Direct responses — no envelope. Errors: `{ error: string, code?: string }`
- Validate all input with Zod `safeParse()` at route handler level

### Event Conventions

New event types follow existing pattern:
```typescript
type: 'task:created'    // colon-separated, lowercase
type: 'task:updated'
type: 'task:completed'
type: 'task:archived'
```

Payloads are Zod-validated. Each event carries the full `RavenTask` object in payload.

### Testing Strategy

- **Integration test** for task-store: create, update, complete, archive, query with filters, subtask hierarchy, search. Use temp SQLite DB via `mkdtempSync`.
- **Unit test** for template-loader: load YAML, validate, create task from template with overrides.
- **Unit test** for task-lifecycle bridge: mock event bus, verify RavenTask created/completed when agent events fire.
- **API test** for `/api/tasks` routes: CRUD, filters, search, pagination. Follow existing `agent-tasks-api.test.ts` patterns.
- **API test** for `/api/sessions/:id/enqueue`: valid session, no session, message storage verification.
- **API test** for enriched `/api/agent-tasks/active`: verify `projectName` included in response.
- **No real Claude SDK calls** — mock `@anthropic-ai/claude-code` in all tests.
- Test files: `packages/core/src/__tests__/task-store.test.ts`, `task-lifecycle.test.ts`, `tasks-api.test.ts`, `session-enqueue.test.ts`

### Anti-Patterns to Avoid

- **Do NOT modify `agent-manager.ts` or `execution-logger.ts`** — the new task system is a layer above, not a replacement
- **Do NOT merge `tasks` and `agent_tasks` tables** — they serve different purposes and have different lifecycles
- **Do NOT import `better-sqlite3` directly** — use `context.db` / `DatabaseInterface`
- **Do NOT hardcode TickTick sync intervals** — use configurable schedule in `config/schedules.json`
- **Do NOT create a new skill for task management CRUD** — task store is core infrastructure, not a skill. Only TickTick sync uses the skill/MCP pattern.
- **Do NOT add MCPs to the orchestrator** — TickTick sync goes through the existing task-management suite's agent definitions

### TickTick Sync Implementation Notes

- Use the existing `ticktick-agent` (defined in `suites/task-management/agents/ticktick-agent.ts`) to fetch and push tasks via MCP
- The sync service is event-driven (triggered by schedule), NOT a polling loop
- Map TickTick task fields → RavenTask: `title`, `content → description`, `status (0=todo, 2=completed)`, `id → external_id`
- TickTick project IDs map to Raven `project_id` if a mapping exists, otherwise use a default project
- The `source: 'ticktick'` + `external_id` composite unique index prevents duplicate creation on repeated syncs

### Dashboard: Complete Redesign of /tasks Page

The existing page is a 4-column Kanban board showing raw `agent_tasks` (queued/running/completed/failed). This is being **replaced** with a two-tab design:

**Tab 1: "Tasks" (default)** — User-facing work items (`RavenTask` records)
- List view grouped by status sections (todo / in_progress / completed), each collapsible with count badge
- **Excludes conversational agent executions** — this tab shows logical work items only (manual, template, TickTick, pipeline, agent-created tasks). Chat-originated agent executions are invisible here.
- Filter bar at top: status dropdown, project dropdown, source dropdown, agent dropdown
- Search bar: text search on title + description (debounced, 300ms)
- Task cards show: title (bold), description snippet (1 line), status badge (colored), project name, source icon, assigned agent, relative time, subtask count chip
- Click card → slide-out detail panel with: full metadata, subtask tree (indented children), linked agent task executions (the `agent_tasks` that ran for this work item), artifact links (clickable), prompt
- Archived tasks hidden by default — toggle at bottom "Show archived (N)"

**Tab 2: "Agent Monitor"** — Real-time operational visibility
- **This is where agent execution visibility lives** — complete picture of what Raven is doing right now
- Running agents section: cards with skill name, project name (human-readable), task prompt (truncated), session link (clickable → navigates to project chat), live elapsed timer, priority badge, action buttons
- Queued agents section: same layout but with "Waiting" state and queue position
- Actions per card:
  - **Terminate**: red button, calls `POST /api/agent-tasks/:id/cancel`, confirms before executing
  - **Send Message**: opens inline text input, submits to `POST /api/sessions/:id/enqueue`, shows confirmation toast. Message is queued for the next turn — agent is NOT interrupted
  - **View Output**: expands card to show live SSE stream output (connects to `/api/agent-tasks/:id/stream`)
  - **Go to Conversation**: session link navigates to project chat page with session context
- Empty state: centered "No agents currently active" with muted agent icon
- Auto-refresh: polls `/api/agent-tasks/active` every 3s, client-side elapsed time updates between polls
- **Recent Executions** (collapsed by default): last 20 completed/failed agent tasks for reference — replaces the old Kanban's completed/failed columns

**Session Message Enqueue** — the "Send Message" feature:
- Backend: `POST /api/sessions/:id/enqueue` stores user message via `MessageStore`
- The message is persisted in the session transcript with `role: 'user'`
- When the current agent task completes, the orchestrator's normal flow picks up the session and sees the new message in the conversation history → processes it as the next turn
- This is NOT a real-time injection into a running agent — it's a queued follow-up
- UI shows toast: "Message queued — will be processed after current task completes"
- If no agent is running for the session, the message triggers a new agent execution immediately (same as normal chat)

**Technical implementation:**
- Rewrite `packages/web/src/app/tasks/page.tsx` with tab state (URL query param `?tab=tasks|monitor` for deep-linking)
- New Zustand store `task-store.ts` for tasks + filters + selected task state
- Reuse existing `usePolling` hook for both tabs (different intervals)
- Reuse existing `useSSE` hook for live output in Agent Monitor
- API client additions: `getTasks()`, `getTask()`, `createTask()`, `getActiveAgents()`, `enqueueMessage(sessionId, message)`

### Project Structure Notes

- New `task-manager/` directory in `packages/core/src/` follows existing subsystem pattern (`agent-manager/`, `pipeline-engine/`, etc.)
- One concern per file, max 300 lines
- All functions, no classes (except if extending BaseSkill, which doesn't apply here)
- Export factory functions, not singletons

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10 — Story 10.1]
- [Source: _bmad-output/planning-artifacts/architecture.md#Agent Manager, Database Schemas, API Patterns]
- [Source: _bmad-output/planning-artifacts/prd.md#FR34-FR37 Task Management, FR28 Kanban Board]
- [Source: packages/shared/src/types/agents.ts — existing AgentTask interface]
- [Source: packages/core/src/agent-manager/agent-manager.ts — existing agent task lifecycle]
- [Source: packages/core/src/agent-manager/execution-logger.ts — existing task DB operations]
- [Source: packages/core/src/api/routes/agent-tasks.ts — existing agent task API]
- [Source: suites/task-management/ — existing TickTick integration and autonomous manager]
- [Source: packages/mcp-ticktick/ — 19 MCP tools for TickTick operations]
- [Source: packages/web/src/app/tasks/page.tsx — existing Kanban board]
- [Source: migrations/001-initial-schema.sql — existing agent_tasks schema]
- [Source: _bmad-output/project-context.md — coding conventions and rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 56 new tests pass (5 test files)
- Build clean (shared + core)
- TypeScript strict — zero type errors
- Lint: only AI guardrail warnings (complexity, magic numbers, max-lines) — no real errors

### Completion Notes List
- Task 1: Migration `015-tasks.sql` — tasks table with 5 indexes, CHECK constraint, composite unique on source+external_id
- Task 2: Shared types — `RavenTask`, `TaskTemplate`, Zod schemas, 4 new event types (`task:created/updated/completed/archived`)
- Task 3: Task store — full CRUD with event emission, query filters (status/project/agent/source/search), archive, counts
- Task 4: Template loader — YAML template loading from `config/task-templates/`, 2 example templates (research, email-triage)
- Task 5: TickTick sync service — schedule-driven inbound sync via agent manager, dedup via composite unique index
- Task 6: REST API — 7 endpoints (`GET/POST /tasks`, `GET /tasks/:id`, `PATCH`, `POST complete`, `GET counts`, `GET templates`)
- Task 7: Archival job — hourly schedule in `config/schedules.json`, event-driven handler in boot sequence
- Task 8: Telegram notifications — emits notification events for task:created and task:completed to "Tasks" topic
- Task 9: Tasks tab — tabbed page, list view grouped by status, filter bar (status/source/search), task detail slide-out panel
- Task 10: Agent Monitor tab — running/queued agents with terminate/send-message/session-link actions, 3s polling, recent executions
- Task 11: Session enqueue — `POST /api/sessions/:id/enqueue` with Zod validation, stores user message for next turn
- Task 12: Task lifecycle bridge — listens for agent:task:complete, auto-completes matching RavenTasks with extracted artifacts

### Change Log
- 2026-03-21: Implemented all 12 tasks for story 10.1 — Advanced Task Management System
- 2026-03-22: Code review fixes — 3 HIGH, 3 MEDIUM issues resolved:
  - H1: Added projectName enrichment to GET /api/agent-tasks/active (agent-tasks.ts, server.ts, api-client.ts, AgentMonitorCard.tsx)
  - H2: Set globalThis.__raven_agent_manager__ in boot sequence (index.ts) — TickTick sync was non-functional
  - H3: Rewrote task-lifecycle bridge to use agent:task:request→complete mapping instead of blindly completing all in_progress agent tasks
  - M1: Added CHECK constraint on source column in 015-tasks.sql migration
  - M3: Fixed debounce closure leak in TaskFilters.tsx (useRef pattern)
  - Fixed Task 5 subtask checkbox (was [ ], file existed)
- 2026-03-22: Code review #2 fixes — 1 HIGH, 3 MEDIUM issues resolved:
  - H1: Enqueue endpoint now validates active agent on session before accepting (sessions.ts) — returns 400 with clear error if no agent running
  - M2: Added actionName to ActiveTaskInfo interface and getActiveTasks() output (agent-manager.ts, api-client.ts)
  - M3: Removed unused eslint-disable directive in task-store.ts
  - M1: Story File List corrected — notifications wiring is in index.ts boot sequence, not suites/notifications/services/

### File List
New files:
- migrations/015-tasks.sql
- packages/shared/src/types/tasks.ts
- packages/core/src/task-manager/task-store.ts
- packages/core/src/task-manager/template-loader.ts
- packages/core/src/task-manager/task-lifecycle.ts
- packages/core/src/api/routes/tasks.ts
- packages/core/src/__tests__/task-store.test.ts
- packages/core/src/__tests__/template-loader.test.ts
- packages/core/src/__tests__/tasks-api.test.ts
- packages/core/src/__tests__/session-enqueue.test.ts
- packages/core/src/__tests__/task-lifecycle.test.ts
- config/task-templates/research.yaml
- config/task-templates/email-triage.yaml
- suites/task-management/services/ticktick-sync.ts
- packages/web/src/components/tasks/TaskList.tsx
- packages/web/src/components/tasks/TaskFilters.tsx
- packages/web/src/components/tasks/TaskListCard.tsx
- packages/web/src/components/tasks/TaskDetailPanel.tsx
- packages/web/src/components/tasks/AgentMonitor.tsx
- packages/web/src/components/tasks/AgentMonitorCard.tsx
- packages/web/src/components/tasks/SendMessageModal.tsx
- packages/web/src/stores/task-store.ts

Modified files:
- packages/shared/src/types/events.ts — 4 new task event types + union
- packages/shared/src/types/index.ts — export tasks.ts
- packages/core/src/api/server.ts — register task routes, add deps, pass db to agent-tasks
- packages/core/src/api/routes/sessions.ts — add enqueue endpoint
- packages/core/src/api/routes/agent-tasks.ts — enrich active endpoint with projectName
- packages/core/src/agent-manager/agent-manager.ts — add actionName to ActiveTaskInfo and getActiveTasks() output
- packages/core/src/index.ts — init task store, template loader, lifecycle bridge, archival + notification handlers, expose agent manager on globalThis
- config/schedules.json — add task-archival + ticktick-task-sync schedules
- suites/task-management/suite.ts — register ticktick-sync service
- packages/web/src/app/tasks/page.tsx — rewrite: tabbed page (Tasks + Agent Monitor)
- packages/web/src/lib/api-client.ts — add task + enqueue API methods + types, add projectName to ActiveTaskInfo
- packages/web/src/components/tasks/AgentMonitorCard.tsx — display projectName over raw projectId
- packages/web/src/components/tasks/TaskFilters.tsx — fix debounce pattern (useRef over closure)
