# Story 7.3: Engagement-Based Throttling

Status: review

## Story

As the system operator,
I want Raven to throttle notifications based on my engagement patterns,
So that I'm not overwhelmed when I'm busy or disengaged.

## Acceptance Criteria

1. **Given** the user has not responded to the last 5 notifications, **When** the engagement tracker detects low engagement, **Then** notification frequency is reduced — only `tell-now` items are delivered, others batch.

2. **Given** a throttled notification is high-priority and unacknowledged for 4 hours, **When** the escalation timer fires, **Then** it is re-delivered with a brief "Reminder:" prefix.

3. **Given** a proactive insight was delivered and the user didn't respond, **When** the next analysis cycle runs, **Then** the insight is marked as "seen/dismissed" — no follow-up is sent.

4. **Given** the user resumes active engagement (responds to 3+ messages), **When** the engagement tracker updates, **Then** normal notification frequency resumes.

## Tasks / Subtasks

- [x] Task 1: Database migration for engagement tracking (AC: 1, 4)
  - [x] 1.1 Create `migrations/010-engagement-tracking.sql` with `engagement_metrics` table
  - [x] 1.2 Add columns/indexes for tracking notification responses and engagement state

- [x] Task 2: Engagement tracker service (AC: 1, 4)
  - [x] 2.1 Create `suites/notifications/services/engagement-tracker.ts` as a SuiteService
  - [x] 2.2 Track notification delivery and user responses (Telegram callback responses, message replies)
  - [x] 2.3 Compute engagement score from recent notification response ratio
  - [x] 2.4 Emit `engagement:state-changed` event when transitioning between `normal` and `throttled`

- [x] Task 3: Integrate throttling into delivery-scheduler (AC: 1, 4)
  - [x] 3.1 Modify `delivery-scheduler.ts` `handleNotification()` to check engagement state
  - [x] 3.2 When throttled: `tell-now` items pass through unchanged, `tell-when-active` and `save-for-later` batch
  - [x] 3.3 When engagement resumes (3+ responses detected): restore normal delivery mode

- [x] Task 4: Escalation timer for throttled high-priority items (AC: 2)
  - [x] 4.1 Add escalation logic in engagement-tracker: periodically scan throttled `tell-when-active` items older than 4 hours with status `pending`
  - [x] 4.2 Re-emit as `notification:deliver` with "Reminder:" prefix on title
  - [x] 4.3 Mark original queue entry to prevent duplicate escalations

- [x] Task 5: Insight auto-dismiss on non-response (AC: 3)
  - [x] 5.1 Modify `insight-processor.ts` to check for unacknowledged delivered insights before processing new ones
  - [x] 5.2 Mark unacknowledged insights (delivered > 24h, no callback response) as `dismissed`
  - [x] 5.3 Do NOT send follow-up notifications for auto-dismissed insights

- [x] Task 6: Shared types and event constants (AC: all)
  - [x] 6.1 Add `EngagementState` type (`'normal' | 'throttled'`) to `events.ts`
  - [x] 6.2 Add event types: `engagement:state-changed`, `notification:escalated`
  - [x] 6.3 Add engagement-related constants to `packages/shared/src/suites/constants.ts`

- [x] Task 7: Configuration (AC: all)
  - [x] 7.1 Add engagement config to `config/suites.json` under `notifications` section
  - [x] 7.2 Configurable thresholds: `lowEngagementThreshold` (5 unresponded), `resumeThreshold` (3 responses), `escalationHours` (4), `insightAutoDissmissHours` (24)

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Unit tests for engagement score computation (normal → throttled → resumed transitions)
  - [x] 8.2 Integration tests for delivery-scheduler throttling behavior
  - [x] 8.3 Tests for escalation timer (4-hour re-delivery with Reminder prefix)
  - [x] 8.4 Tests for insight auto-dismiss logic
  - [x] 8.5 Verify `tell-now` items always pass through regardless of engagement state

## Dev Notes

### Architecture: Suite Service Pattern

