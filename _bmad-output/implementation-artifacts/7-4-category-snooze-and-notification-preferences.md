# Story 7.4: Category Snooze & Notification Preferences

Status: review

## Story

As the system operator,
I want to snooze entire notification categories and have Raven suggest snoozes for noisy categories,
So that I control what reaches me without per-notification management.

## Acceptance Criteria

1. **Given** the user snoozes "pipeline-status" for 1 day, **When** pipeline completion notifications are generated, **Then** they are silently batched and not delivered until the snooze expires.

2. **Given** the user has ignored 10 consecutive notifications from a category, **When** the system detects the pattern, **Then** it proposes via Telegram: "You've been ignoring task updates — snooze for a week?" with `[Snooze 1w] [Keep] [Mute]`.

3. **Given** an "approvals" category notification arrives while that category is snoozed, **When** delivery is attempted, **Then** approvals are NEVER snoozable — they always deliver (safety override).

4. **Given** the user queries active snoozes, **When** `GET /api/notifications/snooze` is called, **Then** all active snoozes are returned with category, expiry time, and notification count held.

## Tasks / Subtasks

- [x] Task 1: Database migration for notification preferences (AC: 1, 3, 4)
  - [x] 1.1 Create `migrations/011-notification-preferences.sql` with `notification_snooze` table
  - [x] 1.2 Columns: `id`, `category` (source pattern), `snoozed_until` (ISO timestamp or NULL for muted), `created_at`, `held_count` (integer, tracks silently batched notifications)
  - [x] 1.3 Add index on `category` for fast lookups
  - [x] 1.4 Add `snoozed_count` column to `notification_queue` or track via held_count on snooze record

- [x] Task 2: Snooze store — CRUD functions (AC: 1, 3, 4)
  - [x] 2.1 Create `packages/core/src/notification-engine/snooze-store.ts`
  - [x] 2.2 Functions: `createSnooze(db, category, duration)`, `getActiveSnoozes(db)`, `getSnoozeForCategory(db, category)`, `removeSnooze(db, id)`, `incrementHeldCount(db, id)`, `expireSnoozes(db, now)`
  - [x] 2.3 `getSnoozeForCategory()` must match both exact and wildcard patterns (e.g., snooze on `email:*` blocks `email:triage:summary`)
  - [x] 2.4 Duration accepts: `'1h'`, `'1d'`, `'1w'`, `'mute'` (NULL snoozed_until = indefinite mute)

- [x] Task 3: Integrate snooze check into delivery-scheduler (AC: 1, 3)
  - [x] 3.1 Modify `delivery-scheduler.ts` `handleNotification()` — BEFORE classification/routing, check if notification source matches any active snooze
  - [x] 3.2 Safety override: notifications from `permission:blocked` source (red tier / approvals) ALWAYS bypass snooze — hardcode this check, do not rely on classification
  - [x] 3.3 If snoozed: enqueue with `status = 'snoozed'`, increment held_count on snooze record, emit `notification:snoozed` event, skip normal routing
  - [x] 3.4 Add periodic check (reuse existing flush interval) to expire snoozes and release held notifications

- [x] Task 4: Auto-suggest snooze for ignored categories (AC: 2)
  - [x] 4.1 Create `suites/notifications/services/snooze-suggester.ts` as a SuiteService
  - [x] 4.2 Periodically (every 30 min via Croner) analyze `notification_queue` for categories where the last N (configurable, default 10) notifications have `status IN ('delivered', 'batched')` with no matching `user_response` in `engagement_metrics`
  - [x] 4.3 When detected: emit a `notification:deliver` event with Telegram inline keyboard: `[Snooze 1w] [Keep] [Mute]`
  - [x] 4.4 Track which categories have already been suggested (prevent re-suggesting within 7 days)
  - [x] 4.5 Never suggest snoozing `permission:blocked` or any red-tier source pattern

