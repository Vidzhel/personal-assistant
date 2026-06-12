# Raven Control Center — Design

**Date:** 2026-06-12
**Status:** Approved (design); pending spec review
**Scope:** Raven web dashboard (`packages/web`) + supporting backend slices (`packages/core`) + one independent backend fix (`suites/google-workspace`)
**Supersedes:** the earlier "task-view-and-ui-primitives" draft — the vision grew from "merge two tabs" into a single operations view.

## Goal

Replace the scattered **Tasks**, **Task Tree**, **Schedules**, **Agents**, and **Agent Monitor** surfaces with **one Control Center**: a compact, no-scroll view where you see your agent fleet (who's working, who's idle), a unified task board (everything is a task, by status), the schedules that feed it — and an ops chat through which a system agent can see and control all of it. Plus the supporting fixes: an in-house UI primitives library (consistent cursor/hover/focus), a polymorphic detail sidebar that shows config **and relevant logs**, agent output rendered as markdown, and hardening the Gmail watcher.

## Vision

The Control Center is a single page, top-to-bottom:

```
┌ CONTROL CENTER ──────────────────────────────────────────────┐
│ AGENTS   ● raven(active "digest")  ● builder(active)  ○ +3 …  │  ← rail (active + few idle), search/filter
├──────────────────────────────────────────────────────────────┤
│ EXECUTION PLANS   ▣ Weekly digest 60%   ▣ Onboarding 20%  …   │  ← rail (running by default), search/filter
├──────────────────────────────────────────────────────────────┤
│ SCHEDULES   ● Daily digest [on] next 3h  ○ Weekly [off]  …    │  ← rail (active by default), toggle/run-now/search
├──────────────────────────────────────────────────────────────┤
│ BOARD          TO DO        │ IN PROGRESS         │ DONE       │  ← fills viewport; columns scroll, page does not
│  ┌───────────┐ ┌──────────┐ │ ┌─────────────────┐ │ ┌────────┐ │
│  │● Pay bills│ │● scheduled│ │ │▣ Weekly digest  │ │ │✓ Trip  │ │
│  │ [manual]  │ │ [scheduled]│ │ │ [plan]  ▾ steps │ │ └────────┘ │
│  │ ▸ 2 subs  │ │           │ │ │  • fetch    ✓   │ │            │
│  └───────────┘ └──────────┘ │ │  • summarize ⟳  │ │            │
│                             │ │  • send      ○  │ │            │
│                             │ └─────────────────┘ │            │
└──────────────────────────────────────────────────────────────┘
              (click any card → polymorphic sidebar; chat copilot docked/toggle)
```

The three rails are **overviews + filters**; the **board is the work surface**.

## Glossary (concepts clarified — these confused us, so they're pinned here)

- **Task** — one unit of work: a prompt + status, optionally a flat list of subtasks. Driven by an agent or done manually. Lifecycle: To Do → In Progress → Done (or Blocked). The atom of the board.
- **Execution plan** (*TaskTree*, `task-execution/`) — a structured multi-step plan: typed nodes (agent / code / condition / notify / delay / **approval**) with `blockedBy` dependencies, retries, validation, approval gates; usually built from a Template; driven by the task-execution engine. **Rendered as a grouped task whose subtasks are its steps.**
- **Pipeline** (`pipeline-engine/`, `PipelineConfig`) — an older automation-flow engine: named `nodes` wired by explicit `connections` (with conditions/error paths), triggered by cron/event/webhook/manual. Overlaps heavily with execution plans (parallel v1 vs v2 engines). **Not a first-class section in v1**; pipeline-spawned work shows as `pipeline`-badged tasks. Unifying the two engines is a noted future cleanup.
- **Schedule** — a **recurring task spawner**: "stamp out *this* task on a cron." Each fire creates a fresh task instance that flows To Do → Done; the next fire creates another. The schedule itself = a task template + a cron. No perpetual "schedule card" on the board — you see the spawned instances, badged `scheduled`.
- **Agent** — a named worker (from `projects/agents/<name>/agent.yaml`). **Active** = currently has a running/queued agent task; **idle** otherwise (with "last active").
- **Source badge** — every board card shows where it came from: `manual` / `agent` / `scheduled` / `plan` / `pipeline`.

## Background (verified current state)

