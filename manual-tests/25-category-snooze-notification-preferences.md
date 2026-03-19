# 25 - Category Snooze & Notification Preferences (Story 7.4)

Verify category snooze CRUD, snooze enforcement in delivery flow, auto-suggest for ignored categories, Telegram callback actions, REST API, and safety overrides.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), Telegram bot connected, some notification history in database

## Test Cases — Snooze API

### SNZ-01: Create snooze via API

**Steps:**
1. POST `http://localhost:4001/api/notifications/snooze` with body: `{ "category": "pipeline:*", "duration": "1d" }`
2. assert:
   - response 200/201 with snooze record (id, category, snoozed_until, held_count: 0)
   - `snoozed_until` is ~24 hours from now

### SNZ-02: Create mute (indefinite snooze) via API

**Steps:**
1. POST `http://localhost:4001/api/notifications/snooze` with body: `{ "category": "email:triage:*", "duration": "mute" }`
2. assert:
   - response with snooze record
   - `snoozed_until` is null (indefinite)

### SNZ-03: List active snoozes via API

**Steps:**
1. create 2-3 snoozes via API (different categories)
2. GET `http://localhost:4001/api/notifications/snooze`
3. assert:
   - response is array of active snoozes
   - each entry has: id, category, snoozed_until, held_count, created_at

### SNZ-04: Remove snooze via API

**Steps:**
1. create a snooze: POST with `{ "category": "pipeline:*", "duration": "1w" }`
2. note the snooze `id`
3. DELETE `http://localhost:4001/api/notifications/snooze/<id>`
4. assert:
   - response confirms deletion
5. GET `http://localhost:4001/api/notifications/snooze`
6. assert: deleted snooze no longer in list

### SNZ-05: Remove snooze releases held notifications

**Steps:**
1. create a snooze on `pipeline:*`
2. trigger 2-3 pipeline completions (notifications get snoozed/held)
3. query DB: `SELECT * FROM notification_queue WHERE status = 'snoozed'`
4. assert: held notifications exist
5. DELETE the snooze via API
6. query DB: `SELECT * FROM notification_queue WHERE status = 'snoozed'`
7. assert: previously snoozed notifications now have `status = 'pending'` (released for delivery)

## Test Cases — Snooze Enforcement

### SNZ-06: Snoozed category notifications silently held

**Steps:**
1. POST snooze: `{ "category": "pipeline:*", "duration": "1d" }`
2. trigger a pipeline: `POST http://localhost:4001/api/pipelines/morning-briefing/trigger`
3. wait for completion
4. check Telegram → assert: NO pipeline completion notification delivered
5. query DB: `SELECT * FROM notification_queue WHERE status = 'snoozed' ORDER BY created_at DESC LIMIT 1`
6. assert: pipeline notification enqueued with `status = 'snoozed'`
7. query DB: `SELECT held_count FROM notification_snooze WHERE category = 'pipeline:*'`
8. assert: `held_count` incremented

### SNZ-07: Exact category match works

**Steps:**
1. POST snooze: `{ "category": "pipeline:complete", "duration": "1d" }`
2. trigger a pipeline completion → assert: notification snoozed
3. trigger a pipeline failure → assert: failure notification delivered normally (not matched by exact snooze)

### SNZ-08: Wildcard category match works

**Steps:**
1. POST snooze: `{ "category": "pipeline:*", "duration": "1d" }`
2. trigger a pipeline completion → assert: snoozed
3. trigger a pipeline failure → assert: also snoozed (wildcard matches both)

### SNZ-09: Approvals NEVER snoozable (safety override)

**Steps:**
1. POST snooze: `{ "category": "permission:*", "duration": "1d" }`
   (or `{ "category": "permission:blocked", "duration": "1d" }`)
2. trigger an action requiring approval (permission:blocked event)
3. check Telegram → assert:
   - approval notification delivered immediately
   - snooze did NOT block the delivery
4. check logs → assert: safety override logged

### SNZ-10: System health alerts NEVER snoozable

**Steps:**
1. POST snooze: `{ "category": "system:*", "duration": "1d" }`
2. trigger a system health alert
3. check Telegram → assert: alert delivered immediately despite snooze