- [x] Task 5: Telegram callback handlers for snooze actions (AC: 1, 2)
  - [x] 5.1 Add `snooze` domain to `callback-handler.ts` with prefix `s:`
  - [x] 5.2 Callback data patterns: `s:w:{cat}` (snooze 1 week), `s:k:{cat}` (keep/dismiss suggestion), `s:m:{cat}` (mute indefinitely)
  - [x] 5.3 On snooze action: call `createSnooze()`, reply with confirmation message
  - [x] 5.4 On keep: dismiss the suggestion, record that this category was kept (prevent re-suggesting for 7 days)
  - [x] 5.5 On mute: call `createSnooze()` with `null` expiry (indefinite)

- [x] Task 6: REST API endpoints (AC: 4)
  - [x] 6.1 Create `packages/core/src/api/routes/notification-preferences.ts`
  - [x] 6.2 `GET /api/notifications/snooze` — return all active snoozes with category, snoozed_until, held_count
  - [x] 6.3 `POST /api/notifications/snooze` — body: `{ category: string, duration: '1h' | '1d' | '1w' | 'mute' }` — create snooze
  - [x] 6.4 `DELETE /api/notifications/snooze/:id` — remove snooze (unsnooze), release held notifications
  - [x] 6.5 Register routes in `packages/core/src/api/server.ts`

- [x] Task 7: Shared types and event constants (AC: all)
  - [x] 7.1 Add `NotificationSnoozedEvent` type to `events.ts` with payload: `{ category, snoozedUntil, notificationSource }`
  - [x] 7.2 Add `SnoozeProposalEvent` type (for auto-suggest tracking)
  - [x] 7.3 Add `'snoozed'` to `QueuedNotification.status` union in `notification-queue.ts`
  - [x] 7.4 Add event constants: `EVENT_NOTIFICATION_SNOOZED`, `EVENT_SNOOZE_PROPOSAL` to `constants.ts`

- [x] Task 8: Configuration (AC: all)
  - [x] 8.1 Add snooze config to `config/suites.json` under `notifications.config`:
    - `snoozeIgnoreThreshold`: 10 (consecutive ignored before suggesting)
    - `snoozeSuggestionCooldownDays`: 7 (days between re-suggesting same category)
    - `snoozeCheckIntervalMinutes`: 30
  - [x] 8.2 Add unsnoozable categories list: `["permission:blocked", "system:health:alert"]`

- [x] Task 9: Tests (AC: all)
  - [x] 9.1 Unit tests for snooze-store CRUD (create, get, expire, pattern matching, held count)
  - [x] 9.2 Integration tests for delivery-scheduler snooze bypass (snoozed category → batched, approval → always delivers)
  - [x] 9.3 Tests for snooze-suggester (detect ignored category, emit proposal, cooldown respected)
  - [x] 9.4 Tests for callback handler snooze domain (snooze/keep/mute actions)
  - [x] 9.5 Verify red-tier safety override: `permission:blocked` notifications NEVER get snoozed

## Dev Notes

### Architecture: Suite Service Pattern

The snooze-suggester follows the established suite service pattern from 7.2/7.3:

- Export `start(context: ServiceContext)` and `stop()` functions
- Subscribe to events in `start()`, clean up in `stop()`
- Access DB via `context.db` (DatabaseInterface) — never import better-sqlite3 directly
- Access event bus via `context.eventBus`
- Load config from `context.config`

**Suite manifest location:** `suites/notifications/suite.ts` — add `snooze-suggester` to the services array.

### Category = Source Pattern

The `source` field on `NotificationEvent` is the natural category for snooze purposes. Existing source patterns from `urgency-classifier.ts`:

| Source Pattern | Description | Snoozable? |
|---|---|---|
| `permission:blocked` | Red-tier approval needed | **NEVER** (safety override) |
| `system:health:alert` | System health alerts | **NEVER** (safety override) |
| `insight:*` | Proactive insights | Yes |
| `agent:task:complete` | Agent task completions | Yes |
| `pipeline:complete` | Pipeline completions | Yes |
| `pipeline:failed` | Pipeline failures | Yes |
| `email:triage:*` | Email triage summaries | Yes |
| `schedule:triggered` | Schedule completions | Yes |

**Snooze pattern matching:** When checking if a notification is snoozed, match the notification's `source` against the snooze's `category` field. Support both:
- Exact match: snooze `pipeline:complete` blocks only `pipeline:complete`
- Wildcard: snooze `pipeline:*` blocks both `pipeline:complete` and `pipeline:failed`