| Concept | Endpoint(s) | Today's UI |
|---|---|---|
| RavenTask | `GET /api/tasks`, `/api/tasks/:id`, `PATCH`, `/complete`, `/counts` | "Tasks" tab (list + kanban) + project Tasks tab |
| TaskTree (execution plan) | `GET /api/task-trees`, `/:id`, `/approve`, `/cancel`, step `/approve` | "Task Tree" tab |
| AgentTask | `GET /api/agent-tasks`, `/active`, `/:id`, `/cancel` | "Agent Monitor" sub-tab |
| Schedule | `GET /api/schedules`, `POST` create, `DELETE`, `/:id/trigger` | "Schedules" tab (read-only) |
| Pipeline | `pipeline-engine/`, `/api/pipelines`, `pipeline_runs` | (minimal) |

**Key files:** `app/tasks/page.tsx`, `app/task-trees/page.tsx`, `app/schedules/page.tsx`, `app/agents/*`; `components/tasks/{TaskList,TaskListCard,KanbanBoard,TaskDetailPanel,TaskFilters,SendMessageModal}.tsx`; `components/task-trees/TaskTreeView.tsx`; `components/project/{ProjectTasksTab,project-tab-registry}.tsx`; `components/chat/ChatPanel.tsx` (has `MarkdownBlock` + uses `react-markdown`/`remark-gfm`, already deps); `components/layout/Sidebar.tsx` (nav items); `stores/task-store.ts`; `lib/api-client.ts`; `app/globals.css` (defines `--bg`,`--bg-card`,`--bg-hover`,`--border`,`--text`,`--text-muted`,`--accent`,`--accent-hover`,`--success`,`--warning`,`--error`); shared types `tasks.ts`, `task-execution.ts`, `pipelines.ts`; core `scheduler/scheduler.ts`, `orchestrator/orchestrator.ts` (`handleSchedule`), `api/routes/schedules.ts`, `project-manager/system-access-gate.ts`, `mcp-server/` (Raven in-process MCP, defined but **never wired** into the agent path — confirmed).

**Two confirmed root causes (carried over):**
1. **Transparent sidebar:** `--bg-primary`/`--text-primary`/`--text-secondary` are referenced (~11 places) but never defined in `globals.css` → transparent fallback.
2. **Gmail infinite retry:** `email-watcher.ts` retries every 30s on *any* exit, never distinguishing fatal auth (`invalid_grant`, exit 5) from transient, never alerting; its stdout NDJSON parser logs each line of a multi-line error as a separate warning.

---

## Part 0 — UI primitives library (foundation)

New `packages/web/src/components/ui/`, one concern per file:

| File | Export | Responsibility |
|---|---|---|
| `Button.tsx` | `Button` | variants primary/secondary/ghost/danger, sizes, disabled, loading; always `cursor-pointer` + hover/active/focus-ring |
| `IconButton.tsx` | `IconButton` | icon-only button; `aria-label` required; same affordances |
| `Card.tsx` | `Card` | `--bg-card` surface; `interactive?` adds hover + pointer + focus ring; forwards `onClick` |
| `Badge.tsx` | `Badge`, `statusBadgeProps()`, `sourceBadgeProps()` | status/type/source pills; single source of truth for the color maps duplicated today across TaskListCard, TaskTreeView, schedules |
| `Disclosure.tsx` | `Disclosure` | controlled expand/collapse chevron + body; used by task/plan cards and rails |
| `Markdown.tsx` | `Markdown` | wraps `ReactMarkdown` + `remarkGfm` with the `.markdown-content` style; lifted out of `ChatPanel.tsx` (which then re-imports it) |
| `Rail.tsx` | `Rail` | compact horizontal collapsible strip (title, count, "show all" toggle, search box, horizontally-scrolling item row) — the shared shell for the Agents/Plans/Schedules rails |

**Global CSS (`globals.css`):**
1. Define the missing tokens (`--bg-primary: #141414;`, `--text-primary: #e5e5e5;`, `--text-secondary: #737373;`) — fixes the transparent sidebar and the other 10 references.
2. Baseline affordance: `button, [role="button"], a[href], summary { cursor: pointer; }` and a `not-allowed` rule for disabled.

**Testing:** the web package has no React test harness (out of scope to add). Pure helpers (`statusBadgeProps`, `sourceBadgeProps`) are unit-tested with Vitest; visuals verified by booting the dashboard.

---

## Part 1 — Control Center

**New page:** the Control Center becomes the home view (e.g. `app/page.tsx` or `app/control/page.tsx`), composed of a reusable `<ControlCenter projectId?>` so the same surface can be embedded in a project. Removes the separate **Task Tree**, **Schedules**, and (folded-in) **Agent Monitor** nav entries; **Agents** nav may remain for config/CRUD but its live status now lives here.

**Compactness contract:** the page itself does not scroll. Rails are single-row, collapsible, short. The board fills remaining viewport height; each kanban column scrolls internally. Opening the sidebar/chat overlays, it does not push the board into scroll.

