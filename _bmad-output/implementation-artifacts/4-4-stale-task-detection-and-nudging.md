# Story 4.4: Stale Task Detection & Nudging

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want Raven to surface stale tasks with AI-suggested next steps,
So that tasks don't silently rot in my backlog.

## Acceptance Criteria

1. **Stale Task Detection** — Given a TickTick task has had no activity for 7 days (configurable), When the stale task detection runs, Then the task is identified as stale and queued for nudging.

2. **AI-Generated Nudge** — Given a stale task is detected, When the nudge is generated, Then it includes the task title, age, and AI-suggested next steps (complete, snooze, break down, drop).

3. **Telegram Delivery with Inline Actions** — Given the stale task nudge is delivered to Telegram, When the user views it, Then inline buttons offer `[Do Today] [Snooze 1w] [Break Down] [Drop]`.

4. **Batch Pipeline Execution** — Given stale task detection is configured as a scheduled task, When the stale-task-nudge schedule runs, Then all stale tasks are processed in a single batch notification.

## Tasks / Subtasks

- [ ] Task 1: Create stale-detector service skeleton (AC: #1, #4)
  - [ ] 1.1 Create `suites/task-management/services/stale-detector.ts` implementing SuiteService pattern (same as autonomous-manager, action-extractor)
  - [ ] 1.2 On `start()`: store `eventBus`, `config` references; subscribe to `schedule:triggered` event filtered by `taskType === 'stale-task-nudge'`; subscribe to `task-management:stale-detect-request` event (for manual triggers from Telegram/API)
  - [ ] 1.3 On `stop()`: unsubscribe from all events, null out all references, clear any in-flight state
  - [ ] 1.4 `handleScheduleTrigger()`: validate event payload, call `runStaleDetection()`
  - [ ] 1.5 Guard against concurrent runs: use a boolean `isRunning` flag; if already running when triggered, log warning and skip

- [ ] Task 2: Fetch all open tasks and detect stale ones (AC: #1)
  - [ ] 2.1 In `runStaleDetection()`: call `agentManager.executeApprovedAction({ actionName: 'ticktick:get-tasks', skillName: 'task-management', details: 'Get all open tasks across all projects. Return JSON array with fields: id, projectId, title, content, priority (0=none,1=low,3=medium,5=high), dueDate, startDate, tags, status, modifiedDate. Use the get_all_tasks or filter_tasks MCP tool.' })`
  - [ ] 2.2 Parse agent result to extract task list JSON. If fetch fails: log error, emit `task-management:stale-detect:failed` event, return
  - [ ] 2.3 Load stale threshold from config: read `config/stale-task-rules.json` for `staleDays` (default: 7). Use Zod `safeParse` for validation
  - [ ] 2.4 Filter tasks: identify tasks where `modifiedDate` (or last activity date) is older than `staleDays` from today. If `modifiedDate` is not available, use `dueDate` being in the past, or task creation date. Handle missing date fields gracefully — skip tasks with no usable date
  - [ ] 2.5 If no stale tasks found: log info, emit completion event with `staleCount: 0`, return early

- [ ] Task 3: Generate AI nudges for stale tasks (AC: #2)
  - [ ] 3.1 Call `agentManager.executeApprovedAction({ actionName: 'ticktick:get-tasks', skillName: 'task-management', details: '<nudge generation prompt with stale task list>' })` — AI agent analyzes all stale tasks and returns structured nudge recommendations
  - [ ] 3.2 The nudge prompt must instruct the agent to return ONLY a JSON array:
    ```json
    [{
      "taskId": "...",
      "projectId": "...",
      "taskTitle": "...",
      "staleDays": 14,
      "suggestedAction": "complete" | "snooze" | "break-down" | "drop" | "do-today",
      "reason": "Brief explanation of why this action is recommended",
      "breakdownSuggestions": ["subtask 1", "subtask 2"]  // only if suggestedAction is "break-down"
    }]
    ```
  - [ ] 3.3 Parse nudge response — extract JSON from result text using defensive parsing (try/catch, regex fallback for JSON extraction, Zod validation per item). If parsing fails, log warning and emit failure event

- [ ] Task 4: Deliver batch notification via Telegram (AC: #3, #4)
  - [ ] 4.1 Format stale tasks into a single batch Telegram message:
    - Header: "🔍 Stale Task Nudge — {count} tasks need attention"
    - For each stale task: `• {title} ({staleDays}d stale) — Suggested: {suggestedAction} — {reason}`
    - Group by suggested action type for readability
  - [ ] 4.2 Include inline keyboard actions per task. Since Telegram inline keyboards can be complex for batch, use the callback data format established in story 3.2:
    - `[Do Today]` → callback: `t:u:{taskId}` (update task priority to high + set due date to today)
    - `[Snooze 1w]` → callback: `t:u:{taskId}` (update task due date to +7 days)
    - `[Break Down]` → callback: `t:bd:{taskId}` (trigger task breakdown — new callback type)
    - `[Drop]` → callback: `t:d:{taskId}` (complete/archive task — yellow tier)
  - [ ] 4.3 For large stale task counts (>5): send summary notification with inline button `[View All Stale Tasks]` instead of individual per-task buttons. The "View All" button uses callback: `t:stale:list`
  - [ ] 4.4 Only emit notification if at least 1 stale task found (skip "0 tasks" notifications)
  - [ ] 4.5 Emit `task-management:stale-detect:completed` event with full detection details

- [ ] Task 5: Create stale-task-rules config file (AC: #1)
  - [ ] 5.1 Create `config/stale-task-rules.json`:
    ```json
    {
      "staleDays": 7,
      "excludeTags": ["someday", "waiting-for"],
      "excludeProjects": [],
      "maxNudgesPerRun": 10
    }
    ```
  - [ ] 5.2 Add Zod schema `StaleTaskRulesSchema` in stale-detector.ts for config validation
  - [ ] 5.3 Listen for `config:reloaded` events to hot-reload rules (same pattern as email-triage config reload)

- [ ] Task 6: Add new event types (AC: all)
  - [ ] 6.1 Add to `packages/shared/src/types/events.ts`: `TaskManagementStaleDetectCompletedEvent` (type: `task-management:stale-detect:completed`, payload: `{ staleCount: number, nudgesSent: number, tasks: Array<{ taskId: string, taskTitle: string, staleDays: number, suggestedAction: string }> }`)
  - [ ] 6.2 Add to `packages/shared/src/types/events.ts`: `TaskManagementStaleDetectFailedEvent` (type: `task-management:stale-detect:failed`, payload: `{ error: string }`)
  - [ ] 6.3 Add to `packages/shared/src/types/events.ts`: `TaskManagementStaleDetectRequestEvent` (type: `task-management:stale-detect-request`, payload: `{ source: 'telegram' | 'api' | 'pipeline', requestId?: string }`)
  - [ ] 6.4 Add Zod validation schemas for all new event payloads
  - [ ] 6.5 Add to `RavenEvent` union type and `RavenEventType`
  - [ ] 6.6 Add constants to `packages/shared/src/suites/constants.ts`: `EVENT_TASK_MGMT_STALE_DETECT_COMPLETED`, `EVENT_TASK_MGMT_STALE_DETECT_FAILED`, `EVENT_TASK_MGMT_STALE_DETECT_REQUEST`
  - [ ] 6.7 Add barrel exports in `packages/shared/src/suites/index.ts`

- [ ] Task 7: Add schedule configuration (AC: #4)
  - [ ] 7.1 Add to `config/schedules.json`: `{ "id": "stale-task-nudge", "name": "Stale Task Nudge", "cron": "0 9 * * *", "taskType": "stale-task-nudge", "skillName": "task-management", "enabled": true }`
  - [ ] 7.2 The schedule runs daily at 9:00 AM (after morning briefing at 8:00 AM) — configurable via schedule API

- [ ] Task 8: Register stale-detector in task-management suite (AC: all)
  - [ ] 8.1 Update `suites/task-management/suite.ts`: add `'stale-detector'` to the `services` array
  - [ ] 8.2 NOTE: Story 4.3 adds the `services` capability and `autonomous-manager` to the suite. This story adds `stale-detector` as an additional service. If 4.3 is already implemented, just append to the existing services array. If 4.3 is NOT yet implemented, you must ALSO add `capabilities: [..., 'services']` and `services: ['stale-detector']`

- [ ] Task 9: Register Telegram inline keyboard callbacks (AC: #3)
  - [ ] 9.1 Check `suites/notifications/services/telegram-bot.ts` for the callback handler pattern established in story 3.2
  - [ ] 9.2 Add handler for `t:bd:{taskId}` callback — "Break Down" action: trigger `agentManager.executeApprovedAction({ actionName: 'ticktick:get-task-details', skillName: 'task-management', details: 'Get task details for {taskId}, then suggest 3-5 subtasks to break it down' })`, then create the subtasks via `ticktick:create-task`
  - [ ] 9.3 Add handler for `t:stale:list` callback — "View All Stale Tasks": trigger `task-management:stale-detect-request` event to re-run detection and send full list
  - [ ] 9.4 IMPORTANT: The existing Telegram bot already handles `t:u:`, `t:d:`, and other task callbacks. Only add NEW callback prefixes (`t:bd:`, `t:stale:`)

- [ ] Task 10: Tests (AC: all)
  - [ ] 10.1 Create `suites/task-management/__tests__/stale-detector.test.ts`
  - [ ] 10.2 Unit tests: event subscription/unsubscription on start/stop, schedule event filtering (only responds to `taskType: 'stale-task-nudge'`)
  - [ ] 10.3 Unit tests: concurrent run guard (second trigger while running → skip with warning log)
  - [ ] 10.4 Integration test: full flow — schedule trigger → task fetch → stale filtering → AI nudge generation → notification → completion event
  - [ ] 10.5 Test stale detection logic: task with modifiedDate 10 days ago (staleDays=7) → identified as stale
  - [ ] 10.6 Test stale detection logic: task with modifiedDate 3 days ago (staleDays=7) → NOT stale
  - [ ] 10.7 Test exclude tags: task with tag "someday" → skipped even if stale
  - [ ] 10.8 Test exclude projects: task in excluded project → skipped even if stale
  - [ ] 10.9 Test maxNudgesPerRun: 15 stale tasks with maxNudgesPerRun=10 → only 10 processed (highest staleDays first)
  - [ ] 10.10 Test no stale tasks: all tasks recent → completion event with staleCount=0, no notification emitted
  - [ ] 10.11 Test task fetch failure: `ticktick:get-tasks` fails → failure event emitted, no crash
  - [ ] 10.12 Test AI nudge generation failure: agent returns invalid JSON → failure event emitted, no crash
  - [ ] 10.13 Test batch notification format: 3 stale tasks → single notification with all tasks listed
  - [ ] 10.14 Test large batch (>5 tasks): summary notification with "View All" button instead of per-task buttons
  - [ ] 10.15 Test manual trigger: `task-management:stale-detect-request` event → same flow as schedule trigger
  - [ ] 10.16 Test config hot-reload: `config:reloaded` event with `configType: 'stale-task-rules'` → rules updated
  - [ ] 10.17 Extend event type tests if needed

## Dev Notes

### Architecture Constraints

- **SuiteService pattern** — export default object with `start(context)/stop()` methods. Same pattern as `autonomous-manager.ts` (story 4.3), `action-extractor.ts`, `email-triage.ts`.
- **Service-direct schedule handling**: The service listens for `schedule:triggered` events directly on the event bus, filtered by `taskType === 'stale-task-nudge'`. The orchestrator's `findSuiteForTaskType()` won't find a matching suite and will log a warning + skip — this is intentional and harmless. Same pattern as story 4.3.
- **No classes** — stale-detector exports a `SuiteService` object, not a class.
- **No direct TickTick API calls** — all operations go through `agentManager.executeApprovedAction()` which spawns ticktick-agent sub-agents with TickTick MCP tools. This preserves MCP isolation.
- **Cross-suite notification**: The service emits `notification` events consumed by the Telegram bot in the notifications suite. No direct import of notification code.
- **Config-driven**: Stale detection rules come from `config/stale-task-rules.json`, validated with Zod, hot-reloadable via `config:reloaded` events.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| TickTick agent | `suites/task-management/agents/ticktick-agent.ts` | **USE** for all task operations via MCP |
| Task management actions | `suites/task-management/actions.json` | **USE** existing tiers: green (get-tasks, get-task-details), yellow (create-task, update-task, complete-task), red (delete-task) |
| Task management suite | `suites/task-management/suite.ts` | **EXTEND** with stale-detector service |
| AgentManager.executeApprovedAction | `packages/core/src/agent-manager/agent-manager.ts` | **USE** for all TickTick operations |
| Permission gate (enforcePermissionGate) | `packages/core/src/agent-manager/agent-session.ts` | **RELIES ON** — automatically enforces tiers on every executeApprovedAction call |
| NotificationEvent | `packages/shared/src/types/events.ts` | **USE** for stale task alerts: `channel`, `title`, `body`, `topicName`, `actions` |
| EventBus | `packages/core/src/event-bus/event-bus.ts` | **USE** subscribe/emit pattern |
| ScheduleTriggeredEvent | `packages/shared/src/types/events.ts` | **USE** for schedule trigger handling |
| Telegram bot callbacks | `suites/notifications/services/telegram-bot.ts` | **EXTEND** with `t:bd:` and `t:stale:` callback handlers |
| Autonomous manager (story 4.3) | `suites/task-management/services/autonomous-manager.ts` | **REFERENCE** — same SuiteService pattern, same executeApprovedAction flow. If 4.3 is done, the `services` capability is already added to suite.ts |
| Action extractor (reference) | `suites/email/services/action-extractor.ts` | **REFERENCE** SuiteService + multi-step executeApprovedAction + JSON parsing + notification pattern |
| Email triage (reference) | `suites/email/services/email-triage.ts` | **REFERENCE** config-driven rules + hot-reload pattern |
| generateId() | `packages/shared/src/utils/id.ts` | **USE** for event IDs |
| createLogger() | `packages/shared/src/utils/logger.ts` | **USE** Pino structured logging |
| Constants | `packages/shared/src/suites/constants.ts` | **EXTEND** with new stale detection event constants |
| ServiceContext / SuiteService | `packages/core/src/suite-registry/service-runner.ts` | **IMPLEMENT** interface for stale-detector service |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | **USE** — fires `schedule:triggered` events via croner |
| Global schedules config | `config/schedules.json` | **EXTEND** with stale-task-nudge schedule entry |

### Stale Detection Flow Architecture

```
config/schedules.json: { taskType: 'stale-task-nudge', cron: '0 9 * * *' }
  │ daily at 9:00 AM
  ▼
Scheduler emits: schedule:triggered { taskType: 'stale-task-nudge' }
  │
  ▼
Stale Detector Service (NEW - suites/task-management/services/stale-detector.ts)
  │ subscribes to: schedule:triggered (filtered by taskType)
  │ also subscribes to: task-management:stale-detect-request (manual trigger)
  │ also subscribes to: config:reloaded (hot-reload rules)
  │
  │ 1. Check isRunning guard → skip if already running
  │
  │ 2. Load rules from config/stale-task-rules.json (cached, Zod-validated)
  │
  │ 3. Fetch all open tasks:
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:get-tasks',
  │      skillName: 'task-management',
  │      details: 'Get all open tasks with modifiedDate. Return JSON array...'
  │    })
  │    → ticktick-agent fetches via TickTick MCP (GREEN tier — silent)
  │
  │ 4. Filter stale tasks:
  │    - modifiedDate older than staleDays (default 7)
  │    - Exclude tasks with tags in excludeTags
  │    - Exclude tasks in excludeProjects
  │    - Limit to maxNudgesPerRun (highest staleDays first)
  │
  │ 5. Generate AI nudges for stale tasks:
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:get-tasks',
  │      skillName: 'task-management',
  │      details: '<nudge prompt with stale task data>'
  │    })
  │    → ticktick-agent analyzes and returns structured nudge JSON (GREEN tier)
  │
  │ 6. Emit: notification {
  │      title: "Stale Task Nudge — N tasks need attention",
  │      body: formatted batch of stale tasks with suggestions,
  │      actions: inline keyboard per task (Do Today, Snooze, Break Down, Drop)
  │    }
  │    → Telegram bot delivers alert with inline keyboards
  │
  │ 7. Emit: task-management:stale-detect:completed { staleCount, nudgesSent, tasks }
  │
  ▼
  Done (async, non-blocking)
```

### AI Nudge Prompt Design

The nudge prompt sent to the ticktick-agent should be:

```
You are analyzing a user's stale TickTick tasks — tasks that have had no activity for an extended period. For each stale task, suggest the best next action and explain why.

Current date: {today}

Stale Tasks:
{JSON stale task list with staleDays calculated}

For each task, recommend ONE primary action. Return ONLY a JSON array, no other text.

Action types:
- "do-today": Task is important and actionable right now — bump priority and set due date to today
- "complete": Task appears to be done already or is no longer relevant — mark as completed
- "snooze": Task is valid but not urgent — push the due date out by 1 week
- "break-down": Task is too large or vague to act on — needs to be split into smaller subtasks
- "drop": Task is clearly obsolete, duplicated, or no longer valuable — recommend removal

Return format:
[
  {
    "taskId": "task ID from the list",
    "projectId": "project ID from the list",
    "taskTitle": "original task title for display",
    "staleDays": 14,
    "suggestedAction": "do-today" | "complete" | "snooze" | "break-down" | "drop",
    "reason": "Brief explanation of why this action is recommended",
    "breakdownSuggestions": ["subtask 1", "subtask 2"]
  }
]

Rules:
- breakdownSuggestions array ONLY for "break-down" actions (3-5 subtasks)
- Be opinionated — the user wants decisive recommendations, not wishy-washy maybes
- If a task has been stale for 30+ days, lean toward "drop" or "complete" unless clearly important
- If a task has a future due date, lean toward "snooze"
- If a task is vague (no description, generic title), lean toward "break-down" or "drop"
```

### Telegram Callback Data Format

Existing callback patterns from story 3.2 (`suites/notifications/services/telegram-bot.ts`):
- `t:l:` — list tasks
- `t:c:{taskId}` — complete task
- `t:u:{taskId}` — update task
- `t:d:{taskId}` — delete task (red tier)

New callbacks for this story:
- `t:bd:{taskId}` — break down task (creates subtasks via AI)
- `t:stale:list` — re-run stale detection and list all stale tasks

The "Do Today" and "Snooze 1w" actions reuse `t:u:{taskId}` with specific parameters embedded in the callback or handled by prompt context in the Telegram bot handler.

**IMPORTANT**: The Telegram bot handler for `t:u:` needs to support parameterized updates. For stale nudge buttons, encode the action type: `t:u:{taskId}:today` (set due today + high priority), `t:u:{taskId}:snooze7` (push due date +7 days). Check how the existing `t:u:` handler works before implementing — it may already support action variants, or you may need to extend it.

### Key Design Decisions

1. **Separate service from autonomous-manager** — Stale detection is a distinct concern from autonomous task management. Different schedule cadence (daily vs every 6 hours), different purpose (surfacing + suggesting vs executing), different user interaction (nudge with choices vs auto-execute). Keeping them separate follows single-responsibility and allows independent enable/disable.

2. **Config-driven stale rules** — `config/stale-task-rules.json` allows the user to tune staleness threshold, exclude specific tags (e.g., "someday" for GTD-style parking), exclude projects, and limit nudge count — all without code changes. Hot-reloadable via `config:reloaded` event.

3. **AI nudge generation** — Rather than simple "this task is stale" notifications, the AI analyzes each stale task's context (title, description, priority, project, age) and recommends a specific action with reasoning. This makes nudges actionable rather than just informational.

4. **Batch notification with size guard** — For ≤5 stale tasks: individual entries with per-task inline buttons. For >5 stale tasks: summary with a "View All" button. Prevents notification message length overflow and keeps notifications scannable.

5. **Two green-tier calls** — Step 3 (fetch tasks) and Step 5 (generate nudges) both use `ticktick:get-tasks` (green-tier). The first fetches raw data via MCP, the second uses the ticktick-agent's reasoning for analysis. Same pattern as story 4.3.

6. **Manual trigger support** — The service listens for `task-management:stale-detect-request` events, allowing users to trigger stale detection from Telegram (via inline button or command) or the API.

### NFR Compliance

- **NFR8:** Service load failure doesn't crash process — follows SuiteService pattern with graceful start/stop
- **NFR9:** Agent task errors caught and reported — all executeApprovedAction calls wrapped in try/catch
- **NFR15:** Event handler returns promptly — heavy work (agent calls) is async, event handler doesn't block event loop
- **NFR18:** All I/O non-blocking — agent tasks queue in agent manager, event emission is fire-and-forget
- **NFR22:** TickTick API failure → failure event emitted, logged, no crash
- **NFR29:** All logging via Pino structured JSON

### Previous Story Learnings (4.3 — Autonomous Task Management)

- **SuiteService pattern** — export default object with `start(context)/stop()`, subscribe to events on start, unsubscribe on stop
- **agentManager via config** — access `config.agentManager` (lazy resolution after boot), NOT direct import
- **Event emission pattern** — use `eventBus.emit()` with generateId(), Date.now() timestamp, typed payload
- **Zod safeParse** — validate event payloads before processing, log and skip on validation failure
- **Error handling** — all error paths must have user-visible feedback (notification) or structured logging. Never swallow.
- **Test patterns** — mock eventBus with vi.fn(), capture event handler references via `on.mock.calls`, verify emission payloads. Mock agentManager as config injection.
- **vi.mock at module scope** — Vitest hoists mocks; put at file top, not in beforeEach
- **AgentManagerLike interface** — define a local interface for the agentManager dependency to avoid circular imports: `interface AgentManagerLike { executeApprovedAction(params: { actionName: string; skillName: string; details?: string; sessionId?: string }): Promise<{ success: boolean; result?: string; error?: string }> }`
- **Concurrent run guard** — simple `isRunning` boolean to prevent overlapping runs
- **Red-tier detection** — `if (!result.success && result.error?.includes('queued'))` → count as queued, not failed
- **JSON parsing** — defensive parsing with regex fallback, Zod validation per item (NOT raw JSON.parse of entire response)
- **Notification emission** — use `emitNotification()` helper with `generateId()`, `Date.now()`, `channel: 'telegram'`, `topicName: 'general'`

### Git Intelligence (Recent Commits)

```
d6b45b4 fix: harden media routing review fixes
84d120d feat: email action item extraction and task creation (story 4.2) + code review fixes
1aaab58 feat: email auto-triage rules (story 4.1) + code review fixes
eaffdd0 chore: eslint ide
cfa21e4 fix: code review fixes for story 3.6 email reply composition
9b831d8 feat: email reply composition from Telegram (story 3.6)
```

Commit message format: `feat: <description> (story X.Y)` — follow for story 4.4.

### Project Structure Notes

- **New files:**
  - `suites/task-management/services/stale-detector.ts` — stale task detection SuiteService
  - `suites/task-management/__tests__/stale-detector.test.ts` — unit + integration tests
  - `config/stale-task-rules.json` — stale detection configuration
- **Modified files:**
  - `packages/shared/src/types/events.ts` — add `TaskManagementStaleDetectCompletedEvent`, `TaskManagementStaleDetectFailedEvent`, `TaskManagementStaleDetectRequestEvent` types + Zod schemas
  - `packages/shared/src/suites/constants.ts` — add `EVENT_TASK_MGMT_STALE_DETECT_COMPLETED`, `EVENT_TASK_MGMT_STALE_DETECT_FAILED`, `EVENT_TASK_MGMT_STALE_DETECT_REQUEST`
  - `packages/shared/src/suites/index.ts` — barrel export new constants
  - `suites/task-management/suite.ts` — add `'stale-detector'` to services array (append if 4.3 already done, add services capability if not)
  - `config/schedules.json` — add stale-task-nudge schedule entry
  - `suites/notifications/services/telegram-bot.ts` — add `t:bd:` and `t:stale:list` callback handlers
- **Alignment:** All new files follow kebab-case naming, SuiteService pattern, ESM imports with `.ts` extensions

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 4, Story 4.4]
- [Source: _bmad-output/planning-artifacts/prd.md — FR36: System surfaces stale tasks (no activity for configurable period) with suggested next steps]
- [Source: _bmad-output/planning-artifacts/architecture.md — Permission gates, MCP isolation, Sub-agent delegation, Scheduler, Event-driven coordination, Config hot-reload]
- [Source: _bmad-output/project-context.md — Critical implementation rules, coding conventions, anti-patterns]
- [Source: _bmad-output/implementation-artifacts/4-3-autonomous-task-management.md — SuiteService pattern, executeApprovedAction, test patterns, code review learnings, JSON parsing]
- [Source: suites/task-management/suite.ts — current suite manifest]
- [Source: suites/task-management/actions.json — ticktick action tiers: green (get-tasks, get-task-details), yellow (create-task, update-task, complete-task), red (delete-task)]
- [Source: suites/task-management/agents/ticktick-agent.ts — TickTick agent definition with MCP tools]
- [Source: suites/email/services/action-extractor.ts — SuiteService + multi-step executeApprovedAction + notification pattern]
- [Source: suites/email/services/email-triage.ts — config-driven rules + hot-reload pattern]
- [Source: suites/notifications/services/telegram-bot.ts — inline keyboard callback handler patterns (t:u:, t:d:, t:c:, t:l:)]
- [Source: packages/core/src/agent-manager/agent-manager.ts — executeApprovedAction for permission-gated operations]
- [Source: packages/core/src/suite-registry/service-runner.ts — SuiteService interface, ServiceContext]
- [Source: packages/core/src/scheduler/scheduler.ts — croner-based scheduler, fires schedule:triggered events]
- [Source: packages/shared/src/types/events.ts — ScheduleTriggeredEvent, NotificationEvent]
- [Source: packages/shared/src/suites/constants.ts — existing suite/agent/event constants]
- [Source: config/schedules.json — existing schedule configuration]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