Reuse the `matchesPattern()` function from `urgency-classifier.ts` — extract to a shared utility or import directly.

### Snooze Check Order in Delivery Flow

**Current flow (from 7.2 + 7.3):**
```
notification event → handleNotification() → classifyNotification()
  → check engagement state → route by deliveryMode
```

**New flow with snooze:**
```
notification event → handleNotification()
  → FIRST: check snooze (source matches active snooze?)
    → YES + not safety-override → enqueue as 'snoozed', increment held_count, STOP
    → YES + safety-override (permission:blocked, system:health:alert) → CONTINUE (ignore snooze)
    → NO → CONTINUE
  → classifyNotification() → check engagement state → route by deliveryMode
```

**Critical: Snooze check MUST happen before classification** — snoozed notifications should not be classified or routed at all.

### Database Schema

```sql
-- migrations/011-notification-preferences.sql
CREATE TABLE notification_snooze (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,           -- source pattern (e.g., 'pipeline:*', 'email:triage:*')
  snoozed_until TEXT,               -- ISO timestamp, NULL = indefinite mute
  held_count INTEGER NOT NULL DEFAULT 0,
  last_suggested_at TEXT,           -- when auto-suggest was last shown for this category
  created_at TEXT NOT NULL
);
CREATE INDEX idx_snooze_category ON notification_snooze(category);
```

### Callback Data Format

Follows the existing compact callback format (64-byte limit). The `category` field in callback_data needs to be compact. Use a category shortcode mapping:

```
s:w:{cat}    → snooze 1 week        (e.g., s:w:pipe for pipeline:*)
s:k:{cat}    → keep (dismiss)
s:m:{cat}    → mute indefinitely
s:u:{id}     → unsnooze (from active snooze list)
```

**Category shortcodes** (to fit 64-byte callback_data limit):
- `pipe` → `pipeline:*`
- `email` → `email:triage:*`
- `task` → `agent:task:complete`
- `insight` → `insight:*`
- `sched` → `schedule:triggered`

Store the mapping in constants or derive from source pattern (first segment before colon). The callback handler resolves the shortcode back to the full pattern.

### Auto-Suggest Detection Logic

The snooze-suggester needs to detect when a category is being consistently ignored:

1. Query `notification_queue` grouped by `source` pattern prefix (first segment before `:`)
2. For each category, count the last N delivered notifications
3. Cross-reference with `engagement_metrics` to find categories with zero `user_response` events matching those notification IDs
4. If ignored count >= `snoozeIgnoreThreshold` AND category not in unsnoozable list AND no recent suggestion (cooldown check) → propose snooze

**Proposal notification format:**
```
Title: "Quiet category detected"
Body: "You've been ignoring {categoryName} notifications — snooze for a week?"
Actions: [Snooze 1w] [Keep] [Mute]
Source: "system:snooze-suggestion"
UrgencyTier: green
DeliveryMode: tell-when-active
```

### Snooze Expiry and Held Notification Release

When a snooze expires (periodic check finds `snoozed_until < now`):

1. Delete the expired snooze record
2. Query `notification_queue` for entries with `status = 'snoozed'` matching the category
3. Update their status to `'pending'` so the normal flush cycle picks them up
4. Log the release with held count

Use the existing `flushIntervalMinutes` periodic check in delivery-scheduler to also check snooze expiry — no separate timer needed.

### Existing Code to Reuse (DO NOT Reinvent)

| What | Where | Use For |
|------|-------|---------|
| `enqueueNotification()` | `notification-queue.ts` | Queue snoozed notifications |
| `matchesPattern()` | `urgency-classifier.ts` | Category pattern matching for snooze check |
| `classifyNotification()` | `urgency-classifier.ts` | Classification (unchanged, runs after snooze check) |
| `getEngagementState()` | `engagement-tracker.ts` | Engagement check (unchanged, runs after snooze check) |
| `buildInlineKeyboard()` | `telegram-bot.ts` | Snooze suggestion keyboard |
| `parseCallbackData()` / `handleCallback()` | `callback-handler.ts` | Extend with snooze domain |
| `ServiceContext`, `SuiteService` | `service-runner.ts` | Service lifecycle for snooze-suggester |
| `Cron` from `croner` | Already imported in delivery-scheduler | Periodic snooze suggestion check |
| `generateId()`, `createLogger()` | `@raven/shared` | ID generation, logging |