### 1a — Agents rail
Horizontal tiles via `Rail`. Default: all **active** agents + a few idle to fill the row; "show all" expands; search filters by name. Tile: name, status dot (active/idle), current task title (if active) or "last active Xh ago". Click a tile → **filters the board** to that agent's tasks and selects the agent in the sidebar. Data: named-agent roster (filesystem/`/api/agents`) joined with `GET /api/agent-tasks/active` (running + queued) for liveness; live updates via the existing WebSocket if present, else poll.

### 1b — Execution Plans rail
Compact chips via `Rail`. Default: **running** plans; toggle "all"; search by name. Chip: plan name, progress %, step count. Click → filters the board to that plan (its grouped task + steps). Data: `GET /api/task-trees` (filtered to `projectId` client-side when embedded).

### 1c — Schedules rail
Compact chips via `Rail`. Default: **enabled/active** schedules; search/filter. Chip: name, human-readable cron + computed next-run, on/off toggle, "Run now". Click → filters the board to tasks spawned by that schedule. Data: `GET /api/schedules`. Backend additions (see Part 1f).

### 1d — Task board (kanban by status)
Reusable `<TaskBoard projectId? filters?>`. Columns by status: **To Do / In Progress / Done** (+ **Blocked**). Composes sources client-side into one card view-model with a `source` discriminator:
- **manual / agent task** → card; expand (`Disclosure`) → flat subtasks. Draggable between columns (existing `PATCH /api/tasks/:id` status update).
- **scheduled task** → a normal task card badged `scheduled`; one card per fire.
- **execution plan** → a **grouped parent task** placed in the column matching the plan's status; expand → its **steps as subtasks** (reusing the `TaskTreeView` step renderer restyled onto `Card`/`Badge`), each step showing its own status. Steps reflect real engine status (a step In Progress while others wait); the group moves to Done when the run completes; the next run spawns a fresh group. **Plan cards/steps are not manually draggable** (status is engine-driven); approval gates surface an Approve `Button` on the relevant step.
- **pipeline-spawned task** → card badged `pipeline` (no dedicated section in v1).

Filters/search (from the rails and a board search box) narrow the board by agent, plan, schedule, source, status, or text. The current Kanban drag for manual tasks is preserved; the flat "list" toggle is dropped in favor of this board.

### 1e — Polymorphic detail sidebar
`components/control/DetailPanel.tsx` accepts a discriminated `DetailItem`:
- `{ kind: 'task', data }` — description, prompt (`<Markdown>`), metadata, subtasks, artifacts
- `{ kind: 'plan', data }` — progress, step graph (read-only), per-step summaries, approve/cancel
- `{ kind: 'step', data }` — type/status, dependencies, agent, summary/errors (`<Markdown>`), validation gates, artifacts
- `{ kind: 'schedule', data }` — cron config, timezone, next-run, on/off, run-now, recent runs
- `{ kind: 'agent', data }` — status, current task, recent sessions, link to chat

Every panel has a **Logs** section that calls the existing `GET /api/logs` filtered to the item's task id / session / agent (read-only tail). Agent output is rendered with `<Markdown>`. Built on Part 0 primitives. The transparent-background bug is resolved by the Part 0 tokens.

### 1f — Schedule backend slice (small)
- **Run-history link:** the `schedule:triggered` event already carries `scheduleId`, but the orchestrator drops it and `agent_tasks` has no `schedule_id` column. Add the column (migration), thread `scheduleId` from `handleSchedule()` into the `agent:task:request` payload and onto the created agent task, and expose `GET /api/agent-tasks?scheduleId=` (and/or surface on RavenTasks via the existing `tasks.schedule_id`). Enables a schedule's "recent runs" and the `scheduled` badge.
- **Pause/resume:** add `Scheduler.setEnabled(id, enabled)` (updates the DB row and registers/stops the Cron job at runtime — today only boot loads `enabled=1`, and only `add`/`remove` exist) + `PATCH /api/schedules/:id { enabled }`. Toggling DB `enabled` is runtime state and is **not** overwritten on boot (`initialize` only inserts when missing) — consistent with the filesystem-defines / DB-runtime philosophy.
- **Run-now:** existing `POST /api/schedules/:id/trigger`.
- **Next-run:** computed from the cron (croner `nextRun()` for enabled; computed for disabled).
- **Out of scope:** a from-scratch schedule *author* in the UI (define in YAML, or via the Part 2 chat).

---

## Part 2 — System copilot (chat + control tools)