### SNZ-11: Snooze check happens before classification

**Steps:**
1. POST snooze on a category
2. trigger a notification matching that category
3. check logs → assert:
   - snooze check logged BEFORE urgency classification
   - notification short-circuited (not classified or routed)

## Test Cases — Snooze Expiry

### SNZ-12: Expired snooze releases notifications

**Steps:**
1. create a short snooze: `{ "category": "pipeline:*", "duration": "1h" }`
2. trigger pipeline completions (get held)
3. wait for snooze to expire (or adjust time)
4. wait for flush cycle (up to 5 minutes)
5. check logs → assert: snooze expired, held notifications released
6. query DB:
   - `notification_snooze` → expired snooze removed
   - `notification_queue` → previously snoozed items now `status = 'pending'`

### SNZ-13: Muted categories never auto-expire

**Steps:**
1. create a mute: `{ "category": "email:triage:*", "duration": "mute" }`
2. wait through several flush cycles
3. GET `http://localhost:4001/api/notifications/snooze`
4. assert: mute still active (snoozed_until is null, never expires)

## Test Cases — Auto-Suggest Snooze

### SNZ-14: Ignored category triggers suggestion

**Steps:**
1. ensure 10+ notifications from a single category (e.g. `pipeline:complete`) are delivered without any user response
2. wait for snooze-suggester cycle (up to 30 minutes, or check logs)
3. check Telegram → assert:
   - message: "You've been ignoring {category} notifications — snooze for a week?"
   - inline keyboard with `[Snooze 1w]` `[Keep]` `[Mute]` buttons

### SNZ-15: Suggestion cooldown respected

**Steps:**
1. after receiving a snooze suggestion (SNZ-14), tap `[Keep]` (dismiss suggestion)
2. wait for next suggester cycle
3. check Telegram → assert: same category NOT re-suggested (cooldown period, default 7 days)

### SNZ-16: Unsnoozable categories never suggested

**Steps:**
1. generate 10+ unanswered notifications from `permission:blocked` source
2. wait for suggester cycle
3. assert: no snooze suggestion for `permission:blocked` category

## Test Cases — Telegram Callback Actions

### SNZ-17: Snooze 1 week via Telegram

**Steps:**
1. receive snooze suggestion in Telegram (from SNZ-14)
2. tap `[Snooze 1w]`
3. check Telegram → assert: confirmation message (e.g. "Snoozed pipeline notifications for 1 week")
4. GET `http://localhost:4001/api/notifications/snooze`
5. assert: new snooze exists for the category with ~7 day expiry

### SNZ-18: Keep (dismiss suggestion) via Telegram

**Steps:**
1. receive snooze suggestion
2. tap `[Keep]`
3. check Telegram → assert: confirmation (suggestion dismissed)
4. GET `http://localhost:4001/api/notifications/snooze`
5. assert: no snooze created for that category

### SNZ-19: Mute via Telegram

**Steps:**
1. receive snooze suggestion
2. tap `[Mute]`
3. check Telegram → assert: confirmation (category muted indefinitely)
4. GET `http://localhost:4001/api/notifications/snooze`
5. assert: mute exists (snoozed_until is null)
6. trigger notification from that category → assert: held (not delivered)

## Test Cases — Configuration

### SNZ-20: Snooze config in suites.json

**Steps:**
1. read: `config/suites.json` under `notifications.config`
2. assert:
   - `snoozeIgnoreThreshold` exists (default 10)
   - `snoozeSuggestionCooldownDays` exists (default 7)
   - `snoozeCheckIntervalMinutes` exists (default 30)
   - unsnoozable categories list includes `permission:blocked` and `system:health:alert`

## Test Cases — Duration Formats

### SNZ-21: All duration formats accepted

**Steps:**
1. POST snooze with `"duration": "1h"` → assert: `snoozed_until` ~1 hour from now
2. POST snooze with `"duration": "1d"` → assert: `snoozed_until` ~24 hours from now
3. POST snooze with `"duration": "1w"` → assert: `snoozed_until` ~7 days from now
4. POST snooze with `"duration": "mute"` → assert: `snoozed_until` is null
