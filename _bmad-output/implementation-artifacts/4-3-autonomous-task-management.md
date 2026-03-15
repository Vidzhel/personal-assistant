# Story 4.3: Autonomous Task Management

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want Raven to autonomously manage TickTick tasks based on permission tiers,
So that routine task operations happen without my involvement.

## Acceptance Criteria

1. **Permission-Gated Task Updates** — Given a task's priority should be updated based on context, When the autonomous management runs, Then the permission gate checks the tier for `ticktick:update-task` before executing.

2. **Silent Green-Tier Reads** — Given a Green-tier task read operation, When executed, Then task data is fetched silently with no user notification.

3. **Yellow-Tier Notification** — Given a Yellow-tier task update, When executed, Then the update is applied and the user is notified of what changed.

4. **Red-Tier Approval Queue** — Given a Red-tier task deletion is requested, When the permission gate checks, Then the action is queued for approval and does not execute until approved.

## Tasks / Subtasks

- [x] Task 1: Create autonomous-manager service skeleton (AC: #1, #2, #3, #4)
  - [x] 1.1 Create `suites/task-management/services/` directory
  - [x] 1.2 Create `suites/task-management/services/autonomous-manager.ts` implementing `SuiteService` pattern (same as email-triage, reply-composer, action-extractor)
  - [x] 1.3 On `start()`: store `eventBus`, `config` references; subscribe to `schedule:triggered` event filtered by `taskType === 'autonomous-task-management'`; subscribe to `task-management:manage-request` event (for Telegram/API manual triggers)
  - [x] 1.4 On `stop()`: unsubscribe from all events, null out all references, clear any in-flight state
  - [x] 1.5 `handleScheduleTrigger()`: validate event payload, call `runAutonomousManagement()`
  - [x] 1.6 Guard against concurrent runs: use a boolean `isRunning` flag; if already running when triggered, log warning and skip

- [x] Task 2: Fetch and analyze all open tasks (AC: #2)
  - [x] 2.1 In `runAutonomousManagement()`: call `agentManager.executeApprovedAction({ actionName: 'ticktick:get-tasks', skillName: 'task-management', details: 'Get all open tasks across all projects. Return JSON array with fields: id, projectId, title, content, priority (0=none,1=low,3=medium,5=high), dueDate, startDate, tags, status. Use the get_all_tasks or filter_tasks MCP tool.' })`
  - [x] 2.2 Parse agent result to extract task list JSON. If fetch fails: log error, emit `task-management:autonomous:failed` event, return
  - [x] 2.3 If no tasks found (empty list): log info, emit completion event with `actionsCount: 0`, return early
  - [x] 2.4 Call `agentManager.executeApprovedAction({ actionName: 'ticktick:get-tasks', skillName: 'task-management', details: '<analysis prompt with full task list>' })` — AI agent analyzes all tasks and returns structured JSON of recommended actions
  - [x] 2.5 The analysis prompt must instruct the agent to return ONLY a JSON array: `[{ "action": "update-task" | "complete-task" | "delete-task", "taskId": "...", "projectId": "...", "taskTitle": "...", "reason": "...", "confidence": "low" | "medium" | "high", "changes": { "priority"?: number, "dueDate"?: string, "tags"?: string[] } }]`
  - [x] 2.6 Parse analysis response — extract JSON from result text using defensive parsing (try/catch, regex fallback for JSON extraction). If parsing fails, log warning and emit failure event
  - [x] 2.7 Filter out low-confidence recommendations; only execute `"medium"` and `"high"` confidence actions

- [x] Task 3: Execute recommended actions through permission gates (AC: #1, #3, #4)
  - [x] 3.1 For each recommended action, map to the correct `actionName`:
    - `"update-task"` → `ticktick:update-task` (yellow — executes + notifies)
    - `"complete-task"` → `ticktick:complete-task` (yellow — executes + notifies)
    - `"delete-task"` → `ticktick:delete-task` (red — queued for approval)
  - [x] 3.2 For each action: call `agentManager.executeApprovedAction({ actionName, skillName: 'task-management', details: '<action-specific prompt including taskId, projectId, reason, and changes>' })`
  - [x] 3.3 Track results: `{ executed: ActionResult[], queued: ActionResult[], failed: ActionResult[] }`
  - [x] 3.4 For red-tier actions that return `{ success: false }`: the permission gate already queues them and emits `permission:blocked` — log this as "queued for approval", add to `queued` array, do NOT treat as failure
  - [x] 3.5 For yellow-tier actions that succeed: add to `executed` array with action details for summary notification

- [x] Task 4: Summary notification via Telegram (AC: #3)
  - [x] 4.1 After all actions processed: emit `notification` event with summary:
    - Title: "Autonomous Task Management"
    - Body: "Completed N task actions: X updates, Y completions. Z actions queued for approval."
    - topicName: "general"
    - channel: "telegram"
  - [x] 4.2 Include inline keyboard actions: `[View Tasks]` (callback: `t:l:` to list tasks)
  - [x] 4.3 Only emit notification if at least 1 action was executed or queued (skip "0 actions" notifications)
  - [x] 4.4 Emit `task-management:autonomous:completed` event with full execution details

- [x] Task 5: Add new event types (AC: all)
  - [x] 5.1 Add to `packages/shared/src/types/events.ts`: `TaskManagementAutonomousCompletedEvent` (type: `task-management:autonomous:completed`, payload: `{ executedCount: number, queuedCount: number, failedCount: number, actions: Array<{ action: string, taskTitle: string, reason: string, outcome: 'executed' | 'queued' | 'failed' }> }`)
  - [x] 5.2 Add to `packages/shared/src/types/events.ts`: `TaskManagementAutonomousFailedEvent` (type: `task-management:autonomous:failed`, payload: `{ error: string }`)
  - [x] 5.3 Add to `packages/shared/src/types/events.ts`: `TaskManagementManageRequestEvent` (type: `task-management:manage-request`, payload: `{ source: 'telegram' | 'api' | 'pipeline', requestId?: string }`)
  - [x] 5.4 Add Zod validation schemas for all new event payloads
  - [x] 5.5 Add to `RavenEvent` union type and `RavenEventType`
  - [x] 5.6 Add constants to `packages/shared/src/suites/constants.ts`: `EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED`, `EVENT_TASK_MGMT_AUTONOMOUS_FAILED`, `EVENT_TASK_MGMT_MANAGE_REQUEST`
  - [x] 5.7 Add barrel exports in `packages/shared/src/suites/index.ts`

- [x] Task 6: Add schedule configuration (AC: #1)
  - [x] 6.1 Add to `config/schedules.json`: `{ "id": "autonomous-task-management", "name": "Autonomous Task Management", "cron": "0 */6 * * *", "taskType": "autonomous-task-management", "skillName": "task-management", "enabled": true }`
  - [x] 6.2 The schedule runs every 6 hours by default (configurable via schedule API)

- [x] Task 7: Register autonomous-manager in task-management suite (AC: all)
  - [x] 7.1 Update `suites/task-management/suite.ts`: add `capabilities: [..., 'services']` and `services: ['autonomous-manager']`
  - [x] 7.2 Verify service starts/stops correctly in suite lifecycle

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Create `suites/task-management/__tests__/autonomous-manager.test.ts`
  - [x] 8.2 Unit tests: event subscription/unsubscription on start/stop, schedule event filtering (only responds to `taskType: 'autonomous-task-management'`)
  - [x] 8.3 Unit tests: concurrent run guard (second trigger while running → skip with warning log)
  - [x] 8.4 Integration test: full flow — schedule trigger → task fetch → AI analysis → action execution → notification → completion event
  - [x] 8.5 Test green-tier silent read: `ticktick:get-tasks` executeApprovedAction called with correct params, no notification event emitted for the read itself
  - [x] 8.6 Test yellow-tier notification: `ticktick:update-task` succeeds → summary notification emitted with change details
  - [x] 8.7 Test red-tier blocking: `ticktick:delete-task` → executeApprovedAction returns `{ success: false }` → action counted as "queued" (not "failed"), no error logged
  - [x] 8.8 Test no-op run: empty task list → completion event with all counts = 0, no notification emitted
  - [x] 8.9 Test AI analysis failure: agent returns invalid JSON → failure event emitted, no crash
  - [x] 8.10 Test task fetch failure: `ticktick:get-tasks` fails → failure event emitted, no crash
  - [x] 8.11 Test manual trigger: `task-management:manage-request` event → same flow as schedule trigger
  - [x] 8.12 Test partial action failure: 3 actions recommended, 1 fails → executed/failed/queued counts correct in completion event
  - [x] 8.13 Test low-confidence filtering: agent returns 3 recommendations (1 low, 1 medium, 1 high) → only 2 executed
  - [x] 8.14 Extend event type tests if needed

## Dev Notes

### Architecture Constraints

- **This creates the first service in the `suites/task-management/` suite** — the suite currently has no `services/` directory or SuiteService pattern. The autonomous-manager is a new service that joins the existing ticktick-agent and actions.
- **Service-direct schedule handling**: The service listens for `schedule:triggered` events directly on the event bus, filtered by `taskType === 'autonomous-task-management'`. The schedule is registered in `config/schedules.json` (global), NOT in a suite-level `schedules.json`. This means the orchestrator's `findSuiteForTaskType()` won't find a matching suite and will log a warning + skip — this is intentional and harmless. The service handles the full flow independently.
- **Multi-step agent flow**: Unlike the daily-briefing pattern (orchestrator spawns agent → service post-processes), this service does ALL agent calls itself via `executeApprovedAction()`. This is the same pattern as `action-extractor.ts` (story 4.2) — the service is the orchestrator for this specific flow.
- **Permission gates are automatic** — `executeApprovedAction()` → `runTask()` → `enforcePermissionGate()` in `agent-session.ts`. Green-tier actions execute silently. Yellow-tier actions execute and emit `permission:approved`. Red-tier actions get queued in `pending_approvals` table and emit `permission:blocked`. The service doesn't need to check tiers manually — it just calls `executeApprovedAction` and interprets the `{ success, result, error }` response.
- **Red-tier detection**: When `executeApprovedAction` returns `{ success: false }` for a red-tier action, the error message will indicate "queued-for-approval". The service should check for this to distinguish "queued for approval" from "actual failure". Pattern: `if (!result.success && result.error?.includes('queued'))` → count as queued, not failed.
- **No classes** — autonomous-manager exports a `SuiteService` object with `start()/stop()` methods (same pattern as email-triage, reply-composer, action-extractor).
- **No direct TickTick API calls** — all operations go through `agentManager.executeApprovedAction()` which spawns ticktick-agent sub-agents with TickTick MCP tools. This preserves MCP isolation.
- **Cross-suite notification**: The service emits `notification` events consumed by the Telegram bot in the notifications suite. No direct import of notification code.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| TickTick agent | `suites/task-management/agents/ticktick-agent.ts` | **USE** for all task operations via MCP |
| Task management actions | `suites/task-management/actions.json` | **USE** existing tiers: green (get-tasks, get-task-details), yellow (create-task, update-task, complete-task), red (delete-task) |
| Task management suite | `suites/task-management/suite.ts` | **EXTEND** with services capability and autonomous-manager service |
| AgentManager.executeApprovedAction | `packages/core/src/agent-manager/agent-manager.ts` | **USE** for all TickTick operations |
| Permission gate (enforcePermissionGate) | `packages/core/src/agent-manager/agent-session.ts` | **RELIES ON** — automatically enforces tiers on every executeApprovedAction call |
| Pending approvals | `packages/core/src/permission-engine/pending-approvals.ts` | **RELIES ON** — red-tier actions automatically queued here |
| Audit log | `packages/core/src/permission-engine/audit-log.ts` | **RELIES ON** — all action outcomes automatically recorded |
| NotificationEvent | `packages/shared/src/types/events.ts` | **USE** for task management alerts: `channel`, `title`, `body`, `topicName`, `actions` |
| EventBus | `packages/core/src/event-bus/event-bus.ts` | **USE** subscribe/emit pattern |
| ScheduleTriggeredEvent | `packages/shared/src/types/events.ts` | **USE** for schedule trigger handling |
| Action extractor (reference) | `suites/email/services/action-extractor.ts` | **REFERENCE** SuiteService + multi-step executeApprovedAction pattern |
| Email triage (reference) | `suites/email/services/email-triage.ts` | **REFERENCE** SuiteService + event filtering pattern |
| generateId() | `packages/shared/src/utils/id.ts` | **USE** for event IDs |
| createLogger() | `packages/shared/src/utils/logger.ts` | **USE** Pino structured logging |
| Constants | `packages/shared/src/suites/constants.ts` | **EXTEND** with new autonomous management event constants |
| ServiceContext / SuiteService | `packages/core/src/suite-registry/service-runner.ts` | **IMPLEMENT** interface for autonomous-manager service |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | **USE** — fires `schedule:triggered` events via croner |
| Global schedules config | `config/schedules.json` | **EXTEND** with autonomous-task-management schedule |

### Autonomous Management Flow Architecture

```
config/schedules.json: { taskType: 'autonomous-task-management', cron: '0 */6 * * *' }
  │ every 6 hours
  ▼
Scheduler emits: schedule:triggered { taskType: 'autonomous-task-management' }
  │
  │ [Orchestrator also receives this event, but findSuiteForTaskType returns null → skips]
  │
  ▼
Autonomous Manager Service (NEW - suites/task-management/services/autonomous-manager.ts)
  │ subscribes to: schedule:triggered (filtered by taskType)
  │ also subscribes to: task-management:manage-request (manual trigger)
  │
  │ 1. Check isRunning guard → skip if already running
  │
  │ 2. Fetch all open tasks:
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:get-tasks',
  │      skillName: 'task-management',
  │      details: 'Get all open tasks across all projects. Return JSON array...'
  │    })
  │    → ticktick-agent fetches via TickTick MCP (GREEN tier — silent, no notification)
  │
  │ 3. AI analysis of all tasks:
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:get-tasks',
  │      skillName: 'task-management',
  │      details: '<analysis prompt with task data, requesting structured JSON recommendations>'
  │    })
  │    → ticktick-agent analyzes tasks, returns JSON (GREEN tier — silent)
  │
  │ 4. For each recommended action (filtered by confidence ≥ medium):
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:update-task' | 'ticktick:complete-task' | 'ticktick:delete-task',
  │      skillName: 'task-management',
  │      details: '<specific action prompt with taskId, projectId, changes, reason>'
  │    })
  │    → Permission gate enforces tier:
  │       GREEN: execute silently (reads only — not used here)
  │       YELLOW: execute + audit + emit permission:approved (updates, completions)
  │       RED: block + queue in pending_approvals + emit permission:blocked (deletions)
  │
  │ 5. Emit: notification { title: "Autonomous Task Management", body: summary }
  │    → Telegram bot delivers alert with inline keyboard
  │
  │ 6. Emit: task-management:autonomous:completed { executedCount, queuedCount, failedCount, actions }
  │
  ▼
  Done (async, non-blocking)
```

### AI Analysis Prompt Design

The analysis prompt sent to the ticktick-agent should be:

```
You are analyzing a user's TickTick task list for autonomous management. Review ALL tasks and recommend actions that would help the user stay organized and productive.

Current date: {today}

Tasks:
{JSON task list}

Analyze each task and recommend actions ONLY when clearly beneficial. Return ONLY a JSON array, no other text.

Recommended action types:
- "update-task": Adjust priority (overdue tasks should be higher priority), fix missing due dates if context implies one, add helpful tags
- "complete-task": Only if the task content/title clearly indicates it's already done (e.g., "DONE: ...", past event dates)
- "delete-task": Only for obvious duplicates or clearly obsolete tasks (use sparingly — this requires user approval)

Return format:
[
  {
    "action": "update-task" | "complete-task" | "delete-task",
    "taskId": "task ID from the list",
    "projectId": "project ID from the list",
    "taskTitle": "original task title for logging",
    "reason": "Brief explanation of why this action is recommended",
    "confidence": "low" | "medium" | "high",
    "changes": {
      "priority": 0 | 1 | 3 | 5,
      "dueDate": "YYYY-MM-DDTHH:mm:ssZ" or null,
      "tags": ["tag1", "tag2"]
    }
  }
]

Rules:
- Only recommend actions you are confident about — prefer fewer high-quality actions
- Priority values: 0=none, 1=low, 3=medium, 5=high
- "changes" only needed for "update-task" actions
- If no actions recommended, return empty array []
- Be conservative — user trust is earned through reliable, helpful actions
- NEVER recommend deleting tasks unless they are exact duplicates
```

### Key Design Decisions

1. **Service-direct schedule handling** — The service subscribes to `schedule:triggered` directly on the event bus, rather than going through the orchestrator's `handleSchedule` route. This avoids the orchestrator spawning a separate generic agent task. The schedule is in `config/schedules.json` (global), not in a suite-level `schedules.json`, so `findSuiteForTaskType` returns null and the orchestrator skips it (logs a warning — harmless).

2. **Two green-tier calls for fetch + analysis** — Step 2 (fetch tasks) and Step 3 (analyze tasks) both use `ticktick:get-tasks` (green-tier). The first call fetches the raw task data via MCP tools. The second call receives the task data in the prompt and uses the ticktick-agent's reasoning to produce recommendations. Two calls keep each prompt focused and the results parseable.

3. **Confidence-based filtering** — The AI agent assigns confidence levels to each recommendation. Low-confidence recommendations are skipped. This prevents aggressive automation and builds user trust gradually. As the system proves reliable, the analysis prompt can be tuned to be more assertive.

4. **Red-tier detection via error message** — When `executeApprovedAction` returns `{ success: false }` for a red-tier `ticktick:delete-task`, the error message contains "queued-for-approval". The service uses this to distinguish "queued for user approval" (expected) from "actual failure" (unexpected). This avoids needing to import or call the permission engine directly.

5. **Concurrent run guard** — A simple `isRunning` boolean prevents overlapping runs if the schedule fires while a previous run is still executing (e.g., slow TickTick API). This is preferred over a queue because there's no benefit to running back-to-back — the next scheduled run will pick up any changes.

6. **Manual trigger support** — The service listens for `task-management:manage-request` events, allowing users to trigger autonomous management from Telegram (via inline button or command) or the API. Same flow, different trigger source.

### NFR Compliance

- **NFR8:** Service load failure doesn't crash process — follows SuiteService pattern with graceful start/stop
- **NFR9:** Agent task errors caught and reported — all executeApprovedAction calls wrapped in try/catch
- **NFR15:** Event handler returns promptly — heavy work (agent calls) is async, event handler doesn't block event loop
- **NFR18:** All I/O non-blocking — agent tasks queue in agent manager, event emission is fire-and-forget
- **NFR22:** TickTick API failure → failure event emitted, logged, no crash
- **NFR29:** All logging via Pino structured JSON

### Previous Story Learnings (4.2 — Email Action Item Extraction & Task Creation)

- **SuiteService pattern** — export default object with `start(context)/stop()`, subscribe to events on start, unsubscribe on stop
- **agentManager via config** — access `config.agentManager` (lazy resolution after boot), NOT direct import
- **Event emission pattern** — use `eventBus.emit()` with generateId(), Date.now() timestamp, typed payload
- **Zod safeParse** — validate event payloads before processing, log and skip on validation failure
- **Error handling** — all error paths must have user-visible feedback (notification) or structured logging. Never swallow.
- **Test patterns** — mock eventBus with vi.fn(), capture event handler references via `on.mock.calls`, verify emission payloads. Mock agentManager as config injection.
- **vi.mock at module scope** — Vitest hoists mocks; put at file top, not in beforeEach
- **Code review learnings from 4.2** — H1: partial failure should queue only failed items. M1: return structured results (succeeded/failed arrays) not just counts. M3: use Zod for validating agent response JSON, not raw parsing.
- **AgentManagerLike interface** — define a local interface for the agentManager dependency to avoid circular imports: `interface AgentManagerLike { executeApprovedAction(params: { actionName: string; skillName: string; details?: string; sessionId?: string }): Promise<{ success: boolean; result?: string; error?: string }> }`

### Git Intelligence (Recent Commits)

```
84d120d feat: email action item extraction and task creation (story 4.2) + code review fixes
1aaab58 feat: email auto-triage rules (story 4.1) + code review fixes
eaffdd0 chore: eslint ide
cfa21e4 fix: code review fixes for story 3.6 email reply composition
9b831d8 feat: email reply composition from Telegram (story 3.6)
```

Commit message format: `feat: <description> (story X.Y)` — follow for story 4.3.

### Project Structure Notes

- **New files:**
  - `suites/task-management/services/autonomous-manager.ts` — autonomous task management SuiteService
  - `suites/task-management/__tests__/autonomous-manager.test.ts` — unit + integration tests
- **Modified files:**
  - `packages/shared/src/types/events.ts` — add `TaskManagementAutonomousCompletedEvent`, `TaskManagementAutonomousFailedEvent`, `TaskManagementManageRequestEvent` types + Zod schemas
  - `packages/shared/src/suites/constants.ts` — add `EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED`, `EVENT_TASK_MGMT_AUTONOMOUS_FAILED`, `EVENT_TASK_MGMT_MANAGE_REQUEST`
  - `packages/shared/src/suites/index.ts` — barrel export new constants
  - `suites/task-management/suite.ts` — add `capabilities: [..., 'services']`, `services: ['autonomous-manager']`
  - `config/schedules.json` — add autonomous-task-management schedule entry
- **Alignment:** All new files follow kebab-case naming, SuiteService pattern, ESM imports with `.ts` extensions

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 4, Story 4.3]
- [Source: _bmad-output/planning-artifacts/prd.md — FR34: System autonomously manages TickTick tasks based on permission tiers]
- [Source: _bmad-output/planning-artifacts/prd.md — FR37: User can delegate task management decisions to Raven from mobile]
- [Source: _bmad-output/planning-artifacts/architecture.md — Permission gates, MCP isolation, Sub-agent delegation, Scheduler, Event-driven coordination]
- [Source: _bmad-output/project-context.md — Critical implementation rules, coding conventions, anti-patterns]
- [Source: _bmad-output/implementation-artifacts/4-2-email-action-item-extraction-and-task-creation.md — SuiteService pattern, executeApprovedAction, test patterns, code review learnings]
- [Source: suites/task-management/suite.ts — current suite manifest (no services yet)]
- [Source: suites/task-management/actions.json — ticktick action tiers: green (get-tasks, get-task-details), yellow (create-task, update-task, complete-task), red (delete-task)]
- [Source: suites/task-management/agents/ticktick-agent.ts — TickTick agent definition with MCP tools]
- [Source: suites/email/services/action-extractor.ts — SuiteService + multi-step executeApprovedAction reference pattern]
- [Source: packages/core/src/agent-manager/agent-manager.ts — executeApprovedAction for permission-gated operations]
- [Source: packages/core/src/agent-manager/agent-session.ts — enforcePermissionGate: green=silent, yellow=execute+audit, red=block+queue]
- [Source: packages/core/src/suite-registry/service-runner.ts — SuiteService interface, ServiceContext, service loading]
- [Source: packages/core/src/orchestrator/orchestrator.ts:87-118 — handleSchedule uses findSuiteForTaskType, skips if not found]
- [Source: packages/core/src/scheduler/scheduler.ts — croner-based scheduler, fires schedule:triggered events]
- [Source: packages/shared/src/types/events.ts — ScheduleTriggeredEvent, NotificationEvent, PermissionBlockedEvent, AgentTaskCompleteEvent]
- [Source: packages/shared/src/suites/constants.ts — existing suite/agent/event constants]
- [Source: config/schedules.json — existing schedule configuration (morning-digest)]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- Fixed latent bug: added 'services' to SuiteCapability Zod enum in define.ts (was missing, would crash at runtime for email, daily-briefing, notifications, gemini-transcription suites)

### Completion Notes List

- Task 1: Created autonomous-manager service skeleton following SuiteService pattern (action-extractor reference). Subscribes to `schedule:triggered` (filtered by taskType) and `task-management:manage-request`. Concurrent run guard via `isRunning` boolean.
- Task 2: Two-step agent flow — fetch all open tasks via `ticktick:get-tasks` (green tier, silent), then AI analysis via second `ticktick:get-tasks` call with structured analysis prompt. Defensive JSON parsing with Zod validation per recommendation. Low-confidence filtering.
- Task 3: Action execution through permission gates. Maps action types to `ticktick:update-task` (yellow), `ticktick:complete-task` (yellow), `ticktick:delete-task` (red). Red-tier detection via `error?.includes('queued')` pattern. Tracks executed/queued/failed results.
- Task 4: Summary notification via Telegram with inline keyboard `[View Tasks]` action. Skips notification for 0-action runs. Emits `task-management:autonomous:completed` event with full execution details.
- Task 5: Added 3 new event types with Zod schemas, union type entries, constants, and barrel exports.
- Task 6: Added `autonomous-task-management` schedule to `config/schedules.json` (every 6 hours).
- Task 7: Updated `suites/task-management/suite.ts` with `services` capability and `autonomous-manager` service. Also fixed SuiteCapability enum to include 'services'.
- Task 8: 29 tests covering all ACs — service lifecycle, schedule filtering, concurrent guard, task fetch/analysis, permission gate tiers, partial failures, confidence filtering, manual triggers, parser unit tests.

### Change Log

- 2026-03-15: Implemented autonomous task management (story 4.3) — service, event types, schedule config, suite registration, 29 tests

### File List

**New files:**
- `suites/task-management/services/autonomous-manager.ts` — autonomous task management SuiteService
- `suites/task-management/__tests__/autonomous-manager.test.ts` — 29 unit + integration tests

**Modified files:**
- `packages/shared/src/types/events.ts` — added TaskManagementAutonomousCompletedEvent, TaskManagementAutonomousFailedEvent, TaskManagementManageRequestEvent types + Zod schemas + union entries
- `packages/shared/src/suites/constants.ts` — added EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED, EVENT_TASK_MGMT_AUTONOMOUS_FAILED, EVENT_TASK_MGMT_MANAGE_REQUEST
- `packages/shared/src/suites/index.ts` — barrel exports for new constants
- `packages/shared/src/suites/define.ts` — added 'services' to SuiteCapability enum (bug fix)
- `suites/task-management/suite.ts` — added 'services' capability and services: ['autonomous-manager']
- `config/schedules.json` — added autonomous-task-management schedule entry