Dock the existing `ChatPanel` in the Control Center (toggle/side panel), pointed at the **"Raven System" meta agent** (the `meta` project already has `system_access: read-write`). Finally **wire the Raven in-process MCP** (defined in `mcp-server/` but never attached to the agent path) and give the meta agent read/control tools:

- **Read:** list/query tasks (by status/agent/source/schedule), list execution plans + status, list schedules + next-run, list agents + live status, read logs.
- **Control:** create a task, trigger/pause/resume a schedule, approve/cancel a plan or step, send a message to / focus an agent.

All control tools route through the existing **permission/system-access gate** (`system-access-gate.ts`, `permission-engine/`) so destructive actions respect approvals/audit. This makes the view operable conversationally ("show today's failures", "pause the digest", "what's raven doing", "make a recurring task that …"). This is its own backend-heavy slice.

---

## Part 3 — Gmail watcher hardening (independent)

`suites/google-workspace/services/email-watcher.ts`:
1. **Classify exit/error** — pure `classifyWatcherExit({ code, stderrTail }): 'fatal-auth' | 'transient'`; fatal when `code === 5` or stderr matches `/invalid_grant|Failed to get Gmail token/i`. Unit-tested.
2. **Fatal-auth** → stop the loop, log one `ERROR` with re-auth steps (`gws auth login` → re-export creds), emit a notification alert (once).
3. **Transient** → exponential backoff (30s → 60s → 120s, capped; reset on a successful run) instead of flat-forever.
4. **NDJSON noise** → accumulate a `{`-leading line that fails to parse into a pending buffer and try the joined buffer; emit at most one `warn`/`debug`, not per-line spam.

Out of scope: the actual re-auth (interactive, user-run).

---

## Data sources / composition

The board and rails are a **presentation-layer composition** of existing endpoints (`/api/tasks`, `/api/task-trees`, `/api/schedules`, `/api/agents`, `/api/agent-tasks/active`, `/api/logs`) into common view-models with a `source` discriminator — no DB-level merge of the task/tree/pipeline models. The only backend changes are the small schedule slice (1f), the system-agent tools (Part 2), and the gmail fix (Part 3).

## Decomposition — four independently-shippable plans

- **Plan 0 — UI primitives + global token/cursor fix.** Foundation; independently fixes the transparent sidebar. Ships first.
- **Plan 1 — Control Center.** Rails (agents/plans/schedules) + kanban board (source badges, plan-as-grouped-task-with-steps, filter/search, compact no-scroll) + polymorphic sidebar (detail/config/logs) + schedule backend slice (1f). Depends on Plan 0.
- **Plan 2 — System copilot.** Wire Raven MCP to the meta agent with read/control tools (through the permission gate) + dock the chat. Depends on Plan 1's endpoints.
- **Plan 3 — Gmail watcher hardening.** Fully independent; ships anytime.

Build order: 0 → 1 → 2; 3 in parallel.

## Non-goals (YAGNI)

- No dedicated **Pipelines** section (badge only); no unifying the pipeline and execution-plan engines (future cleanup).
- No plan/pipeline **authoring/editing** UI (read-only step view).
- No from-scratch **schedule author** in the UI (YAML or chat).
- No **hard agent controls** (kill/pause an agent process) in v1 — visibility + drill-in + send-message only.
- No external component library (shadcn/Radix); in-house primitives.
- No new React test harness; logic extracted to pure helpers for Vitest, visuals verified by smoke.

## Conventions / constraints

- TypeScript strict ESM, `.ts`/`.tsx`; `.tsx` exempt from `explicit-function-return-type`, `.ts` helpers are not; `consistent-type-imports`; `no-console` (core/suites use `createLogger`).
- `npm run check` must pass; baseline pre-existing failures (knowledge-*, config-history, template-integration, template-scheduler) excluded.
- No chained shell commands; keep files focused (<~300 lines), one concern per file.

## Risks

- **Compactness vs. density:** three rails + a 3–4 column board must fit one viewport. Mitigation: rails are single-row/collapsible with "show all"; board columns scroll internally; verify by smoke at common resolutions.
- **Plan status → column mapping:** plan/step status vocab (pending-approval, validating, failed, skipped) is richer than To Do/In Progress/Done. Mitigation: an explicit mapping table in the board view-model, unit-tested.
- **Composition cost:** merging 3+ sources + logs client-side. Mitigation: reuse existing polling intervals; lazy-load logs only when the sidebar opens.
- **Powerful control tools:** the meta agent gains write access to tasks/schedules/agents. Mitigation: route every mutation through the existing system-access/permission gate with audit; default destructive actions to approval-gated.
- **Removing routes:** `/task-trees`, `/schedules` removed. Mitigation: thin redirects to the Control Center.