This story adds a new service to the existing `notifications` suite (same as delivery-scheduler from 7.2). Follow the established pattern:

- Export `start(context: ServiceContext)` and `stop()` functions
- Subscribe to events in `start()`, clean up in `stop()`
- Access DB via `context.db` (DatabaseInterface) — never import better-sqlite3 directly
- Access event bus via `context.eventBus`
- Load config from `context.config`

**Suite manifest location:** `suites/notifications/suite.ts` — add `engagement-tracker` to the services array.

### Engagement Tracking Strategy

**How to detect user engagement:**

1. **Telegram callback responses** — When a user taps an inline keyboard button (Useful/Dismiss on insights, Approve/Deny on approvals, etc.), the telegram-bot processes the callback. The engagement tracker should subscribe to events emitted by callback actions.

2. **Telegram message responses** — When the user sends any message through Telegram (text, voice, etc.), the bot processes it. The `telegram:message` event or similar can signal active engagement.

3. **Notification delivery tracking** — The `notification_queue` table already tracks `status` and `delivered_at`. Use this to count delivered-but-unacknowledged notifications.

**Key insight:** The existing callback-handler.ts handles domains `task`, `approval`, `email`, `email-reply` — but NOT `insight` callbacks. The insight-processor emits notification actions like `{ action: 'insight:acted:{id}' }` which get set as `callback_data` via `buildInlineKeyboard()` but have NO matching handler in `callback-handler.ts`. This means insight callback responses are currently silently ignored. You need to either:
- Add an `insight` domain to callback-handler.ts (prefix pattern: `i:a:{id}` for acted, `i:d:{id}` for dismissed)
- OR track engagement via a different signal

**Recommended approach:** Add insight callback handling AND use a broader engagement signal. Track any user interaction (callback tap, message sent) as an engagement signal. Store engagement events in a simple table.

### Database Schema Design

```sql
CREATE TABLE engagement_metrics (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,        -- 'notification_delivered' | 'user_response' | 'state_change'
  notification_id TEXT,            -- FK to notification_queue.id (nullable for state changes)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_engagement_created ON engagement_metrics(created_at);
CREATE INDEX idx_engagement_type ON engagement_metrics(event_type);
```

**Engagement state computation:** Query the last N `notification_delivered` events and count how many have a matching `user_response` event with the same `notification_id`. If the ratio of unresponded notifications exceeds the threshold → state = `throttled`.

### Integration with delivery-scheduler.ts

**Current flow (from 7.2):**
```
notification event → handleNotification() → classifyNotification() → route by deliveryMode
```

**New flow with throttling:**
```
notification event → handleNotification() → classifyNotification()
  → IF engagement state is 'throttled':
      → tell-now: pass through (NEVER throttle)
      → tell-when-active: batch instead of schedule
      → save-for-later: batch (unchanged)
  → ELSE: route normally (current behavior)
```

**Implementation:** The engagement-tracker exposes a function like `getEngagementState(): EngagementState` that delivery-scheduler calls synchronously. No async needed — it reads from a module-level variable updated on each engagement event.

### Escalation Timer

Use Croner (already a dependency) to run a periodic check every 15-30 minutes:

1. Query `notification_queue` for items where:
   - `delivery_mode = 'tell-when-active'`
   - `status = 'pending'` (never delivered)
   - `created_at < NOW - 4 hours`
   - `urgency_tier IN ('red', 'yellow')` (only high-priority)
   - No existing escalation marker
2. Re-emit as `notification:deliver` with `title = 'Reminder: ' + original_title`
3. Mark the original queue entry as `status = 'escalated'` to prevent duplicates

**Add `'escalated'` to the status union** in `notification-queue.ts` `QueuedNotification.status`.

### Insight Auto-Dismiss

Modify `insight-processor.ts` `handleTaskComplete()`:

Before processing new insights, query the `insights` table for entries where:
- `status = 'queued'` (delivered but not acted on)
- `delivered_at < NOW - 24 hours`
- Update status to `'dismissed'`