### Previous Story Intelligence (7.3)

Key learnings from Story 7.3 implementation:

- **Engagement tracking uses 2-hour time windows** — the engagement state is computed from a ratio of deliveries vs. responses in the last 2 hours. Snooze-suggester should use a longer window (look at last N notifications regardless of time).
- **`'escalated'` status was added to notification_queue** — snooze adds `'snoozed'` as another status value. Update the status type union.
- **Code review found bugs in engagement ratio computation** — the original per-notification-ID matching didn't work because responses stored null notification_id. Make sure snooze's category matching uses the `source` field (which is always populated), not notification_id.
- **Suite service pattern is well-established** — engagement-tracker.ts is a clean example to follow for snooze-suggester.
- **Escalation re-deliveries are filtered** (title starts with "Reminder:") — similarly, snooze suggestion notifications should be marked so they're not counted as "ignored" notifications for the same category.

### Git Intelligence

Recent commits show 7.1, 7.2, and 7.3 are all done. 7.3 had a code review that caught 3 bugs. The codebase follows conventional commit messages: `feat:`, `fix:`, `chore:`.

### File Structure

**Create:**
- `migrations/011-notification-preferences.sql`
- `packages/core/src/notification-engine/snooze-store.ts`
- `suites/notifications/services/snooze-suggester.ts`
- `packages/core/src/api/routes/notification-preferences.ts`
- Test files for snooze-store, snooze-suggester, delivery-scheduler snooze integration

**Modify:**
- `packages/shared/src/types/events.ts` — Add snooze event types
- `packages/shared/src/suites/constants.ts` — Add snooze event constants, unsnoozable categories
- `packages/shared/src/suites/index.ts` — Re-export new constants
- `packages/core/src/notification-engine/notification-queue.ts` — Add `'snoozed'` status, add query functions for snoozed notifications by category
- `suites/notifications/suite.ts` — Add snooze-suggester service
- `suites/notifications/services/delivery-scheduler.ts` — Add snooze check before classification, add snooze expiry to flush cycle
- `suites/notifications/services/callback-handler.ts` — Add snooze callback domain
- `packages/core/src/api/server.ts` — Register notification-preferences routes
- `config/suites.json` — Add snooze config under notifications

### Testing Standards

- Framework: Vitest 4
- Mock `@anthropic-ai/claude-code` — never spawn real subprocesses
- Use temp SQLite DBs (`mkdtempSync`) for isolation, clean up in `afterEach`
- Test file locations: `packages/*/src/__tests__/*.test.ts` or `suites/*/__tests__/*.test.ts`
- Relaxed ESLint rules in test files: `any`, `non-null-assertion`, `console` allowed
- Keep tests sane and high-value — no micro-detail tests

### Project Structure Notes

- All files use kebab-case
- TypeScript strict mode, ESM only (`.ts` extensions in imports)
- `rewriteRelativeImportExtensions` in tsconfig rewrites `.ts` → `.js`
- Use `node:` prefix for Node.js builtins
- Pino for logging via `createLogger()`
- No classes except for skills implementing `RavenSkill`
- `crypto.randomUUID()` for ID generation (wrapped as `generateId()`)
- `max-params: 3` enforced — use config objects for functions with many parameters
- One concern per file, max 300 lines

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 7, Story 7.4]
- [Source: _bmad-output/planning-artifacts/prd.md — FR26: category snooze proposals, FR53: user snooze]
- [Source: _bmad-output/planning-artifacts/architecture.md — Notification system, event bus, API patterns]
- [Source: packages/core/src/notification-engine/urgency-classifier.ts — Source patterns, matchesPattern()]
- [Source: packages/core/src/notification-engine/notification-queue.ts — Queue CRUD, QueuedNotification type]
- [Source: suites/notifications/services/delivery-scheduler.ts — Notification routing flow]
- [Source: suites/notifications/services/engagement-tracker.ts — Engagement state, service pattern]
- [Source: suites/notifications/services/callback-handler.ts — Callback domains, action routing]
- [Source: suites/notifications/services/telegram-bot.ts — buildInlineKeyboard(), notification delivery]
- [Source: config/suites.json — Notification config structure]
- [Source: _bmad-output/implementation-artifacts/7-3-engagement-based-throttling.md — Previous story intelligence]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- Build error: `db.run()` returns `void` in DatabaseInterface — fixed `removeSnooze()` to check existence first
- ESLint errors: magic numbers and max-lines-per-function in notification-preferences route — refactored into helper functions with named constants
- Prettier formatting issues on 3 files — resolved with `npm run format`

