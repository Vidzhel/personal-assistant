# 23 - Urgency Tier Classification & Delivery Timing (Story 7.2)

Verify notification urgency classification, delivery modes (tell-now, tell-when-active, save-for-later), active hours enforcement, and morning briefing batching.

Prerequisites: Backend running (`npm run dev:core`), Telegram bot connected, active hours configured in `config/suites.json` under `notifications.config.activeHours`

## Test Cases — Urgency Classification

### URG-01: Red-tier immediate delivery

**Steps:**
1. trigger a red-tier event: attempt an action that requires approval (permission:blocked)
2. check Telegram → assert:
   - notification delivered immediately regardless of time of day
   - message contains approval request with inline keyboard

### URG-02: System health alert immediate delivery

**Steps:**
1. simulate a system health alert event (e.g. stop a critical service)
2. check Telegram → assert:
   - notification delivered immediately
   - classified as `tell-now`

### URG-03: Insight notification classified as tell-when-active

**Steps:**
1. trigger pattern analysis and wait for high-confidence insight
2. check logs → assert:
   - insight notification classified with `urgencyTier: 'yellow'` or `deliveryMode: 'tell-when-active'`
3. if within active hours: notification delivered
4. if outside active hours: notification queued (see URG-06)

### URG-04: Pipeline completion classified as save-for-later

**Steps:**
1. trigger a pipeline: `POST http://localhost:4001/api/pipelines/morning-briefing/trigger`
2. wait for completion
3. check logs → assert:
   - pipeline completion notification classified as `save-for-later`
   - notification enqueued with `status = 'batched'`
   - NOT delivered immediately via Telegram

### URG-05: Producer override respected

**Steps:**
1. emit a notification event with explicit `urgencyTier: 'red'` and `deliveryMode: 'tell-now'` in payload
2. check logs → assert:
   - classifier respects the producer's override
   - notification delivered immediately regardless of default rules

## Test Cases — Active Hours

### URG-06: Quiet hours hold for tell-when-active

**Steps:**
1. set active hours to a narrow window that excludes current time (e.g. `"start": "03:00", "end": "04:00"`)
2. restart backend
3. trigger an event that would produce a `tell-when-active` notification
4. check logs → assert:
   - notification enqueued with `scheduled_for` set to next active window start
   - NOT delivered via Telegram
5. query DB: `SELECT * FROM notification_queue WHERE delivery_mode = 'tell-when-active' AND status = 'pending'`
6. assert: `scheduled_for` is set to next occurrence of active hours start

### URG-07: Active hours delivery for tell-when-active

**Steps:**
1. set active hours to include current time (e.g. `"start": "00:00", "end": "23:59"`)
2. restart backend
3. trigger a `tell-when-active` notification
4. wait up to 5 minutes (flush interval)
5. check Telegram → assert: notification delivered

### URG-08: Red-tier ignores active hours

**Steps:**
1. set active hours to exclude current time
2. restart backend
3. trigger a red-tier event (permission:blocked)
4. check Telegram → assert:
   - notification delivered immediately
   - active hours NOT enforced for tell-now

## Test Cases — Notification Queue

### URG-09: Queue stores pending notifications

**Steps:**
1. trigger several `tell-when-active` notifications during quiet hours
2. query DB: `SELECT * FROM notification_queue WHERE status = 'pending'`
3. assert:
   - entries exist with correct source, title, body, urgency_tier, delivery_mode
   - `scheduled_for` is populated with ISO timestamp

### URG-10: Queue flush delivers ready items

**Steps:**
1. enqueue a `tell-when-active` notification with `scheduled_for` in the past
2. wait for flush cycle (up to 5 minutes)
3. check Telegram → assert: queued notification delivered
4. query DB → assert: queue entry status changed to `'delivered'`, `delivered_at` populated

### URG-11: Batched items appear in morning briefing

**Steps:**
1. trigger several `save-for-later` notifications (pipeline completions, email triage)
2. query DB: `SELECT * FROM notification_queue WHERE status = 'batched'`
3. assert: batched entries exist
4. trigger morning briefing: `POST http://localhost:4001/api/schedules/morning-briefing/trigger`
5. wait for briefing delivery
6. check Telegram → assert:
   - briefing message includes "Queued Updates" section
   - batched notification summaries listed
7. query DB → assert: batched entries now have `status = 'delivered'`

## Test Cases — Classification Rules Config

### URG-12: Custom rules loaded from config

**Steps:**
1. read: `config/notification-rules.json`
2. assert:
   - JSON array of classification rules
   - each rule has: sourcePattern, urgencyTier, deliveryMode
   - rules cover known sources (permission:blocked, system:health:alert, insight:*, etc.)

### URG-13: Invalid rules handled gracefully

**Steps:**
1. add a malformed entry to `config/notification-rules.json` (e.g. missing urgencyTier)
2. restart backend
3. check logs → assert:
   - warning logged about invalid rule (skipped)
   - valid rules still loaded and functional
4. restore config to valid state

## Test Cases — Event Flow

### URG-14: notification:deliver event triggers Telegram

**Steps:**
1. trigger a `tell-now` notification
2. check logs → assert:
   - `notification` event emitted by producer
   - `delivery-scheduler` intercepts and re-emits as `notification:deliver`
   - `telegram-bot` receives `notification:deliver` and sends message

### URG-15: notification:queued event emitted for deferred items

**Steps:**
1. trigger a `tell-when-active` notification during quiet hours
2. check logs → assert:
   - `notification:queued` event emitted with notification details

### URG-16: notification:batched event emitted for save-for-later

**Steps:**
1. trigger a `save-for-later` notification
2. check logs → assert:
   - `notification:batched` event emitted
