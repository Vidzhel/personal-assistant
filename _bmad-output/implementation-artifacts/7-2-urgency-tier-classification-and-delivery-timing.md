# Story 7.2: Urgency Tier Classification & Delivery Timing

Status: review

## Story

As the system operator,
I want all outbound notifications classified by urgency and delivered at the right time,
So that important things reach me fast and routine things wait for the right moment.

## Acceptance Criteria

1. **Red-Tier Immediate Delivery** — Given a Red-tier action requires approval, when the notification is classified, then it is `tell-now` and delivered immediately regardless of time.

2. **Yellow-Tier Active-Hours Delivery** — Given a Yellow-tier action completion report, when the notification is classified, then it is `tell-when-active` and held until the user's next interaction or active hours.

3. **Green-Tier Batched Delivery** — Given routine status updates (pipeline completions, email triage summaries), when classified, then they are `save-for-later` and batched into the next morning briefing.

4. **Quiet-Hours Hold** — Given it is 2am and a `tell-when-active` notification is queued, when delivery timing checks user activity, then the notification is held until morning (configurable active hours).

## Tasks / Subtasks

- [x] Task 1: Database migration for notification queue (AC: #2, #3, #4)
  - [x] 1.1: Create migration `migrations/009-notification-queue.sql`
  - [x] 1.2: Create `notification_queue` table (id, source, title, body, topic_name, actions_json, urgency_tier, delivery_mode, status, created_at, scheduled_for, delivered_at)
  - [x] 1.3: Add indexes on status, delivery_mode, scheduled_for

- [x] Task 2: Shared types and constants (AC: #1, #2, #3)
  - [x] 2.1: Add `DeliveryMode` type to `packages/shared/src/types/events.ts`: `'tell-now' | 'tell-when-active' | 'save-for-later'`
  - [x] 2.2: Add optional `urgencyTier` field to `NotificationEvent.payload`: `'red' | 'yellow' | 'green'`
  - [x] 2.3: Add optional `deliveryMode` field to `NotificationEvent.payload`: `DeliveryMode`
  - [x] 2.4: Add notification queue event types: `notification:queued`, `notification:delivered`, `notification:batched`
  - [x] 2.5: Add suite constants: `SERVICE_DELIVERY_SCHEDULER` to `packages/shared/src/suites/constants.ts`
  - [x] 2.6: Export from shared barrel

- [x] Task 3: Notification queue store (AC: #2, #3, #4)
  - [x] 3.1: Create `packages/core/src/notification-engine/notification-queue.ts`
  - [x] 3.2: Implement `enqueueNotification()`, `getReadyNotifications()`, `getPendingBatched()`, `markDelivered()`, `markBatched()`
  - [x] 3.3: `getReadyNotifications()` returns `tell-when-active` items where `scheduled_for <= now` and status is `pending`

- [x] Task 4: Urgency classifier (AC: #1, #2, #3)
  - [x] 4.1: Create `packages/core/src/notification-engine/urgency-classifier.ts`
  - [x] 4.2: Implement `classifyNotification(event: NotificationEvent): { urgencyTier, deliveryMode }` — if the event already has `urgencyTier`/`deliveryMode` set, respect it (producer override)
  - [x] 4.3: Default classification rules: permission-blocked/approval events → `tell-now`; system:health:alert → `tell-now`; insight:* → `tell-when-active`; agent:task:complete → `tell-when-active`; pipeline/schedule completions → `save-for-later`
  - [x] 4.4: Load classification overrides from `config/notification-rules.json` (source pattern → urgencyTier mapping)

- [x] Task 5: Delivery scheduler service (AC: #1, #2, #3, #4)
  - [x] 5.1: Create `suites/notifications/services/delivery-scheduler.ts`
  - [x] 5.2: Intercept `notification` events BEFORE the existing telegram-bot handler
  - [x] 5.3: `tell-now` → re-emit as `notification:deliver` (immediate passthrough)
  - [x] 5.4: `tell-when-active` → enqueue with `scheduled_for` = next active window start; emit `notification:queued`
  - [x] 5.5: `save-for-later` → enqueue with status `batched`; emit `notification:batched`
  - [x] 5.6: Run a periodic check (Croner, every 5 minutes) to flush `tell-when-active` items whose scheduled_for has passed → emit `notification:deliver`
  - [x] 5.7: Active hours config: load from `config/suites.json` under `notifications.config.activeHours` (default: `{ start: "07:00", end: "23:00", timezone: "America/New_York" }`)

- [x] Task 6: Wire telegram-bot to new delivery event (AC: #1, #2, #3)
  - [x] 6.1: Change telegram-bot.ts to listen on `notification:deliver` instead of `notification`
  - [x] 6.2: Keep the same delivery logic (topic routing, inline keyboards, fallback)
  - [x] 6.3: Update notification queue status to `delivered` after successful send

- [x] Task 7: Morning briefing integration for batched items (AC: #3)
  - [x] 7.1: In daily-briefing's briefing-formatter.ts, add a section that queries `notification_queue` for items with status `batched` and `delivery_mode = 'save-for-later'`
  - [x] 7.2: Format batched notifications as a "Queued Updates" section in the morning briefing
  - [x] 7.3: Mark those items as `delivered` after briefing is sent

- [x] Task 8: Configuration file (AC: #4)
  - [x] 8.1: Create `config/notification-rules.json` with default classification rules
  - [x] 8.2: Add `activeHours` config to notifications suite in `config/suites.json`

- [x] Task 9: Tests (AC: #1, #2, #3, #4)
  - [x] 9.1: Unit test: urgency classifier — default rules produce correct tier/mode for each event source
  - [x] 9.2: Unit test: urgency classifier — producer override respected when urgencyTier is pre-set
  - [x] 9.3: Integration test: notification-queue CRUD with temp SQLite
  - [x] 9.4: Unit test: delivery scheduler — tell-now events pass through immediately
  - [x] 9.5: Unit test: delivery scheduler — tell-when-active queued during quiet hours, released at active window
  - [x] 9.6: Unit test: delivery scheduler — save-for-later items enqueued as batched
  - [x] 9.7: Integration test: end-to-end flow — notification event → classify → queue → deliver

## Dev Notes

### Architecture: Suite Service Pattern

This story adds a new service (`delivery-scheduler`) to the existing `notifications` suite. It does NOT create a new suite. The delivery scheduler sits between notification producers and the Telegram bot — intercepting `notification` events, classifying urgency, and routing to immediate delivery or queue.

**Modified flow:**
```
Producer emits 'notification' event
  → delivery-scheduler intercepts
  → urgency-classifier determines tier + delivery mode
  → tell-now: re-emit as 'notification:deliver' (immediate)
  → tell-when-active: enqueue in notification_queue table, schedule for next active window
  → save-for-later: enqueue with status 'batched' for morning briefing pickup
  → Periodic flush (every 5 min): check queue for ready items → emit 'notification:deliver'
  → telegram-bot.ts listens on 'notification:deliver' instead of 'notification'
```

### Event Bus Ordering: Critical Design Decision

The event bus is fire-and-forget with no guaranteed ordering. To ensure the delivery-scheduler processes `notification` events BEFORE the telegram-bot, use **event renaming**:
- Producers keep emitting `notification` events (no changes to existing code)
- `delivery-scheduler` subscribes to `notification`, classifies, and re-emits as `notification:deliver`
- `telegram-bot.ts` is changed to subscribe to `notification:deliver` instead of `notification`
- This ensures classification always happens before delivery — no race conditions

### Database: New `notification_queue` Table

```sql
CREATE TABLE notification_queue (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  topic_name TEXT,
  actions_json TEXT,
  urgency_tier TEXT NOT NULL,         -- 'red' | 'yellow' | 'green'
  delivery_mode TEXT NOT NULL,        -- 'tell-now' | 'tell-when-active' | 'save-for-later'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'delivered' | 'batched' | 'expired'
  created_at TEXT NOT NULL,
  scheduled_for TEXT,                 -- ISO 8601: when to deliver (null for tell-now)
  delivered_at TEXT
);
CREATE INDEX idx_notification_queue_status ON notification_queue(status);
CREATE INDEX idx_notification_queue_delivery_mode ON notification_queue(delivery_mode);
CREATE INDEX idx_notification_queue_scheduled_for ON notification_queue(scheduled_for);
```

- `tell-now` items are NOT queued (pass through immediately, no DB write needed)
- `tell-when-active` items get `status: 'pending'`, `scheduled_for: <next active window start>`
- `save-for-later` items get `status: 'batched'`, no `scheduled_for` (picked up by morning briefing)
- Status transitions: `pending → delivered`, `batched → delivered`

### Urgency Classification Rules

Default mapping (configurable via `config/notification-rules.json`):

| Source / Event Type | Urgency Tier | Delivery Mode | Rationale |
|---|---|---|---|
| `permission:blocked` (approval needed) | Red | `tell-now` | Red-tier actions need immediate approval |
| `system:health:alert` | Red | `tell-now` | System issues need immediate attention |
| `insight:generated` (confidence ≥ 0.8) | Yellow | `tell-when-active` | High-confidence insights are timely |
| `insight:generated` (confidence < 0.8) | Green | `save-for-later` | Lower-confidence insights can wait |
| `agent:task:complete` | Yellow | `tell-when-active` | Task results are useful but not urgent |
| Pipeline completion | Green | `save-for-later` | Routine automation status |
| Email triage summary | Green | `save-for-later` | Batch into morning briefing |
| Explicit `urgencyTier` in payload | (use payload) | (use payload) | Producer knows best |

The classifier function signature:
```typescript
function classifyNotification(
  event: NotificationEvent,
  rules: ClassificationRule[],
): { urgencyTier: 'red' | 'yellow' | 'green'; deliveryMode: DeliveryMode }
```

If the notification already has `urgencyTier` and/or `deliveryMode` set in the payload, the classifier MUST respect those values (producer override). This allows any producer to explicitly control delivery when needed.

### Active Hours Configuration

```json
// In config/suites.json under "notifications"
{
  "notifications": {
    "enabled": true,
    "config": {
      "activeHours": {
        "start": "07:00",
        "end": "23:00",
        "timezone": "America/New_York"
      },
      "flushIntervalMinutes": 5
    }
  }
}
```

- `tell-when-active` items queued outside active hours get `scheduled_for` = next day's `start` time
- `tell-when-active` items queued during active hours get `scheduled_for` = now (immediate flush on next cycle)
- Red-tier (`tell-now`) items ALWAYS deliver immediately regardless of active hours — this is a hard safety rule

### Integration Points — Existing Code to Modify

| File | Change | Why |
|---|---|---|
| `suites/notifications/services/telegram-bot.ts` | Subscribe to `notification:deliver` instead of `notification` | Delivery scheduler intercepts first |
| `suites/notifications/suite.ts` | Add `'delivery-scheduler'` to services array | Register new service |
| `suites/daily-briefing/services/briefing-formatter.ts` | Query notification_queue for batched items, add "Queued Updates" section | Morning briefing picks up save-for-later items |
| `packages/shared/src/types/events.ts` | Add DeliveryMode type, urgencyTier/deliveryMode to NotificationEvent, add notification:deliver/queued/batched events | Type definitions |
| `packages/shared/src/suites/constants.ts` | Add SERVICE_DELIVERY_SCHEDULER, notification event constants | Constants |
| `config/suites.json` | Add activeHours config under notifications | Configuration |

### Existing Code to Reuse

| What | Where | How |
|---|---|---|
| Event bus | `ServiceContext.eventBus` | Subscribe/emit notification events |
| Database | `ServiceContext.db` (DatabaseInterface) | Query/insert notification_queue |
| Croner scheduling | Already imported in scheduler | Use for periodic flush |
| Notification event type | `packages/shared/src/types/events.ts` | Extend with urgency fields |
| Telegram delivery | `telegram-bot.ts` sendMessageWithFallback | Unchanged, just different trigger event |
| Morning briefing | `briefing-formatter.ts` | Add section for batched notifications |
| Permission tiers | `packages/core/src/permission-engine/` | Map Red/Yellow/Green → delivery modes |
| Insight processor | `suites/proactive-intelligence/services/insight-processor.ts` | Currently emits `notification` with no urgency — will be auto-classified |
| Config loading | Suite config pattern from `config/suites.json` | Same pattern for activeHours |

### What NOT to Build

- **No engagement-based throttling** — that's Story 7.3
- **No category snooze** — that's Story 7.4
- **No new API endpoints** — this is internal infrastructure only
- **No frontend changes** — delivery timing is backend-only
- **No changes to notification producers** — existing code continues emitting `notification` events unchanged; the classifier handles everything
- **No MCP servers** — pure service logic

### Previous Story Intelligence (7.1)

Key learnings from Story 7.1 implementation:

- **Suite pattern**: Follow `suites/proactive-intelligence/` structure — `suite.ts` manifest, `services/*.ts` for long-running services
- **Service lifecycle**: Services must export `start(context: ServiceContext)` and `stop()` functions
- **Event subscription**: Use `context.eventBus.on('event-type', handler)` in service `start()`
- **Database access**: Use `context.db` from ServiceContext, never import better-sqlite3 directly
- **Croner for periodic tasks**: Already used by scheduler and suites — import and create cron jobs in service `start()`, stop in `stop()`
- **Test approach**: Integration tests with temp SQLite (mkdtempSync), unit tests for classification logic, mock eventBus for service tests
- **Neo4j safety**: When querying Neo4j, always wrap LIMIT with `toInteger()` and round topK with `Math.round()` — not directly relevant here but good practice
- **Null-coalescing**: Always null-coalesce properties from external data before storing

### Git Intelligence

- Commit style: `feat:` for new features, `fix:` for bugs
- Co-author line: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Story 7.1 was the most recent feature work — this builds directly on it
- All tests must pass before committing: `npm test`
- Lint must pass: `npm run check`

### Project Structure Notes

New files to create:
```
migrations/009-notification-queue.sql
packages/core/src/notification-engine/notification-queue.ts
packages/core/src/notification-engine/urgency-classifier.ts
suites/notifications/services/delivery-scheduler.ts
config/notification-rules.json
```

Modified files:
```
packages/shared/src/types/events.ts           # Add DeliveryMode, urgencyTier, notification:deliver event
packages/shared/src/suites/constants.ts        # Add delivery scheduler constants
packages/shared/src/suites/index.ts            # Re-export if needed
suites/notifications/suite.ts                  # Add delivery-scheduler to services
suites/notifications/services/telegram-bot.ts  # Subscribe to notification:deliver instead
suites/daily-briefing/services/briefing-formatter.ts  # Add batched notification section
config/suites.json                             # Add activeHours config
```

Test files to create:
```
packages/core/src/__tests__/notification-queue.test.ts
packages/core/src/__tests__/urgency-classifier.test.ts
suites/notifications/__tests__/delivery-scheduler.test.ts
```

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 7, Story 7.2]
- [Source: _bmad-output/planning-artifacts/architecture.md — Event Bus, Notification Delivery, Permission Tiers]
- [Source: _bmad-output/planning-artifacts/prd.md — FR25 (urgency tiers), FR51 (notification classification)]
- [Source: suites/notifications/services/telegram-bot.ts — Current notification delivery (lines 620-646)]
- [Source: suites/daily-briefing/services/briefing-formatter.ts — Morning briefing batching pattern]
- [Source: suites/proactive-intelligence/services/insight-processor.ts — Notification emission pattern (lines 174-189)]
- [Source: packages/shared/src/types/events.ts — NotificationEvent interface (lines 98-107)]
- [Source: _bmad-output/implementation-artifacts/7-1-background-pattern-analysis-engine.md — Previous story patterns]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- Fixed telegram-bot.test.ts mock: added `createLogger` to `@raven/shared` mock since `notification-queue.ts` import pulls it in
- Fixed telegram-bot.test.ts event handlers: `notification` → `notification:deliver` to match implementation change
- Fixed delivery-scheduler.test.ts Cron mock: must use a class (not fn) for `new Cron()` constructor

### Code Review Fixes Applied

- **CRITICAL FIX:** Added `urgencyTier: 'red', deliveryMode: 'tell-now'` to permission:blocked notification payload in telegram-bot.ts — approval notifications were being classified as green/save-for-later instead of immediate delivery
- **HIGH FIX:** Removed premature `markDelivered()` call from `flushReadyNotifications()` in delivery-scheduler.ts — queue items were marked delivered before Telegram actually sent them
- **MEDIUM FIX:** Added `channel` column to notification_queue table and plumbed through enqueue/query/flush — original channel was lost on queued notifications, hardcoded to 'telegram'
- **MEDIUM FIX:** Added field validation to `loadClassificationRules()` in urgency-classifier.ts — malformed rules JSON no longer causes runtime errors, invalid rules are skipped with warning

### Completion Notes List

- Task 1: Created `migrations/009-notification-queue.sql` — notification_queue table with 3 indexes
- Task 2: Added `DeliveryMode`, `UrgencyTier` types, `NotificationDeliverEvent`, `NotificationQueuedEvent`, `NotificationBatchedEvent` to shared types. Added `SERVICE_DELIVERY_SCHEDULER` and event constants to constants.ts. All exported via barrel.
- Task 3: Created `notification-queue.ts` with `enqueueNotification()`, `getReadyNotifications()`, `getPendingBatched()`, `markDelivered()`, `markBatched()` — all using DatabaseInterface
- Task 4: Created `urgency-classifier.ts` with `classifyNotification()` supporting producer override, default rules, wildcard source matching, and conditional rules (confidence thresholds for insights)
- Task 5: Created `delivery-scheduler.ts` suite service — intercepts `notification` events, classifies urgency, routes to tell-now (passthrough), tell-when-active (queue with scheduled_for), or save-for-later (batched). Croner flush every 5 minutes. Active hours config from suites.json.
- Task 6: Changed telegram-bot.ts to subscribe to `notification:deliver` instead of `notification`. Added `markDelivered()` call after successful Telegram send for queued items. Added `dbRef` for database access.
- Task 7: Updated briefing-formatter.ts to query batched notifications from notification_queue and include as "Queued Updates" section in morning briefing. Marks items delivered after briefing sent.
- Task 8: Created `config/notification-rules.json` with default classification rules. Added `activeHours` and `flushIntervalMinutes` to notifications suite config in `config/suites.json`.
- Task 9: 29 tests total — 15 urgency-classifier unit tests, 8 notification-queue integration tests, 6 delivery-scheduler service tests. All pass. Also fixed existing telegram-bot tests (47 tests) to work with notification:deliver change.
- Net test result: 791 passed (up from 785), 7 pre-existing failures (knowledge/email-triage), 0 new regressions
- `npm run check` passes clean (format, lint, tsc, strip-types)

### File List

New files:
- migrations/009-notification-queue.sql
- packages/core/src/notification-engine/notification-queue.ts
- packages/core/src/notification-engine/urgency-classifier.ts
- suites/notifications/services/delivery-scheduler.ts
- config/notification-rules.json
- packages/core/src/__tests__/urgency-classifier.test.ts
- packages/core/src/__tests__/notification-queue.test.ts
- suites/notifications/__tests__/delivery-scheduler.test.ts

Modified files:
- packages/shared/src/types/events.ts
- packages/shared/src/suites/constants.ts
- packages/shared/src/suites/index.ts
- suites/notifications/suite.ts
- suites/notifications/services/telegram-bot.ts
- suites/notifications/__tests__/telegram-bot.test.ts
- suites/daily-briefing/services/briefing-formatter.ts
- config/suites.json
- _bmad-output/implementation-artifacts/sprint-status.yaml