The insight-processor already has `updateInsightStatus()` available from `insight-store.ts`. The `insight-store.ts` has `getInsightsByStatus()` and `updateInsightStatus()` functions.

### Existing Code to Reuse (DO NOT Reinvent)

| What | Where | Use For |
|------|-------|---------|
| `enqueueNotification()` | `notification-queue.ts` | Queue throttled notifications |
| `getReadyNotifications()` | `notification-queue.ts` | Flush ready items |
| `markDelivered()` | `notification-queue.ts` | Mark escalated items |
| `classifyNotification()` | `urgency-classifier.ts` | Classification (unchanged) |
| `insertInsight()`, `findRecentByHash()`, `getInsightsByStatus()`, `updateInsightStatus()` | `insight-store.ts` | Insight lifecycle |
| `computeSuppressionHash()` | `insight-store.ts` | Duplicate detection (unchanged) |
| `ServiceContext`, `SuiteService` | `service-runner.ts` | Service lifecycle |
| `Cron` from `croner` | Already imported in delivery-scheduler | Periodic escalation check |
| `generateId()`, `createLogger()` | `@raven/shared` | ID generation, logging |
| `buildInlineKeyboard()` | `telegram-bot.ts` | If adding insight callback buttons |

### File Structure

**Create:**
- `migrations/010-engagement-tracking.sql`
- `suites/notifications/services/engagement-tracker.ts`
- `packages/core/src/__tests__/engagement-tracker.test.ts` (or `suites/notifications/__tests__/engagement-tracker.test.ts`)

**Modify:**
- `packages/shared/src/types/events.ts` — Add `EngagementState`, engagement event types
- `packages/shared/src/suites/constants.ts` — Add engagement event constants
- `packages/shared/src/suites/index.ts` — Re-export new constants
- `suites/notifications/suite.ts` — Add engagement-tracker service
- `suites/notifications/services/delivery-scheduler.ts` — Check engagement state before routing
- `suites/notifications/services/callback-handler.ts` — Add insight callback domain (optional but recommended)
- `packages/core/src/notification-engine/notification-queue.ts` — Add `'escalated'` status, add escalation query functions
- `suites/proactive-intelligence/services/insight-processor.ts` — Add auto-dismiss logic
- `config/suites.json` — Add engagement config under notifications

### Testing Standards

- Framework: Vitest 4
- Mock `@anthropic-ai/claude-code` — never spawn real subprocesses
- Use temp SQLite DBs (`mkdtempSync`) for isolation, clean up in `afterEach`
- Test file locations: `packages/*/src/__tests__/*.test.ts` or `suites/*/__tests__/*.test.ts`
- Relaxed ESLint rules in test files: `any`, `non-null-assertion`, `console` allowed

### Project Structure Notes

- All files use kebab-case
- TypeScript strict mode, ESM only (`.ts` extensions in imports)
- `rewriteRelativeImportExtensions` in tsconfig rewrites `.ts` → `.js`
- Use `node:` prefix for Node.js builtins
- Pino for logging via `createLogger()`
- No classes except for skills implementing `RavenSkill`
- `crypto.randomUUID()` for ID generation (wrapped as `generateId()`)
- `max-params: 3` enforced — use config objects for functions with many parameters

### Previous Story Intelligence (7.2)

Key learnings from Story 7.2 implementation:
- Event bus ordering: Producers emit `notification`, delivery-scheduler intercepts and re-emits as `notification:deliver`. Telegram bot listens on `notification:deliver`.
- Active hours config in `config/suites.json` under `notifications.config.activeHours`
- Code review caught: approval notifications missing explicit `urgencyTier: 'red'` in payload (was being classified as green). **Lesson:** Always set explicit urgency for safety-critical notifications.
- Code review caught: premature `markDelivered()` call before actual Telegram send. **Lesson:** Only mark status changes after successful side effects.
- The `channel` column was added to `notification_queue` after initial implementation. It defaults to `'telegram'` if null.

### Git Intelligence

