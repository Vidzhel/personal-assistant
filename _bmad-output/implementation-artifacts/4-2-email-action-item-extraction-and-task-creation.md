# Story 4.2: Email Action Item Extraction & Task Creation

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want action items extracted from emails and turned into TickTick tasks automatically,
So that nothing falls through the cracks.

## Acceptance Criteria

1. **Single Action Item Extraction** — Given an email contains "Please send the report by Friday", When the action item extraction sub-agent processes it, Then a TickTick task is created: "Send the report" with due date Friday and reference to the source email.

2. **Multiple Action Items** — Given an email contains multiple action items, When extraction completes, Then each action item becomes a separate TickTick task.

3. **Yellow-Tier Notification** — Given task creation from email is Yellow-tier, When tasks are created, Then the user is notified via Telegram: "Created 2 tasks from email: [sender] — [subject]".

4. **Graceful Degradation** — Given the TickTick API is unavailable, When task creation fails, Then the action item is queued and retried, and the email is flagged for manual review.

## Tasks / Subtasks

- [x] Task 1: Create action-extractor service skeleton (AC: #1, #2)
  - [x] 1.1 Create `suites/email/services/action-extractor.ts` implementing `SuiteService` pattern (same as email-triage, reply-composer)
  - [x] 1.2 On `start()`: subscribe to `email:triage:action-items` event on eventBus
  - [x] 1.3 On `stop()`: unsubscribe from events, null out references, clear retry queue
  - [x] 1.4 `handleActionItems()`: validate event payload with `EmailTriageActionItemsPayloadSchema.safeParse()`, skip invalid

- [x] Task 2: Fetch full email content (AC: #1)
  - [x] 2.1 In `handleActionItems()`: call `agentManager.executeApprovedAction({ actionName: 'gmail:get-email', skillName: 'email', details: 'Fetch the full email with messageId "<emailId>". Return JSON with fields: from, to, subject, body, date, messageId.' })`
  - [x] 2.2 Parse agent result to get full email body, sender, subject, date
  - [x] 2.3 If fetch fails: log error, emit `email:action-extract:failed` event, return (don't crash)

- [x] Task 3: AI-powered action item extraction (AC: #1, #2)
  - [x] 3.1 Call `agentManager.executeApprovedAction({ actionName: 'gmail:search-emails', skillName: 'email', details: '<extraction prompt>' })` — Use the gmail-agent (green-tier read action) with a prompt that instructs the agent to analyze the email body and extract action items as structured JSON
  - [x] 3.2 The extraction prompt must instruct the agent to return JSON array: `[{ "title": "...", "dueDate": "YYYY-MM-DD" | null, "priority": "low" | "medium" | "high", "context": "..." }]`
  - [x] 3.3 Parse agent response — extract JSON from result text. If parsing fails, log warning and emit failure event
  - [x] 3.4 Filter out non-actionable items (empty titles, vague items like "FYI")

- [x] Task 4: Create TickTick tasks from extracted items (AC: #1, #2, #3)
  - [x] 4.1 For each extracted action item: call `agentManager.executeApprovedAction({ actionName: 'ticktick:create-task', skillName: 'task-management', details: '<task creation prompt>' })`
  - [x] 4.2 Task creation prompt must include: title, due date (if extracted), priority, and context note referencing source email (sender + subject + date)
  - [x] 4.3 Collect results: track how many tasks succeeded vs failed
  - [x] 4.4 If ALL task creations fail: treat as TickTick API unavailable (AC #4)

- [x] Task 5: Success notification via Telegram (AC: #3)
  - [x] 5.1 After all tasks created: emit `notification` event with: title "Tasks from Email", body "Created N tasks from email: [sender] — [subject]", topicName "general"
  - [x] 5.2 Include inline keyboard actions: `[View Tasks]` (callback: `t:l:` to list tasks)
  - [x] 5.3 Emit `email:action-extract:completed` event with payload: `{ emailId, tasksCreated: number, actionItems: string[] }`

- [x] Task 6: Retry queue for TickTick failures (AC: #4)
  - [x] 6.1 Create in-memory retry queue: `Map<string, { emailId: string, items: ActionItem[], attempts: number, lastAttempt: number }>`
  - [x] 6.2 On task creation failure: add to retry queue with attempts=1
  - [x] 6.3 On service start: schedule retry check every 5 minutes using `setInterval`
  - [x] 6.4 Retry logic: for each queued item with `attempts < 3` and `lastAttempt > 60s ago`: attempt task creation again
  - [x] 6.5 After 3 failed attempts: emit notification event flagging email for manual review: "Failed to create tasks from email: [sender] — [subject]. Please review manually." with `[View Email]` action
  - [x] 6.6 Remove from queue after success or max attempts exhausted
  - [x] 6.7 On `stop()`: clear interval, clear queue

- [x] Task 7: Add new event types (AC: all)
  - [x] 7.1 Add to `packages/shared/src/types/events.ts`: `EmailActionExtractCompletedEvent` (type: `email:action-extract:completed`, payload: `{ emailId: string, tasksCreated: number, actionItems: string[] }`)
  - [x] 7.2 Add to `packages/shared/src/types/events.ts`: `EmailActionExtractFailedEvent` (type: `email:action-extract:failed`, payload: `{ emailId: string, error: string }`)
  - [x] 7.3 Add Zod validation schemas for both new event payloads
  - [x] 7.4 Add to `RavenEvent` union type and `RavenEventType`
  - [x] 7.5 Add constants to `packages/shared/src/suites/constants.ts`: `EVENT_EMAIL_ACTION_EXTRACT_COMPLETED`, `EVENT_EMAIL_ACTION_EXTRACT_FAILED`
  - [x] 7.6 Add barrel exports in `packages/shared/src/suites/index.ts`

- [x] Task 8: Register action-extractor in email suite (AC: all)
  - [x] 8.1 Add `'action-extractor'` to `services` array in `suites/email/suite.ts`
  - [x] 8.2 Verify service starts/stops correctly in suite lifecycle

- [x] Task 9: Tests (AC: all)
  - [x] 9.1 Create `suites/email/__tests__/action-extractor.test.ts`
  - [x] 9.2 Unit tests: event subscription/unsubscription on start/stop, payload validation (valid + invalid)
  - [x] 9.3 Integration tests: full flow — email:triage:action-items event → email fetch → extraction → task creation → notification
  - [x] 9.4 Test single action item extraction: email with one clear action item → one TickTick task created
  - [x] 9.5 Test multiple action items: email with 3 action items → 3 separate tasks created
  - [x] 9.6 Test notification: after successful task creation, notification event emitted with correct count and email details
  - [x] 9.7 Test graceful degradation: gmail:get-email fails → failure event emitted, no crash
  - [x] 9.8 Test TickTick failure: ticktick:create-task fails → item queued for retry, notification after max retries
  - [x] 9.9 Test retry queue: verify retry attempts, backoff, max attempts, queue cleanup on stop
  - [x] 9.10 Test edge cases: email with no action items (extraction returns empty), malformed agent response, concurrent extraction events
  - [x] 9.11 Extend event type tests if needed

## Dev Notes

### Architecture Constraints

- **This creates a new service in the `suites/email/` suite** — joins imap-watcher, reply-composer, and email-triage. The action-extractor service processes emails flagged for action item extraction by the triage service.
- **Event-driven pipeline**: `email:triage:action-items` (from triage) → action-extractor service → `gmail:get-email` (fetch full email) → AI extraction → `ticktick:create-task` (for each item) → `notification` event (Telegram) → `email:action-extract:completed` event
- **Cross-suite operation**: This service calls `executeApprovedAction` with BOTH `skillName: 'email'` (to fetch email) AND `skillName: 'task-management'` (to create tasks). The agent-manager handles MCP isolation — each call gets only that suite's MCPs.
- **No direct API calls** — all Gmail and TickTick operations go through `agentManager.executeApprovedAction()` which spawns skill-specific sub-agents. This preserves MCP isolation.
- **No classes** — action-extractor exports a `SuiteService` object with `start()/stop()` methods (same pattern as email-triage, reply-composer).
- **Permission tiers**: `gmail:get-email` (green — silent read), `ticktick:create-task` (yellow — executes and notifies). No red-tier actions needed — task creation is yellow.
- **AI extraction uses gmail-agent** — We re-use `gmail:search-emails` (green-tier) to invoke the gmail-agent with an extraction-focused prompt. The agent reads the email body and returns structured JSON. This avoids creating a new agent definition.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Email triage service | `suites/email/services/email-triage.ts` | **CONSUMES** its `email:triage:action-items` events as trigger |
| Gmail agent | `suites/email/agents/gmail-agent.ts` | **USE** for email fetching and content analysis |
| TickTick agent | `suites/task-management/agents/ticktick-agent.ts` | **USE** for task creation via MCP |
| Email actions | `suites/email/actions.json` | **USE** existing `gmail:get-email` (green), `gmail:search-emails` (green) |
| Task management actions | `suites/task-management/actions.json` | **USE** existing `ticktick:create-task` (yellow) |
| Reply composer | `suites/email/services/reply-composer.ts` | **REFERENCE** SuiteService pattern |
| Email triage | `suites/email/services/email-triage.ts` | **REFERENCE** SuiteService + executeApprovedAction pattern |
| Email suite | `suites/email/suite.ts` | **EXTEND** services array with `'action-extractor'` |
| AgentManager.executeApprovedAction | `packages/core/src/agent-manager/agent-manager.ts` | **USE** for all Gmail and TickTick operations |
| NotificationEvent | `packages/shared/src/types/events.ts` | **USE** for task creation alerts: `channel`, `title`, `body`, `topicName`, `actions` |
| buildInlineKeyboard | `suites/notifications/services/telegram-bot.ts` | **USE** via notification event actions for result buttons |
| EventBus | `packages/core/src/event-bus/event-bus.ts` | **USE** subscribe/emit pattern |
| generateId() | `packages/shared/src/utils/id.ts` | **USE** for event IDs |
| createLogger() | `packages/shared/src/utils/logger.ts` | **USE** Pino structured logging |
| Constants | `packages/shared/src/suites/constants.ts` | **EXTEND** with new action-extract event constants |
| EmailTriageActionItemsPayloadSchema | `packages/shared/src/types/events.ts:394-396` | **USE** for validating incoming events |

### Action Item Extraction Flow Architecture

```
Email Triage Service emits: email:triage:action-items { emailId }
  │
  ▼
Action Extractor Service (NEW - suites/email/services/action-extractor.ts)
  │ subscribes to: email:triage:action-items
  │
  │ 1. Validate event payload with EmailTriageActionItemsPayloadSchema.safeParse()
  │ 2. Fetch full email:
  │    agentManager.executeApprovedAction({
  │      actionName: 'gmail:get-email',
  │      skillName: 'email',
  │      details: 'Fetch email <emailId>, return JSON: from, to, subject, body, date'
  │    })
  │    → gmail-agent fetches via Gmail MCP (GREEN tier — silent)
  │
  │ 3. Extract action items:
  │    agentManager.executeApprovedAction({
  │      actionName: 'gmail:search-emails',
  │      skillName: 'email',
  │      details: 'Analyze this email body and extract action items as JSON array...'
  │    })
  │    → gmail-agent analyzes content, returns structured JSON (GREEN tier — silent)
  │
  │ 4. For each extracted action item:
  │    agentManager.executeApprovedAction({
  │      actionName: 'ticktick:create-task',
  │      skillName: 'task-management',
  │      details: 'Create task: "<title>", due: <date>, priority: <priority>, note: "From email: <sender> - <subject>"'
  │    })
  │    → ticktick-agent creates via TickTick MCP (YELLOW tier — user notified)
  │
  │ 5. Emit: notification { title: "Tasks from Email", body: "Created N tasks from: [sender] — [subject]" }
  │    → Telegram bot delivers alert with [View Tasks] inline keyboard
  │
  │ 6. Emit: email:action-extract:completed { emailId, tasksCreated, actionItems }
  │
  │ ON FAILURE (TickTick unavailable):
  │    → Add to retry queue (max 3 attempts, 60s backoff)
  │    → After max retries: emit notification flagging email for manual review
  │    → Emit: email:action-extract:failed { emailId, error }
  │
  ▼
  Done (async, non-blocking)
```

### AI Extraction Prompt Design

The extraction prompt sent to the gmail-agent should be:

```
Analyze the following email and extract ALL action items — tasks, requests, deadlines, or things the recipient needs to do. Return ONLY a JSON array, no other text.

From: {from}
Subject: {subject}
Date: {date}
Body:
{body}

Return format:
[
  {
    "title": "Short, actionable task title",
    "dueDate": "YYYY-MM-DD" or null if no deadline mentioned,
    "priority": "low" | "medium" | "high" based on urgency/importance,
    "context": "Brief note about why this task exists"
  }
]

Rules:
- Only extract genuine action items (things someone needs to DO)
- Ignore FYI-only content, signatures, disclaimers
- If no action items found, return empty array []
- Due dates: "by Friday" → next Friday's date, "by end of month" → last day of current month, "ASAP" → today
- Priority: "urgent"/"ASAP" → high, normal requests → medium, "when you get a chance" → low
```

### Retry Queue Design

```typescript
interface RetryEntry {
  emailId: string;
  items: Array<{ title: string; dueDate: string | null; priority: string; context: string }>;
  emailMeta: { from: string; subject: string };
  attempts: number;
  lastAttempt: number;
}

// In-memory Map<emailId, RetryEntry>
// Checked every 5 minutes via setInterval
// Max 3 attempts, minimum 60s between attempts
// Cleared on service stop()
```

### Key Design Decisions

1. **Reuse gmail-agent for extraction** — Rather than creating a dedicated "extraction agent", we use the existing gmail-agent (via `gmail:search-emails` green-tier action) with an extraction-focused prompt. The gmail-agent already has Gmail MCP tools and can read email content. This minimizes new agent definitions.

2. **Cross-suite executeApprovedAction** — This service calls both `skillName: 'email'` and `skillName: 'task-management'`. The agent-manager handles MCP isolation per call — gmail-agent gets Gmail MCP, ticktick-agent gets TickTick MCP. No violation of MCP isolation principle.

3. **In-memory retry queue** — Simple `Map` with interval-based retry. No DB persistence for retry state — if the process restarts, the retry queue is lost. This is acceptable because: (a) the email remains in Gmail for manual review, (b) the triage rules will re-trigger on next email check cycle if emails are re-processed, (c) adding DB persistence adds complexity for a rare failure case.

4. **Structured JSON extraction** — The AI agent returns structured JSON. We parse it defensively — if the agent returns invalid JSON, we treat it as "no action items found" and log a warning. This is more robust than free-text parsing.

5. **Separate success/failure events** — `email:action-extract:completed` and `email:action-extract:failed` events allow future components (dashboard, activity feed) to track extraction outcomes without coupling to the service.

6. **Green-tier for extraction** — Email reading/analysis is green-tier (silent). Only task creation is yellow-tier (user notified). The user gets ONE notification with all created tasks, not individual notifications per task.

### NFR Compliance

- **NFR8:** Service load failure doesn't crash process — action-extractor follows SuiteService pattern with graceful start/stop
- **NFR9:** Agent task errors caught and reported — all executeApprovedAction calls wrapped in try/catch
- **NFR15:** Event handler returns promptly — heavy work (agent calls) is async, event handler doesn't block event loop
- **NFR18:** All I/O non-blocking — agent tasks queue in agent manager, event emission is fire-and-forget
- **NFR22:** TickTick API failure → retry queue with max attempts, then flag for manual review
- **NFR29:** All logging via Pino structured JSON

### Previous Story Learnings (4.1 — Email Auto-Triage Rules)

- **SuiteService pattern** — export default object with `start(context)/stop()`, subscribe to events on start, unsubscribe on stop
- **agentManager via config** — access `config.agentManager` (lazy resolution after boot), NOT direct import
- **Event emission pattern** — use `eventBus.emit()` with generateId(), Date.now() timestamp, typed payload
- **Zod safeParse** — validate event payloads before processing, log and skip on validation failure
- **Error handling** — all error paths must have user-visible feedback (notification) or structured logging. Never swallow.
- **Test patterns** — mock eventBus with vi.fn(), capture event handler references via `on.mock.calls`, verify emission payloads. Mock agentManager as config injection.
- **vi.mock at module scope** — Vitest hoists mocks; put at file top, not in beforeEach
- **Code review learnings from 4.1** — H1: config watcher for email-rules doesn't emit events yet (documented, not blocking). H2: use safeParse not unsafe `as` casts for all event payloads. M2: stop() must null out all references.

### Git Intelligence (Recent Commits)

```
1aaab58 feat: email auto-triage rules (story 4.1) + code review fixes
eaffdd0 chore: eslint ide
cfa21e4 fix: code review fixes for story 3.6 email reply composition
9b831d8 feat: email reply composition from Telegram (story 3.6)
21d1103 feat: morning briefing delivery via Telegram (story 3.5) + code review fixes
```

Commit message format: `feat: <description> (story X.Y)` — follow for story 4.2.

### Project Structure Notes

- **New files:**
  - `suites/email/services/action-extractor.ts` — action extraction service (SuiteService)
  - `suites/email/__tests__/action-extractor.test.ts` — unit + integration tests
- **Modified files:**
  - `packages/shared/src/types/events.ts` — add `EmailActionExtractCompletedEvent`, `EmailActionExtractFailedEvent` types + Zod schemas
  - `packages/shared/src/suites/constants.ts` — add `EVENT_EMAIL_ACTION_EXTRACT_COMPLETED`, `EVENT_EMAIL_ACTION_EXTRACT_FAILED`
  - `packages/shared/src/suites/index.ts` — barrel export new constants
  - `suites/email/suite.ts` — add `'action-extractor'` to services array
- **Alignment:** All new files follow kebab-case naming, SuiteService pattern, ESM imports with `.ts` extensions

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 4, Story 4.2]
- [Source: _bmad-output/planning-artifacts/prd.md — FR39: System extracts action items from emails and creates corresponding tasks]
- [Source: _bmad-output/planning-artifacts/architecture.md — MCP Isolation, Sub-agent delegation, Permission gates]
- [Source: _bmad-output/implementation-artifacts/4-1-email-auto-triage-rules.md — email:triage:action-items event, SuiteService pattern, executeApprovedAction usage]
- [Source: suites/email/services/email-triage.ts — emits email:triage:action-items with { emailId }]
- [Source: suites/email/services/reply-composer.ts — SuiteService start/stop pattern reference]
- [Source: suites/email/actions.json — gmail:get-email (green), gmail:search-emails (green)]
- [Source: suites/task-management/actions.json — ticktick:create-task (yellow)]
- [Source: suites/task-management/agents/ticktick-agent.ts — TickTick agent for task creation]
- [Source: suites/email/agents/gmail-agent.ts — Gmail agent for email fetching + analysis]
- [Source: packages/core/src/agent-manager/agent-manager.ts — executeApprovedAction for cross-suite operations]
- [Source: packages/shared/src/types/events.ts — EmailTriageActionItemsEvent, EmailTriageActionItemsPayloadSchema]
- [Source: packages/shared/src/suites/constants.ts — EVENT_EMAIL_TRIAGE_ACTION_ITEMS]
- [Source: _bmad-output/project-context.md — coding conventions, critical rules, anti-patterns]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

None — clean implementation with no blocking issues.

### Completion Notes List

- Implemented action-extractor service following SuiteService pattern (same as email-triage, reply-composer)
- Full event-driven pipeline: `email:triage:action-items` → email fetch → AI extraction → TickTick task creation → Telegram notification
- Cross-suite operation via `executeApprovedAction` with `skillName: 'email'` and `skillName: 'task-management'`
- In-memory retry queue with 5-minute interval, max 3 attempts, 60s backoff
- Defensive JSON parsing for both email fetch results and AI extraction responses
- Used event constants (`EVENT_EMAIL_ACTION_EXTRACT_COMPLETED`, `EVENT_EMAIL_ACTION_EXTRACT_FAILED`) instead of string literals
- 37 tests covering all 4 acceptance criteria, edge cases, and retry mechanics
- All 562 tests pass (40 test files), 0 errors on lint/format/type check
- **Code review fixes (2026-03-15):**
  - [H1] Partial task failure now queues only failed items for retry (previously only all-fail triggered retry)
  - [M1] `createTasksFromItems` returns `{ succeeded: ActionItem[], failed: ActionItem[] }` instead of counts — enables selective retry
  - [M2] `RetryEntry.emailMeta` now includes `date` field — retried task prompts preserve email date context
  - [M3] `parseActionItems` uses Zod `ActionItemSchema` — validates priority enum, dueDate format, and provides defaults
  - [L2] Renamed shadowed `parsed` variable to `emailParsed` in `handleActionItems`
  - Added 4 new tests: partial failure queueing, invalid priority rejection, invalid dueDate rejection, default field values
  - All 566 tests pass (40 test files), 0 errors on lint/format/type check

### Change Log

- 2026-03-15: Story 4.2 implemented — email action item extraction and task creation service
- 2026-03-15: Code review fixes — H1 partial failure, M1-M3 improvements, 4 new tests

### File List

**New files:**
- `suites/email/services/action-extractor.ts` — action extraction SuiteService
- `suites/email/__tests__/action-extractor.test.ts` — 41 unit + integration tests

**Modified files:**
- `packages/shared/src/types/events.ts` — added `EmailActionExtractCompletedEvent`, `EmailActionExtractFailedEvent`, Zod schemas, union members
- `packages/shared/src/suites/constants.ts` — added `EVENT_EMAIL_ACTION_EXTRACT_COMPLETED`, `EVENT_EMAIL_ACTION_EXTRACT_FAILED`
- `packages/shared/src/suites/index.ts` — barrel exports for new constants
- `suites/email/suite.ts` — added `'action-extractor'` to services array
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story status updated
