# Task View & UI Primitives Overhaul — Design

**Date:** 2026-06-12
**Status:** Approved (design); pending spec review
**Scope:** Raven web dashboard (`packages/web`) + one backend hardening change (`suites/google-workspace`)

## Goal

Replace the separate "Tasks" and "Task Tree" tabs with **one reusable task view** — cards with expandable, grouped subcards, on a single screen — that is also embedded in the per-project view. Along the way: introduce a small in-house UI primitives library so clickable elements get consistent cursor/hover/focus affordances, render agent output as markdown, make the task detail sidebar work for any item type, and fix its transparent background. Separately, harden the Gmail watcher so an expired OAuth token stops the silent infinite retry loop and surfaces a clear alert.

## Background (current state, verified)

**Three distinct task concepts exist today:**

| Concept | Endpoint | Shown in | Shape |
|---|---|---|---|
| **RavenTask** | `GET /api/tasks` | "Tasks" tab (`app/tasks/page.tsx`), project Tasks tab | work item; `status`, `source`, optional subtasks |
| **ExecutionTask** (in a **TaskTree**) | `GET /api/task-trees`, `/api/task-trees/:id` | "Task Tree" tab (`app/task-trees/page.tsx`) | execution plan; nodes with `blockedBy` deps, retries, approval gates, progress |
| **AgentTask** | `GET /api/agent-tasks` | "Agent Monitor" sub-tab | live skill execution; sessionId, skillName, durationMs |