Recent commits show pattern analysis engine (7.1) and urgency tiers (7.2) are done. No other in-flight work that could conflict. The codebase follows conventional commit messages: `feat:`, `fix:`, `chore:`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 7, Story 7.3]
- [Source: _bmad-output/planning-artifacts/prd.md — FR52: notification throttling based on engagement]
- [Source: _bmad-output/planning-artifacts/architecture.md — Proactive Intelligence, Friend Protocol]
- [Source: suites/notifications/services/delivery-scheduler.ts — Current notification routing]
- [Source: suites/notifications/services/callback-handler.ts — Callback action routing]
- [Source: suites/proactive-intelligence/services/insight-processor.ts — Insight lifecycle]
- [Source: packages/core/src/notification-engine/notification-queue.ts — Queue CRUD]
- [Source: packages/core/src/insight-engine/insight-store.ts — Insight CRUD]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- All 26 tests pass across 3 test files (engagement-tracker, delivery-scheduler, insight-processor)
- Build clean (shared + core + web + skills)
- ESLint clean on all changed files
- Pre-existing failures in email-triage and knowledge-* tests unrelated to this story

### Completion Notes List

- **Task 1:** Created `migrations/010-engagement-tracking.sql` with `engagement_metrics` table and indexes on `created_at`, `event_type`, `notification_id`
- **Task 2:** Created `engagement-tracker.ts` SuiteService — tracks deliveries/responses in DB, computes engagement state from response ratio, emits `engagement:state-changed` events, exposes synchronous `getEngagementState()` for delivery-scheduler
- **Task 3:** Modified `delivery-scheduler.ts` `handleNotification()` — checks engagement state before routing; when throttled, non-tell-now items forced to `save-for-later` batch mode
- **Task 4:** Escalation timer in engagement-tracker — Croner job scans `notification_queue` for pending tell-when-active items older than `escalationHours` with red/yellow urgency, re-emits with "Reminder:" prefix, marks original as `escalated`
- **Task 5:** Added `autoDismissStaleInsights()` to insight-processor — runs before processing new insights, dismisses queued insights older than `insightAutoDismissHours`
- **Task 6:** Added `EngagementState` type, `EngagementStateChangedEvent`, `NotificationEscalatedEvent` to events.ts; added constants to constants.ts and re-exported from index.ts; added `'escalated'` status + `getEscalationCandidates()`/`markEscalated()` to notification-queue.ts
- **Task 7:** Added engagement config (`lowEngagementThreshold`, `resumeThreshold`, `escalationHours`, `escalationIntervalMinutes`) to `notifications` in suites.json; added `insightAutoDismissHours` to `proactive-intelligence` config
- **Task 8:** 26 tests: 8 engagement-tracker tests (state computation, delivery/response tracking, escalation timer, lifecycle), 9 delivery-scheduler tests (3 new throttling tests), 9 insight-processor tests (2 new auto-dismiss tests)
- **Design decision:** Task 6 (shared types) was implemented before Task 2 as it was a hard dependency. Escalation timer was co-located in engagement-tracker service rather than a separate service, keeping the concern centralized.

### Change Log

- 2026-03-19: Story 7.3 implementation complete — engagement-based throttling with escalation and auto-dismiss

### File List

**Created:**
- `migrations/010-engagement-tracking.sql`
- `suites/notifications/services/engagement-tracker.ts`
- `suites/notifications/__tests__/engagement-tracker.test.ts`

**Modified:**
- `packages/shared/src/types/events.ts`
- `packages/shared/src/suites/constants.ts`
- `packages/shared/src/suites/index.ts`
- `packages/core/src/notification-engine/notification-queue.ts`
- `suites/notifications/suite.ts`
- `suites/notifications/services/delivery-scheduler.ts`
- `suites/notifications/__tests__/delivery-scheduler.test.ts`
- `suites/proactive-intelligence/services/insight-processor.ts`
- `suites/proactive-intelligence/__tests__/insight-processor.test.ts`
- `config/suites.json`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
