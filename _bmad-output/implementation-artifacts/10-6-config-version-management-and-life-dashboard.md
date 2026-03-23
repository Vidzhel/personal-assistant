# Story 10.6: Config Version Management & Life Dashboard

Status: done

## Story

As the system operator,
I want to view and revert git-committed config changes and see a unified life dashboard,
so that I have full control over system configuration and complete visibility into all activity.

## Acceptance Criteria

1. **Given** 5 config changes have been git-committed **When** the user views config history **Then** each change shows timestamp, description, and diff preview
2. **Given** the user wants to revert a specific permissions.json change **When** they select revert on that commit **Then** a git revert is executed for that file, the config reloads, and the change is confirmed
3. **Given** the user opens the life dashboard homepage **When** the page loads **Then** it shows: today's autonomous actions count, active pipelines status, pending approvals count, latest insights, system health, and upcoming events
4. **Given** any dashboard section has actionable items **When** the user clicks through **Then** they navigate to the relevant detailed page (activity, pipelines, permissions, etc.)

## Tasks / Subtasks

### Part A: Config Version History Backend

- [x] Task 1 (AC: #1, #2) — Git history service
  - [x] 1.1 Create `packages/core/src/config-history/git-history.ts` — functions to query git log for config files (`config/` directory) using `execFile` wrapper. Returns `ConfigCommit[]` with hash, timestamp, message, author, affected files
  - [x] 1.2 Add `getCommitDiff(hash)` function — retrieves unified diff for a specific commit using `git show`
  - [x] 1.3 Add `revertConfigFile(hash, filePath)` function — performs file-level revert using `git checkout <hash>~1 -- <file>` + `git add` + `git commit`. Returns new commit hash
  - [x] 1.4 Add config reload hook — after revert, emit `config:reloaded` event on event bus so live config picks up changes

- [x] Task 2 (AC: #1, #2) — Config history API routes
  - [x] 2.1 Create `packages/core/src/api/routes/config-history.ts` with `registerConfigHistoryRoutes()`
  - [x] 2.2 `GET /api/config-history` — query params: `limit` (default 20), `offset` (default 0). Returns paginated `ConfigCommit[]` from git log of `config/` directory
  - [x] 2.3 `GET /api/config-history/:hash` — returns `ConfigCommitDetail` with full diffs per file
  - [x] 2.4 `POST /api/config-history/:hash/revert` — body: `{ file?: string }`. Reverts the commit (or specific file). Returns `{ success, message, revertHash, reloadedConfigs[] }`
  - [x] 2.5 Register routes in `packages/core/src/api/server.ts`

### Part B: Config History Frontend

- [x] Task 3 (AC: #1, #2) — Config history page
  - [x] 3.1 Create `packages/web/src/app/config-history/page.tsx` — paginated list of git commits affecting `config/` files. Each row: timestamp, commit message, affected files, expand button for diff preview
  - [x] 3.2 Add diff viewer component — shows unified diff with syntax highlighting (green/red lines, monospace). Keep it simple — `<pre>` with colored spans, no external diff library needed
  - [x] 3.3 Add revert button per commit — confirmation dialog, calls `POST /api/config-history/:hash/revert`, shows success/error toast
  - [x] 3.4 Add "Config History" link to sidebar navigation in `Sidebar.tsx`

### Part C: Life Dashboard Backend

- [x] Task 4 (AC: #3) — Dashboard aggregation endpoint
  - [x] 4.1 Create `packages/core/src/api/routes/dashboard.ts` with `registerDashboardRoutes()`
  - [x] 4.2 `GET /api/dashboard/life` — aggregates data from existing sources:
    - `autonomousActionsCount`: count of `agent_tasks` completed today (from `agent_tasks` table where `completed_at >= today midnight`)
    - `activePipelines`: count + list from scheduler's active jobs (`deps.scheduler`)
    - `pendingApprovalsCount`: count from `pending_approvals` where `resolution IS NULL`
    - `latestInsights`: last 5 from `insights` table ordered by `created_at DESC`
    - `systemHealth`: from health endpoint data (status, uptime, agents running, queue)
    - `upcomingEvents`: next 5 scheduled runs from scheduler + next scheduled pipelines
  - [x] 4.3 Register route in `packages/core/src/api/server.ts`

### Part D: Life Dashboard Frontend

- [x] Task 5 (AC: #3, #4) — Redesign dashboard homepage
  - [x] 5.1 Redesign `packages/web/src/app/page.tsx` as the life dashboard. Replace current "Quick Actions" card with life dashboard sections. Keep existing StatusCards and ActivityFeed
  - [x] 5.2 Add summary cards row: "Actions Today" (count, links to `/activity`), "Active Pipelines" (count, links to `/pipelines`), "Pending Approvals" (count, links to `/settings` approvals tab), "System Health" (status badge)
  - [x] 5.3 Add "Latest Insights" section — shows last 5 insights with type icon, title, truncated content. Links to `/knowledge`
  - [x] 5.4 Add "Upcoming Events" section — next 5 scheduled runs with name, time, type. Links to `/schedules`
  - [x] 5.5 All dashboard sections must be clickable and navigate to relevant detail pages using Next.js `Link`

### Part E: Testing

- [x] Task 6 (AC: #1-4) — Tests
  - [x] 6.1 `packages/core/src/__tests__/config-history.test.ts` — test git history service functions (mock `execFile`): list commits, get diff, revert file, config reload event emission
  - [x] 6.2 `packages/core/src/__tests__/dashboard-api.test.ts` — test `/api/dashboard/life` aggregation: mock DB queries, verify response shape, verify counts
  - [x] 6.3 Test config history API routes: GET list, GET detail, POST revert (mock git operations)

## Dev Notes

### Architecture Compliance

- **No new migration needed** — config history is git-based, not DB-stored. Query git directly via `execFile`
- **Use existing `execFile` pattern** from `packages/shared/src/utils/git-commit.ts` — but for read operations, use promisified `execFile` that captures stdout. The existing `gitAutoCommit` is fire-and-forget; the new git history functions need to return results
- **NFR25 applies**: git operations are non-blocking, failure-tolerant. Config change applies even if git commit fails
- **NFR15 applies**: API endpoints respond within 200ms for non-agent operations. Git log queries should be fast for the `config/` directory (small number of files)
- **NFR28 applies**: Config changes take effect without full restart. Revert → reload via event bus

### Git Operations — Implementation Detail

Create a new utility at `packages/core/src/config-history/git-history.ts` (not in shared — these are core-only operations):

```typescript
// Promisified execFile wrapper that captures stdout
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

// List config commits
export async function getConfigCommits(limit: number, offset: number): Promise<ConfigCommit[]> {
  // git log --pretty=format:'%H|%aI|%an|%s' --skip=<offset> -<limit> -- config/
  // Parse each line into { hash, timestamp, author, message }
  // Then for each commit: git diff-tree --no-commit-id --name-only -r <hash> -- config/
  // to get affected files
}

// Get commit detail with diffs
export async function getCommitDetail(hash: string): Promise<ConfigCommitDetail> {
  // git show <hash> -- config/  (unified diff output)
  // Parse into per-file diffs
}

// Revert a specific file from a commit
export async function revertConfigFile(hash: string, filePath?: string): Promise<RevertResult> {
  // If filePath specified: git show <hash>~1:<filePath> > <filePath> (restore previous version)
  // git add <filePath>
  // git commit -m "revert: <filePath> from commit <short-hash>"
  // If no filePath: git revert --no-edit <hash>
}
```

**CRITICAL**: Validate `hash` is a valid git SHA (hex, 7-40 chars) and `filePath` starts with `config/` before executing. Prevent path traversal.

### Existing Code to Reuse

| What | Where | How |
|------|-------|-----|
| `gitAutoCommit()` | `packages/shared/src/utils/git-commit.ts` | Pattern reference for execFile usage. Don't reuse directly — need stdout capture |
| `StatusCards` | `packages/web/src/components/dashboard/StatusCards.tsx` | Keep in life dashboard, add new summary cards alongside |
| `ActivityFeed` | `packages/web/src/components/dashboard/ActivityFeed.tsx` | Keep in life dashboard layout |
| `usePolling` hook | `packages/web/src/hooks/usePolling.ts` | Use for `/api/dashboard/life` polling (30s interval) |
| Health endpoint | `packages/core/src/api/routes/health.ts` | System health data — call internally for dashboard aggregation, don't duplicate logic |
| Config changes API | `packages/core/src/api/routes/config-changes.ts` | Existing pending changes management. Config history is separate (git-based), not the same as pending changes |
| Pending approvals | `packages/core/src/permission-engine/pending-approvals.ts` | Query `getPendingCount()` for dashboard |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | Query `getActiveJobCount()` and next run times for upcoming events |
| Sidebar | `packages/web/src/components/layout/Sidebar.tsx` | Add `{ href: '/config-history', label: 'Config', icon: '{' }` to nav array |
| Event bus | `packages/core/src/event-bus/event-bus.ts` | Emit `config:reloaded` after revert |

### Existing Dashboard Homepage (packages/web/src/app/page.tsx)

The current dashboard has:
- `StatusCards` (health, skills, projects, agents, queue, schedules) — **keep**
- `ActivityFeed` (WebSocket live events) — **keep**
- `QuickAction` links (projects, schedules, skills) — **replace with life dashboard sections**

Transform the "Quick Actions" panel into life dashboard summary sections (Actions Today, Active Pipelines, Pending Approvals, Latest Insights, Upcoming Events).

### Event Types

Add to `packages/shared/src/types/events.ts`:
- `config:version:reverted` event with payload: `{ commitHash, revertHash, files, timestamp }`

### API Response Types

Add to `packages/shared/src/types/api.ts` (or create `packages/shared/src/types/config-history.ts`):

```typescript
export interface ConfigCommit {
  hash: string;
  timestamp: string; // ISO 8601
  message: string;
  author: string;
  files: string[];
}

export interface ConfigCommitDetail extends ConfigCommit {
  diffs: Array<{
    file: string;
    diff: string; // unified diff
  }>;
}

export interface RevertResult {
  success: boolean;
  message: string;
  revertHash?: string;
  reloadedConfigs: string[];
}

export interface LifeDashboardData {
  today: {
    autonomousActionsCount: number;
    pipelinesCompleted: number;
  };
  pipelines: {
    activeCount: number;
    lastRun?: {
      name: string;
      status: string;
      completedAt: string;
    };
  };
  pendingApprovalsCount: number;
  insights: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
  }>;
  systemHealth: {
    status: string;
    uptime: number;
    agentsRunning: number;
    queueLength: number;
  };
  upcomingEvents: Array<{
    name: string;
    scheduledAt: string;
    type: string;
  }>;
}
```

### File Naming & Location

All new files follow kebab-case convention:

```
packages/core/src/
  config-history/
    git-history.ts          (git operations)
  api/routes/
    config-history.ts       (REST API)
    dashboard.ts            (life dashboard aggregation)
  __tests__/
    config-history.test.ts
    dashboard-api.test.ts

packages/shared/src/types/
  config-history.ts         (shared types)

packages/web/src/
  app/
    config-history/
      page.tsx              (config history page)
  components/dashboard/
    DiffViewer.tsx           (diff display component)
    LifeSummary.tsx          (life dashboard summary cards)
    InsightsPanel.tsx        (latest insights section)
    UpcomingEvents.tsx       (upcoming events section)
```

### Previous Story Learnings (from 10.5)

- **Config applier validates with Zod before applying** — config history revert should also validate the restored content before committing
- **Telegram truncation at 3800 chars** — if config revert notification is sent to Telegram, respect this limit
- **Convention auditor pattern** — after revert, the restored config should still pass convention checks
- **Build artifacts leaked to git** — ensure `.gitignore` covers any new build outputs
- **Event emission pattern**: `generateId()` for ID, `Date.now()` for timestamp, `source: 'config-history'`
- **Testing pattern**: mock `execFile` (from `node:child_process`), use `vi.mock()` for module-level mocks, temp SQLite DBs for DB-backed tests

### Security Considerations

- **Path traversal prevention**: Revert API must validate that `filePath` starts with `config/` — never allow reverting arbitrary files
- **SHA validation**: Commit hash parameter must match `/^[0-9a-f]{7,40}$/i` — reject anything else
- **No shell injection**: Use `execFile` (not `exec`) — arguments are passed as array, not concatenated into shell command
- **Permission tier**: Config revert could be a Yellow-tier action. Check with existing permission engine. At minimum, log to audit trail

### Project Structure Notes

- Alignment with unified project structure: all new files under established directories
- No new packages or workspaces needed
- No new npm dependencies needed — `execFile` is built-in, diff rendering is CSS-only
- Config history page is separate from existing config changes page (`/config` shows pending changes from story 10.5; `/config-history` shows git commit history)

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 10, Story 10.6]
- [Source: _bmad-output/planning-artifacts/prd.md — FR32, FR33, NFR15, NFR25, NFR28]
- [Source: _bmad-output/planning-artifacts/architecture.md — API patterns, git operations, data architecture]
- [Source: packages/shared/src/utils/git-commit.ts — existing git utility pattern]
- [Source: packages/core/src/api/routes/config-changes.ts — existing config changes API]
- [Source: packages/core/src/api/routes/health.ts — health aggregation pattern]
- [Source: packages/web/src/app/page.tsx — current dashboard homepage]
- [Source: packages/web/src/components/layout/Sidebar.tsx — navigation structure]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- Build: `npm run build -w packages/shared -w packages/core` — clean
- Lint: `npm run check` — pass (no errors)
- Tests: 20/20 tests pass (15 original + 5 API route integration tests added during code review); 4 pre-existing failures in knowledge/email-triage (unrelated)

### Completion Notes List

- **Task 1**: Created `git-history.ts` with `getConfigCommits()`, `getCommitDetail()`, `revertConfigFile()`. SHA validation, path traversal prevention, `config:reloaded` + `config:version:reverted` event emission.
- **Task 2**: Created `config-history.ts` API routes — GET list (paginated), GET detail (with diffs), POST revert. Registered in `server.ts`.
- **Task 3**: Created `config-history/page.tsx` with expandable commit rows, `DiffViewer` component (syntax-colored unified diff), revert with confirmation dialog + toast feedback, pagination. Added sidebar link.
- **Task 4**: Created `dashboard.ts` route — `GET /api/dashboard/life` aggregating agent_tasks count, pipeline stats, pending approvals, insights, system health, upcoming events. Added `getUpcomingRuns()` method to Scheduler.
- **Task 5**: Redesigned `page.tsx` — replaced Quick Actions with `LifeSummary` cards (actions, pipelines, approvals, health), `InsightsPanel`, `UpcomingEvents`. All sections link to detail pages. Kept existing StatusCards + ActivityFeed.
- **Task 6**: 15 tests — config-history.test.ts (11 tests: list, detail, revert, SHA validation, path traversal, error handling, event emission) + dashboard-api.test.ts (4 tests: response shape, zero counts, task counting, insights from DB).

### Change Log

- 2026-03-23: Story 10.6 implemented — config version history backend/frontend + life dashboard backend/frontend + tests
- 2026-03-23: Code review fixes — H1: revertConfigFile uses absolute path via git rev-parse --show-toplevel; M1: removed redundant pending approvals filter; M2: added 5 API route integration tests for config-history endpoints; M3: scoped getCommitDetail git log to config/ directory; L1: fixed DiffViewer double newline rendering

### File List

- `packages/shared/src/types/config-history.ts` (new)
- `packages/shared/src/types/index.ts` (modified — added config-history export)
- `packages/shared/src/types/events.ts` (modified — added ConfigVersionRevertedEvent)
- `packages/core/src/config-history/git-history.ts` (new)
- `packages/core/src/api/routes/config-history.ts` (new)
- `packages/core/src/api/routes/dashboard.ts` (new)
- `packages/core/src/api/server.ts` (modified — registered config-history + dashboard routes)
- `packages/core/src/scheduler/scheduler.ts` (modified — added getUpcomingRuns method)
- `packages/core/src/__tests__/config-history.test.ts` (new)
- `packages/core/src/__tests__/dashboard-api.test.ts` (new)
- `packages/web/src/app/page.tsx` (modified — life dashboard redesign)
- `packages/web/src/app/config-history/page.tsx` (new)
- `packages/web/src/components/dashboard/DiffViewer.tsx` (new)
- `packages/web/src/components/dashboard/LifeSummary.tsx` (new)
- `packages/web/src/components/dashboard/InsightsPanel.tsx` (new)
- `packages/web/src/components/dashboard/UpcomingEvents.tsx` (new)
- `packages/web/src/components/layout/Sidebar.tsx` (modified — added Config link)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — status updated)
- `_bmad-output/implementation-artifacts/10-6-config-version-management-and-life-dashboard.md` (modified — tasks checked, Dev Agent Record filled)
