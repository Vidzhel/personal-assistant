# Story 1.7: Agent Execution Logging & System Health Monitoring

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want all agent task executions logged and system health self-monitored,
so that I can see what Raven is doing and failures surface automatically.

## Acceptance Criteria

1. **Execution Record on Task Completion** — Given an agent task executes, When it completes (success or failure), Then an execution record is written to the `agent_tasks` table with task ID, skill name, action name, status, duration (ms), and ISO 8601 timestamps (started_at, completed_at).

2. **Enhanced Health Endpoint** — Given the system is running, When `GET /api/health` is called, Then it responds within 500ms with status of each subsystem (db connectivity, eventBus listener count, skills loaded, scheduler active jobs) and recent task statistics (last hour: total, succeeded, failed, avg duration).

3. **Health Alert Event on Failure** — Given a skill fails to load or an agent task errors, When the failure is detected, Then a `system:health:alert` event is emitted with severity, source component, error message, and timestamp.

4. **Execution Log Query API** — Given execution records exist in the database, When `GET /api/agent-tasks` is called with optional query params (`skillName`, `status`, `limit`, `offset`), Then matching task records are returned ordered by `created_at DESC`.

5. **Task Detail API** — Given a specific task has been executed, When `GET /api/agent-tasks/:id` is called, Then the full task record is returned including result, errors, and duration.

6. **Database Persistence** — Given agent tasks currently only exist in-memory, When a task transitions through its lifecycle (queued → running → completed/failed/blocked), Then each state change is persisted to the `agent_tasks` SQLite table.

7. **Recent Task Stats in Health** — Given the health endpoint is called, When task statistics are computed, Then the response includes `taskStats: { total1h, succeeded1h, failed1h, avgDurationMs, lastTaskAt }` based on the last hour of persisted task data.

## Tasks / Subtasks