**Key files (verified):**
- Tasks page: `packages/web/src/app/tasks/page.tsx` (list/kanban toggle + Agent Monitor sub-tab)
- Task Tree page: `packages/web/src/app/task-trees/page.tsx` + `components/task-trees/TaskTreeView.tsx`
- Task cards/list: `components/tasks/TaskList.tsx`, `TaskListCard.tsx`, `KanbanBoard.tsx`, `TaskFilters.tsx`
- Detail sidebar: `components/tasks/TaskDetailPanel.tsx` (line 39 uses `var(--bg-primary)`)
- Project tab: `components/project/ProjectTasksTab.tsx` (currently `<KanbanBoard projectId={...}/>`), registered in `components/project/project-tab-registry.ts`
- Task store: `stores/task-store.ts`; API client types: `lib/api-client.ts`
- Theme tokens: `app/globals.css` (defines `--bg`, `--bg-card`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-hover`, `--success`, `--warning`, `--error`)
- Shared types: `packages/shared/src/types/tasks.ts`, `packages/shared/src/types/task-execution.ts`
- Gmail watcher: `suites/google-workspace/services/email-watcher.ts`

**Two confirmed root causes:**
1. **Transparent sidebar:** `--bg-primary`, `--text-primary`, `--text-secondary` are referenced in ~11 places (TaskDetailPanel, TaskFilters, SendMessageModal, tab styling) but **never defined** in `globals.css`. The browser falls back to transparent / inherited color.
2. **Gmail infinite retry:** `email-watcher.ts` reconnects every 30s on *any* exit code, never distinguishing a fatal auth failure (exit 5, `invalid_grant`) from a transient drop, and never alerting the user. Its stdout NDJSON parser also logs each line of gws's multi-line error JSON as a separate "Failed to parse NDJSON line" warning.

**Pre-existing assets to reuse (not rebuild):**
- `react-markdown@^10` and `remark-gfm@^4` are already dependencies.
- A `MarkdownBlock` component already exists inside `components/chat/ChatPanel.tsx:166` and a `.markdown-content` CSS class already exists in `globals.css`. The new `<Markdown>` primitive **lifts and generalizes this**, then ChatPanel re-imports it.

## Non-goals (YAGNI)

- **Agent Monitor** tab (live AgentTasks) stays as-is — not folded into the merge.
- **Kanban** toggle is retained for the Tasks group; it is not the focus and is not extended to plans.
- No external component library (shadcn/Radix). In-house primitives match the existing Tailwind-v4 + CSS-token + inline-style conventions and avoid a large migration.
- No change to task/tree data models or API endpoints. The view composes existing endpoints client-side.
- The RavenTask↔TaskTree linkage is **not** required (we chose grouped sections, not "parent owns its plan"), so no schema work.

---

## Part A — UI primitives library

**New directory:** `packages/web/src/components/ui/`

One focused file per primitive (each well under the 300-line guideline):

| File | Export | Responsibility |
|---|---|---|
| `Button.tsx` | `Button` | variants `primary`/`secondary`/`ghost`/`danger`, sizes `sm`/`md`, `disabled`, `loading`; always `cursor-pointer` + hover/active/focus-ring; renders `<button>` |
| `IconButton.tsx` | `IconButton` | square icon-only button (close, approve, cancel); same affordances; `aria-label` required |
| `Card.tsx` | `Card` | `--bg-card` surface, `--border`, `rounded-lg`; `interactive?: boolean` adds hover bg + `cursor-pointer` + focus ring; forwards `onClick` |
| `Badge.tsx` | `Badge`, `statusBadgeProps()` | status/type pill; a single source of truth for the color maps currently duplicated across TaskListCard, TaskTreeView, task-trees/page |
| `Disclosure.tsx` | `Disclosure` | controlled expand/collapse: chevron header + body; used by task cards for inline subcards |
| `Markdown.tsx` | `Markdown` | wraps `ReactMarkdown` + `remarkGfm` with `.markdown-content` styling; the canonical "markdown text box" |

**Global CSS changes** (`globals.css`):
1. Add the missing tokens so existing references resolve:
   ```css
   --bg-primary: #141414;   /* = --bg-card */
   --text-primary: #e5e5e5; /* = --text */
   --text-secondary: #737373; /* = --text-muted */
   ```
   This single change fixes the transparent sidebar and the other 10 references.
2. Add a baseline affordance so even un-migrated controls get a pointer immediately:
   ```css
   button, [role="button"], a[href], summary { cursor: pointer; }
   button:disabled, [role="button"][aria-disabled="true"] { cursor: not-allowed; }
   ```

**Design intent:** primitives are presentational and dependency-light. `Button`/`IconButton`/`Card`/`Badge` take no app types. `Markdown` takes `{ content: string }`. `Disclosure` takes `{ open, onToggle, header, children }` (controlled — the parent owns expansion state so a list can collapse-others if desired).

**Testing:** the web package currently has no React test harness. Adding one is out of scope; primitives are verified by type-check, lint, and visual smoke (boot the dashboard). The one piece of *logic* worth a pure unit test — `statusBadgeProps()` mapping a status string to `{label,color}` — is extracted as a plain function and unit-tested with Vitest (no DOM needed).

---

## Part B — Unified task view

**New component:** `packages/web/src/components/tasks/TaskView.tsx`, exporting `<TaskView projectId?: string />`.

**Data:** composes two existing sources client-side:
- RavenTasks via the existing `useTaskStore()` (`/api/tasks`, optionally `?projectId=`)
- TaskTrees via `/api/task-trees` (filtered to `projectId` client-side when provided; trees carry a projectId)

**Layout (grouped sections, one scroll):**
- **Group "Tasks"** — RavenTasks as top-level `TaskCard`s. A card with subtasks shows a `Disclosure` chevron; expanding renders its subtasks as indented subcards.
- **Group "Execution Plans"** — TaskTrees as top-level `TaskCard`s with a progress bar; expanding renders the tree's execution steps (reusing the existing `TaskTreeView` step rendering, restyled onto `Card`/`Badge`).
- Each group renders an empty-state line when it has no items, and the whole view shows a single empty state when both are empty.

**New supporting component:** `components/tasks/TaskCard.tsx` — built on `Card` + `Badge` + `Disclosure`. Props: `{ title, statusBadge, metaRow, progress?, expandable?, expanded?, onToggle?, onOpen }`. Card body click → `onOpen` (sidebar); chevron click → `onToggle` (inline expand). Replaces the bespoke `TaskListCard` styling (TaskListCard is refactored to delegate to `TaskCard`, or removed if fully subsumed).

**Wiring:**
- `app/tasks/page.tsx`: the "Tasks" tab content becomes `<TaskView />`. The list/kanban toggle is preserved — "list" mode now means `<TaskView />` (grouped expandable cards); "kanban" stays `<KanbanBoard />` (RavenTasks only). The separate top-level "Task Tree" tab is **removed**; plans now live in the Execution Plans group of `<TaskView />`. The "Agent Monitor" sub-tab is unchanged.
- `app/task-trees/page.tsx`: removed (or left as a thin redirect to `/tasks`). Navigation entry for "Task Tree" removed from the sidebar.
- `components/project/ProjectTasksTab.tsx`: becomes `<TaskView projectId={projectId} />`.

**Approval actions** (approve/cancel a tree or an approval-gated step) move onto the cards via `Button`/`IconButton`, calling the same existing endpoints (`/api/task-trees/:id/approve`, `/cancel`, `/tasks/:taskId/approve`).

**Polling:** reuse existing intervals (tasks 10s via store, trees 5s) inside `TaskView`.

**Testing:** the grouping/empty-state/expansion decisions are extracted into a pure helper (e.g. `buildTaskGroups(tasks, trees)`) and unit-tested with Vitest. Rendering is verified by visual smoke.

---

## Part C — Polymorphic detail sidebar

**Generalize** `TaskDetailPanel.tsx` → `components/tasks/DetailPanel.tsx` accepting a discriminated `DetailItem`:
- `{ kind: 'task', data: RavenTaskDetail }`
- `{ kind: 'tree', data: TaskTreeDetail }`
- `{ kind: 'step', data: ExecutionTaskRecord }`

It renders the common header (status `Badge`, title, `IconButton` close) and a `kind`-specific body:
- **task** → description, prompt (in `<Markdown>`), metadata rows, subtasks, artifacts
- **tree** → progress, status, per-step summary list, approve/cancel
- **step** → type/status, dependencies, agent, summary/errors (in `<Markdown>`), validation gates, artifacts

**Agent output** (prompts, results, step summaries, errors) is rendered with the `<Markdown>` primitive. The panel is built on `Card`/`Button`/`Badge`/`Markdown`. The transparent-background bug is resolved by the Part A token definitions (the panel keeps `background: var(--bg-primary)`, which now resolves to `#141414`).

`TaskView` owns the selected-item state and passes the right `DetailItem` to `DetailPanel`.

---

## Part D — Gmail watcher hardening (independent)

**File:** `suites/google-workspace/services/email-watcher.ts`. **This plan ships independently of the UI work.**

1. **Classify exit/error.** Extract a pure function `classifyWatcherExit({ code, stderrTail }): 'fatal-auth' | 'transient'`. Fatal when `code === 5` or `stderrTail` matches `/invalid_grant|Failed to get Gmail token/i`. Unit-test this function (the one high-value test here).
2. **On fatal-auth:** stop the loop (`running = false`, clear timer), log one `ERROR` with re-auth instructions (`gws auth login` → re-export creds), and emit a notification event (existing event bus / notification queue) so the user is alerted once.
3. **On transient:** retry with exponential backoff (e.g. 30s → 60s → 120s, capped at a max, reset on a successful run) instead of a flat 30s forever.
4. **NDJSON noise:** when a stdout line starts with `{`/whitespace but fails to parse, accumulate into a pending buffer and try to parse the joined buffer; only emit a single `debug`/`warn` if the buffer fails to resolve within a small bound. Net effect: no more per-line "Failed to parse NDJSON line" spam for a multi-line JSON error.

**Out of scope:** the actual re-auth (interactive, run by the user). The code change's job is to stop failing silently and tell the user clearly.

---

## Build order & decomposition

Two implementation plans, each independently shippable and testable:

**Plan 1 — UI (Parts A → B → C, in that order):**
1. Part A primitives + global token/cursor fixes (also fixes the sidebar transparency on its own).
2. Part B `TaskView` + `TaskCard` + page/project wiring; remove the Task Tree tab.
3. Part C `DetailPanel` polymorphism + markdown output.

**Plan 2 — Gmail watcher hardening (Part D):** fully independent of Plan 1.

## Conventions / constraints

- TypeScript strict ESM, `.ts`/`.tsx`; `.tsx` files are exempt from `explicit-function-return-type` but `.ts` helpers are not.
- `no-console` (use `createLogger` in core/suites; web uses none).
- `npm run check` (format + lint + type-check) must pass; pre-existing unrelated failures (knowledge-*, config-history, template-integration, template-scheduler) are the baseline.
- No chained shell commands.
- Keep files focused and under ~300 lines; one concern per file.

## Risks

- **Token remap visual shift:** defining `--bg-primary`/`--text-*` changes 11 call sites at once. Mitigation: values are chosen to equal the tokens those sites visually expected (`--bg-card`/`--text`/`--text-muted`), so the change is corrective, not cosmetic-breaking. Verify by visual smoke after Part A.
- **TaskTreeView reuse:** the existing step renderer carries its own color maps; folding it into `Badge` must preserve current status semantics. Mitigation: `statusBadgeProps()` is seeded directly from the existing maps.
- **Removing the Task Tree route:** anything linking to `/task-trees` breaks. Mitigation: leave a thin redirect to `/tasks`.