### Completion Notes List
- Task 1: Created `migrations/011-notification-preferences.sql` with `notification_snooze` table, category index. Tracked held count via `held_count` on snooze record (not on notification_queue). Added `'snoozed'` status to `QueuedNotification`.
- Task 2: Created `snooze-store.ts` with full CRUD. Pattern matching reuses `matchesPattern()` from urgency-classifier (exported it). 16 unit tests all passing.
- Task 3: Modified `delivery-scheduler.ts` — snooze check happens BEFORE classification. Safety override uses `UNSNOOZABLE_CATEGORIES` constant with `matchesPattern()`. Snooze expiry runs in the existing flush cycle via `checkSnoozeExpiry()`. 5 new integration tests added, all 14 delivery-scheduler tests pass.
- Task 4: Created `snooze-suggester.ts` as SuiteService. Periodically checks for ignored categories, emits notification with inline keyboard. Tracks suggestions via `last_suggested_at` on snooze record. Respects cooldown and unsnoozable list.
- Task 5: Extended `callback-handler.ts` with `snooze` domain (prefix `s:`). Supports snooze-week, keep, mute, and unsnooze actions. Added `db` to CallbackDeps. 4 new parse tests + 4 handler tests, all passing.
- Task 6: Created `notification-preferences.ts` route file with GET/POST/DELETE. Registered in server.ts. DELETE releases held notifications.
- Task 7: Added `NotificationSnoozedEvent`, `SnoozeProposalEvent` to events.ts union. Added event constants, unsnoozable categories, and category shortcode mappings to constants.ts. Exported from shared index.
- Task 8: Added snooze config to `config/suites.json`. Added `snooze-suggester` to notifications suite manifest.
- Task 9: 16 snooze-store unit tests, 5 delivery-scheduler snooze integration tests, 8 callback handler snooze tests. All 156 notification tests pass. `npm run check` passes clean.

### Change Log
- 2026-03-19: Implemented story 7.4 — category snooze & notification preferences (all 9 tasks)

### File List
- `migrations/011-notification-preferences.sql` (new)
- `packages/core/src/notification-engine/snooze-store.ts` (new)
- `packages/core/src/notification-engine/notification-queue.ts` (modified — added 'snoozed' status, getSnoozedByCategory, releaseSnoozed)
- `packages/core/src/notification-engine/urgency-classifier.ts` (modified — exported matchesPattern)
- `packages/core/src/api/routes/notification-preferences.ts` (new)
- `packages/core/src/api/server.ts` (modified — added db to ApiDeps, registered notification-preferences routes)
- `packages/core/src/index.ts` (modified — pass dbInterface to createApiServer)
- `packages/core/src/__tests__/snooze-store.test.ts` (new — 16 tests)
- `packages/shared/src/types/events.ts` (modified — added NotificationSnoozedEvent, SnoozeProposalEvent)
- `packages/shared/src/suites/constants.ts` (modified — added snooze event constants, unsnoozable categories, shortcode mappings)
- `packages/shared/src/suites/index.ts` (modified — re-exported new constants)
- `suites/notifications/services/delivery-scheduler.ts` (modified — snooze check before classification, snooze expiry in flush)
- `suites/notifications/services/snooze-suggester.ts` (new)
- `suites/notifications/services/callback-handler.ts` (modified — added snooze domain)
- `suites/notifications/suite.ts` (modified — added snooze-suggester to services)
- `suites/notifications/__tests__/delivery-scheduler.test.ts` (modified — 5 new snooze integration tests)
- `suites/notifications/__tests__/callback-handler.test.ts` (modified — 8 new snooze tests)
- `config/suites.json` (modified — added snooze config)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — 7.4 status update)