- [x] Task 1: Database Schema Enhancement (AC: #6)
  - [x] 1.1 Create `migrations/004-execution-logging.sql` — add missing columns to `agent_tasks` table: `action_name TEXT`, `blocked INTEGER DEFAULT 0`; add indexes: `idx_agent_tasks_status`, `idx_agent_tasks_created_at`, `idx_agent_tasks_skill_name`
  - [x] 1.2 Verify migration runner picks up 004 correctly
  - [x] 1.3 Build shared package to verify type exports

- [x] Task 2: Execution Logger Module (AC: #1, #6)
  - [x] 2.1 Create `packages/core/src/agent-manager/execution-logger.ts` — factory function `createExecutionLogger(deps: { db: DatabaseInterface })` returning `{ logTaskStart, logTaskComplete, queryTasks, getTaskById, getTaskStats }`
  - [x] 2.2 `logTaskStart(task: AgentTask)` — INSERT into `agent_tasks` with id, session_id, project_id, skill_name, action_name, prompt, status='running', priority, created_at, started_at
  - [x] 2.3 `logTaskComplete(task: AgentTask)` — UPDATE `agent_tasks` SET status, result, duration_ms, errors (JSON), completed_at, blocked WHERE id
  - [x] 2.4 `queryTasks(opts: { skillName?, status?, limit?, offset? })` — SELECT with optional filters, ORDER BY created_at DESC
  - [x] 2.5 `getTaskById(id: string)` — SELECT single task by ID
  - [x] 2.6 `getTaskStats(sinceMs: number)` — query total, succeeded, failed, avg duration for tasks completed within timeframe

- [x] Task 3: Integrate Execution Logger into Agent Manager (AC: #1, #6)
  - [x] 3.1 Add `executionLogger` to agent manager dependencies
  - [x] 3.2 In `runTask()`: call `logTaskStart()` after setting status to 'running'
  - [x] 3.3 In `runTask()`: call `logTaskComplete()` after task finishes (success, failure, or blocked)
  - [x] 3.4 Wire execution logger creation in boot sequence (`packages/core/src/index.ts`)
  - [x] 3.5 Pass execution logger to agent manager factory

- [x] Task 4: Health Alert Events (AC: #3)
  - [x] 4.1 Add `SystemHealthAlertEvent` type + `SystemHealthAlertPayloadSchema` to `packages/shared/src/types/events.ts`
  - [x] 4.2 Add `'system:health:alert'` to `RavenEventType` union and `RavenEvent` discriminated union
  - [x] 4.3 Emit `system:health:alert` in skill registry when a skill fails to load (existing try/catch in index.ts skill loading)
  - [x] 4.4 Emit `system:health:alert` in agent manager when a task fails (in runTask error handler)
  - [x] 4.5 Build shared to verify exports

- [x] Task 5: Enhanced Health Endpoint (AC: #2, #7)
  - [x] 5.1 Add `executionLogger` to `ApiDeps` interface in `packages/core/src/api/server.ts`
  - [x] 5.2 Enhance `GET /api/health` response with subsystem checks: db (simple query), eventBus (true — it's in-process), skills (count loaded vs configured), scheduler (active job count)
  - [x] 5.3 Add `taskStats` section: call `executionLogger.getTaskStats(3600000)` for last-hour stats
  - [x] 5.4 Add `memory` section: `process.memoryUsage()` (heapUsed, heapTotal, rss)
  - [x] 5.5 Ensure response within 500ms (simple DB queries, no heavy computation)

- [x] Task 6: Agent Task Query API (AC: #4, #5)
  - [x] 6.1 Create `packages/core/src/api/routes/agent-tasks.ts` with route registration
  - [x] 6.2 `GET /api/agent-tasks` — query params: `skillName`, `status`, `limit` (default 50), `offset` (default 0). Returns array of task records.
  - [x] 6.3 `GET /api/agent-tasks/:id` — return single task. 404 if not found.
  - [x] 6.4 Zod validation for query params
  - [x] 6.5 Register routes in `packages/core/src/api/server.ts`

- [x] Task 7: Tests (AC: all)
  - [x] 7.1 Unit tests for execution logger: logTaskStart, logTaskComplete, queryTasks, getTaskById, getTaskStats
  - [x] 7.2 Integration tests for enhanced health endpoint: verify subsystem checks, taskStats, memory
  - [x] 7.3 Integration tests for agent-tasks API: GET list with filters, GET by ID, 404
  - [x] 7.4 Test health alert event emission on task failure
  - [x] 7.5 Test execution logger integration with agent manager (mock SDK, verify DB records written)

## Dev Notes

### Architecture Constraints

- **API naming:** `/api/agent-tasks`, `/api/agent-tasks/:id`, `/api/health` — plural nouns, kebab-case
- **Direct responses, no envelope** — success returns data array/object, errors return `{ error: string, code?: string }`
- **HTTP status codes:** 200 (success), 404 (task not found), 400 (bad query params), 500 (server error)
- **Fastify route registration pattern** — follow `packages/core/src/api/routes/approvals.ts` and `audit-logs.ts`
- **ISO 8601 timestamps** — all timestamps in API responses must be ISO 8601 strings
- **Database timestamps** — `agent_tasks` table currently uses INTEGER (epoch ms) for timestamps; maintain this for DB, convert to ISO 8601 in API responses

### Existing Infrastructure (DO NOT RECREATE)

The following already exist from Stories 1-1 through 1-6. Use them directly:

| Component | Location | Interface |
|-----------|----------|-----------|
| `agent_tasks` table | Migration 001 | `id, session_id, project_id, skill_name, prompt, status, priority, result, duration_ms, errors, created_at, started_at, completed_at` |
| `AgentTask` type | `packages/shared/src/types/agents.ts` | `id, sessionId, projectId, skillName, actionName?, prompt, status, priority, mcpServers, agentDefinitions, result?, durationMs?, errors?, createdAt, startedAt?, completedAt?` |
| `AgentTaskCompleteEvent` | `packages/shared/src/types/events.ts` | Emitted by agent manager on task completion |
| `AgentManager` | `packages/core/src/agent-manager/agent-manager.ts` | `{ runTask, getQueueLength, getRunningCount, executeApprovedAction }` |
| `runAgentTask()` | `packages/core/src/agent-manager/agent-session.ts` | SDK query() wrapper with permission gate |
| `DatabaseInterface` | `packages/core/src/db/database.ts` | `{ run, get, all, close }` — thin wrapper over better-sqlite3 |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | `{ emit, on, off, once }` |
| `createAuditLog()` | `packages/core/src/permission-engine/audit-log.ts` | Pattern to follow for execution logger |
| Health route | `packages/core/src/api/routes/health.ts` | Currently returns: status, uptime, skills, agentQueue, agentsRunning |
| Skill registry | `packages/core/src/skill-registry/skill-registry.ts` | `{ getEnabledSkillNames, getSkill }` |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | `{ getActiveJobs? }` — check if method exists |
| Migration runner | `packages/core/src/db/migrations.ts` | Reads `migrations/*.sql`, applies in order |

### Key Code Patterns to Follow

**Route Registration (from approvals.ts):**
```typescript
import type { FastifyInstance } from 'fastify';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';

export function registerAgentTaskRoutes(
  app: FastifyInstance,
  deps: { executionLogger: ExecutionLogger }
): void {
  // Routes registered here
}
```

**Factory Function with DI (established pattern):**
```typescript
import type { DatabaseInterface } from '../db/database.ts';

export interface ExecutionLogger {
  logTaskStart: (task: AgentTask) => void;
  logTaskComplete: (task: AgentTask) => void;
  queryTasks: (opts: TaskQueryOpts) => TaskRecord[];
  getTaskById: (id: string) => TaskRecord | undefined;
  getTaskStats: (sinceMs: number) => TaskStats;
}

export function createExecutionLogger(deps: { db: DatabaseInterface }): ExecutionLogger {
  // Implementation
}
```

**Database Row Mapping:**
```typescript
// snake_case (SQLite) -> camelCase (TypeScript)
function rowToTaskRecord(row: AgentTaskRow): TaskRecord { ... }
```

**Zod Validation for Query Params:**
```typescript
import { z } from 'zod';
const taskQuerySchema = z.object({
  skillName: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
```

**Health Alert Event Emission:**
```typescript
eventBus.emit({
  type: 'system:health:alert',
  payload: {
    severity: 'error',
    source: 'agent-manager',
    message: `Task ${task.id} failed: ${error.message}`,
    taskId: task.id,
  },
  timestamp: new Date().toISOString(),
});
```

### Database Design Notes

**Migration 004 approach — ALTER TABLE, not recreate:**
The `agent_tasks` table already exists from migration 001. Add new columns with ALTER TABLE:
```sql
-- Add missing columns
ALTER TABLE agent_tasks ADD COLUMN action_name TEXT;
ALTER TABLE agent_tasks ADD COLUMN blocked INTEGER DEFAULT 0;

-- Add indexes for query performance
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_skill_name ON agent_tasks(skill_name);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_completed_at ON agent_tasks(completed_at);
```

**Note:** SQLite ALTER TABLE only supports ADD COLUMN — no MODIFY or DROP. This is fine for our needs.

**Task Stats Query Pattern:**
```sql
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration_ms,
  MAX(completed_at) as last_task_at
FROM agent_tasks
WHERE completed_at > ?
```

### Execution Logger vs Audit Log — Clear Separation

- **Audit Log** (`audit-log.ts`): Records permission-gated actions — action name, tier, outcome (executed/approved/denied/queued). Focused on trust/compliance.
- **Execution Logger** (`execution-logger.ts`): Records ALL agent task executions — skill, status, duration, errors. Focused on observability/debugging.
- Both use the same DB, different tables (audit_log vs agent_tasks).
- The execution logger writes to the *existing* `agent_tasks` table — it does NOT create a new table.

### Enhanced Health Response Shape

```typescript
{
  status: 'ok' | 'degraded' | 'error',
  uptime: number,
  timestamp: string,  // ISO 8601
  subsystems: {
    database: { status: 'ok' | 'error', latencyMs: number },
    eventBus: { status: 'ok', listenerCount: number },
    skills: { status: 'ok' | 'degraded', loaded: number, configured: number, names: string[] },
    scheduler: { status: 'ok', activeJobs: number },
    agentManager: { status: 'ok', queueLength: number, runningCount: number },
  },
  taskStats: {
    total1h: number,
    succeeded1h: number,
    failed1h: number,
    avgDurationMs: number | null,
    lastTaskAt: string | null,  // ISO 8601
  },
  memory: {
    heapUsedMB: number,
    heapTotalMB: number,
    rssMB: number,
  },
}
```

**Overall status logic:**
- `'ok'` — all subsystems ok, failure rate < 20%
- `'degraded'` — some skills failed to load OR failure rate >= 20%
- `'error'` — database unreachable

### Boot Sequence Wiring

The execution logger needs to be created early and passed to:
1. `createAgentManager()` — for logging task start/complete
2. `createApiServer()` — for health endpoint and task query routes

```typescript
// In index.ts boot sequence, after database init:
const executionLogger = createExecutionLogger({ db });
// Pass to agent manager:
const agentManager = createAgentManager({ ..., executionLogger });
// Pass to API server:
const api = createApiServer({ ..., executionLogger });
```

### Project Structure Notes

- New file: `packages/core/src/agent-manager/execution-logger.ts`
- New file: `packages/core/src/api/routes/agent-tasks.ts`
- New file: `migrations/004-execution-logging.sql`
- Modified: `packages/core/src/api/routes/health.ts` (enhanced response)
- Modified: `packages/core/src/api/server.ts` (register new routes, add executionLogger to ApiDeps)
- Modified: `packages/core/src/agent-manager/agent-manager.ts` (integrate execution logger)
- Modified: `packages/core/src/index.ts` (wire execution logger in boot sequence)
- Modified: `packages/shared/src/types/events.ts` (add SystemHealthAlertEvent)
- New test: `packages/core/src/__tests__/execution-logger.test.ts`
- New test: `packages/core/src/__tests__/agent-tasks-api.test.ts`
- Modified: `packages/core/src/__tests__/api.test.ts` (add executionLogger to test deps)
- Modified: `packages/core/src/__tests__/e2e.test.ts` (add executionLogger to test deps)

### Testing Strategy

- **Unit tests** for execution logger: INSERT, UPDATE, query with filters, getTaskById, getTaskStats
- **Integration tests** for API routes using Fastify's `inject()` method
- **Real SQLite temp DB** for execution logger (established pattern from audit-log tests)
- **Mock agent manager** for health endpoint tests (verify subsystem status reporting)
- **Test health alert events** — verify `system:health:alert` emitted on task failure via real EventBus with `vi.fn()` listener
- **Test DB persistence** — run task through agent manager (mocked SDK), verify agent_tasks row written

### Previous Story Intelligence

**From Story 1-6 (most recent):**
- `executeApprovedAction()` added to AgentManager — runs task and returns result; execution logger should also capture these
- `'failed'` added to `AuditOutcome` type — consistent error tracking
- Approval routes follow exact Fastify pattern — copy for agent-tasks routes
- 19 integration tests — healthy test infrastructure, follow same patterns
- `pendingApprovals` added to `ApiDeps` — same pattern for adding `executionLogger`

**From Story 1-6 code review:**
- DI pattern: use object-based deps, not positional params
- `vi.mock` must be at top level (hoisted), not inside `it()` blocks
- Existing test files (api.test.ts, e2e.test.ts) need new deps added when ApiDeps changes

**From Story 1-5:**
- `blocked?: boolean` on `AgentSessionResult` — map to `blocked` column in agent_tasks
- Permission gate happens BEFORE agent execution — blocked tasks never reach SDK query()
- `actionName` is optional on AgentTask — only present for skill-action tasks

### Git Intelligence

**Recent commit patterns:**
- `feat: story X-Y — description` for features
- `fix: story X-Y code review — specifics` for fixes
- Two-phase commit: feature implementation, then code review fixes
- Files follow kebab-case naming strictly
- Tests in `packages/core/src/__tests__/` directory

**Files most recently touched (from story 1-6):**
- `packages/core/src/agent-manager/agent-manager.ts` — modified (added executeApprovedAction)
- `packages/core/src/api/server.ts` — modified (added pendingApprovals to ApiDeps)
- `packages/core/src/index.ts` — modified (wired pendingApprovals)
- `packages/core/src/__tests__/api.test.ts` — modified (added pendingApprovals mock)
- `packages/core/src/__tests__/e2e.test.ts` — modified (added pendingApprovals mock)
- `packages/shared/src/types/events.ts` — modified (added PermissionDeniedEvent)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1-Story-1.7]
- [Source: _bmad-output/planning-artifacts/architecture.md#System-Observability]
- [Source: _bmad-output/planning-artifacts/architecture.md#API-Naming-Conventions]
- [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture]
- [Source: _bmad-output/planning-artifacts/epics.md#FR64-FR66]
- [Source: _bmad-output/implementation-artifacts/1-6-red-tier-approval-queue-and-batching.md]
- [Source: packages/core/src/agent-manager/agent-manager.ts]
- [Source: packages/core/src/api/routes/health.ts]
- [Source: packages/core/src/db/database.ts]
- [Source: migrations/001-initial-schema.sql]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Migration 004 verified via Node.js script: columns action_name, blocked added; 4 indexes created
- E2e health test updated: status can be 'degraded' when no skills loaded (valid in test env)

### Completion Notes List

- Task 1: Created migration 004-execution-logging.sql with ALTER TABLE for action_name/blocked columns and 4 indexes
- Task 2: Created execution-logger.ts with factory function pattern (matching audit-log.ts). All 6 methods: logTaskStart, logTaskComplete, queryTasks, getTaskById, getTaskStats. Row-to-record mapping converts snake_case DB to camelCase TS, epoch timestamps to ISO 8601
- Task 3: Integrated executionLogger into AgentManager as optional dep. Calls logTaskStart after status='running', logTaskComplete after task finishes. Wired in boot sequence (index.ts) and passed to both agentManager and apiServer
- Task 4: Added SystemHealthAlertEvent + Zod schema to shared/types/events.ts. Added to RavenEvent union. Emits on skill load failure (index.ts) and task failure (agent-manager.ts)
- Task 5: Enhanced health endpoint with subsystems (database latency, eventBus listener count, skills loaded, scheduler active jobs, agent manager queue/running), taskStats (1h window), memory (heap/rss in MB), overall status logic (ok/degraded/error). Added listenerCount() to EventBus, getActiveJobCount() to Scheduler
- Task 6: Created agent-tasks.ts routes with GET /api/agent-tasks (Zod-validated query params) and GET /api/agent-tasks/:id (404 handling). Registered in server.ts
- Task 7: 32 new tests across 2 test files. Updated api.test.ts and e2e.test.ts for new ApiDeps shape. All 189 tests pass, 0 lint errors

### File List

- migrations/004-execution-logging.sql (new)
- packages/core/src/agent-manager/execution-logger.ts (new)
- packages/core/src/api/routes/agent-tasks.ts (new)
- packages/core/src/__tests__/execution-logger.test.ts (new)
- packages/core/src/__tests__/agent-tasks-api.test.ts (new)
- packages/core/src/agent-manager/agent-manager.ts (modified)
- packages/core/src/api/routes/health.ts (modified)
- packages/core/src/api/server.ts (modified)
- packages/core/src/index.ts (modified)
- packages/core/src/event-bus/event-bus.ts (modified)
- packages/core/src/scheduler/scheduler.ts (modified)
- packages/shared/src/types/events.ts (modified)
- packages/core/src/__tests__/api.test.ts (modified)
- packages/core/src/__tests__/e2e.test.ts (modified)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)

### Change Log

- 2026-03-05: Story 1-7 implemented — execution logging, enhanced health endpoint, agent-tasks API, health alert events
- 2026-03-05: Code review fixes — H1: health alerts no longer fire for blocked tasks; H2/H3: added configuredSkillCount to ApiDeps and health response, fixed degraded logic; M1: safe JSON.parse for errors column; M2: added e2e test verifying DB persistence after task execution
- 2026-03-07: Runtime bug fixes found via `npm run dev` (--experimental-strip-types mode):
  - Bug 1: TS parameter properties (`constructor(private x: T)`) not supported by Node strip-types — replaced with explicit field + assignment in 5 files
  - Bug 2: `health?.skills.length` crash when skills is undefined — added optional chaining `health?.skills?.length` in StatusCards.tsx
  - Bug 3: Grammarly browser extension causes React hydration mismatch — added `suppressHydrationWarning` to `<html>` and `<body>` in layout.tsx
  - Bug 4: Agent tasks fail because orchestrator passed `mcpServers: {}` — SDK needs server configs to spawn sub-agents. Fixed to `this.skillRegistry.collectMcpServers(enabledSkills)`. MCP isolation preserved via `allowedTools` exclusion.
  - Root cause: Tests/CI run against `tsc`-compiled dist/ output, not strip-types dev mode. Dashboard tested with mocked data, not live API. No browser E2E tests.
  - Prevention: Added ESLint `TSParameterProperty` ban, `scripts/check-strip-types.sh` in `npm run check`, new browser test suite `manual-tests/08-integration-flows.md`
- 2026-03-07: Dependency updates across all packages:
  - Major bumps: next 15→16, zod 3→4, pino 9→10, better-sqlite3 11→12, croner 9→10, dotenv 16→17, @fastify/cors 10→11, eslint 9→10, @eslint/js 9→10, @types/node 22→25
  - Minor bumps: react 19.0→19.2, fastify 5.2→5.8, grammy 1.30→1.41, imapflow 1.0→1.2, mailparser 3.7→3.9, typescript 5.7→5.9, tailwindcss 4.0→4.2, zustand 5.0→5.0.11, pino-pretty 13.0→13.1, @fastify/websocket 11.0→11.2
  - Kept @anthropic-ai/claude-code at ^1.0.128 (v2 removed SDK query() exports, CLI-only)
  - All 190 tests pass, build + lint + strip-types checks clean
- 2026-03-07: Dual-mode agent backend — SDK + CLI strategy pattern:
  - Replaced direct `query()` import in `agent-session.ts` with backend abstraction (strategy pattern using factory functions)
  - New files: `agent-backend.ts` (shared types: `AgentBackend`, `BackendOptions`, `BackendResult`), `sdk-backend.ts` (wraps `query()` from SDK), `cli-backend.ts` (spawns `claude -p` with `--output-format stream-json`, NDJSON parsing, MCP temp file management)
  - `agent-session.ts` now dispatches to active backend via `initializeBackend(apiKey)` / `getActiveBackend()` — SDK mode when `ANTHROPIC_API_KEY` is set, CLI mode when empty
  - Boot sequence (`index.ts`): replaced API key warning with `initializeBackend(config.ANTHROPIC_API_KEY)` call
  - Swapped SDK dependency: `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk` (v0.2.71) — same `query()` API surface
  - Updated 3 test files to mock `@anthropic-ai/claude-agent-sdk` instead of `@anthropic-ai/claude-code`
  - New tests: `cli-backend.test.ts` (6 tests: session ID capture, assistant streaming, error handling, MCP temp files, spawn errors, stderr forwarding), `backend-init.test.ts` (2 tests: SDK vs CLI selection)
  - All 198 tests pass, 0 lint errors, build + check clean
- 2026-03-07: Session history fixes, frontend session UI, TickTick investigation:
  - **Message ordering fix**: `onAssistantMessage` in `agent-session.ts` now stores assistant text chunks to messageStore during streaming (before tool_use actions). Removed duplicate final-result store in `agent-manager.ts` (was appending result text AFTER all actions, breaking chronological order). Correct order now: user → thinking → assistant-chunk → action → assistant-chunk → action → ...
  - **Frontend session UI**: Added session selector bar to project page — dropdown to switch between sessions, "New Session" button. Updated `useChat` hook to accept optional `sessionId` prop and reload messages on session switch. Updated `ChatPanel` to pass through `sessionId`.
  - **Backend session creation**: Added `createSession()` to SessionManager (archives existing active sessions, creates fresh one). Added `POST /api/projects/:id/sessions/new` route. Added `getProjectSessions()` and `createSession()` to frontend API client.
  - **New tests**: `message-store.test.ts` (4 tests: append, ordering, pagination, empty session). Agent-manager tests: message store integration verifying assistant-before-action ordering. E2E tests: session creation, message history retrieval, message ordering verification. Fixed model string to `claude-sonnet-4-6`.
  - **TickTick investigation**: Documented MCP server connection findings
  - All 205 tests pass, 0 lint errors, build + check clean
