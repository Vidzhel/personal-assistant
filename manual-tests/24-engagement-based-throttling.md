# 24 - Engagement-Based Throttling (Story 7.3)

Verify engagement tracking, throttled notification delivery, escalation re-delivery, insight auto-dismiss, and engagement state recovery.

Prerequisites: Backend running (`npm run dev:core`), Telegram bot connected, notifications suite active, engagement config in `config/suites.json` under `notifications.config`

## Test Cases — Engagement Tracking

### ENG-01: Engagement tracker service starts

**Steps:**
1. start backend: `npm run dev:core`
2. check logs → assert:
   - `engagement-tracker` service started within notifications suite
   - initial engagement state is `normal`

### ENG-02: Notification delivery tracked

**Steps:**
1. trigger several notifications (e.g. trigger pipeline, send chat)
2. query DB: `SELECT * FROM engagement_metrics WHERE event_type = 'notification_delivered' ORDER BY created_at DESC LIMIT 5`
3. assert:
   - entries exist for each delivered notification
   - `created_at` is recent ISO timestamp

### ENG-03: User response tracked

**Steps:**
1. receive a notification in Telegram with inline keyboard
2. tap a button (e.g. `[Useful]` on an insight, or `[Approve]` on an approval)
3. query DB: `SELECT * FROM engagement_metrics WHERE event_type = 'user_response' ORDER BY created_at DESC LIMIT 1`
4. assert:
   - entry exists with recent `created_at`

## Test Cases — Throttling Behavior

### ENG-04: Low engagement triggers throttled state

**Steps:**
1. trigger 5+ notifications without responding to any (let them go unanswered for the configured threshold)
2. wait for engagement state recalculation
3. check logs → assert:
   - `engagement:state-changed` event emitted with `state: 'throttled'`
   - log indicates transition from `normal` to `throttled`

### ENG-05: Throttled state batches non-critical notifications

**Steps:**
1. ensure engagement state is `throttled` (from ENG-04)
2. trigger a `tell-when-active` notification (e.g. agent task completion)
3. check Telegram → assert:
   - notification NOT delivered immediately
   - notification batched instead
4. query DB: `SELECT * FROM notification_queue WHERE status = 'batched' ORDER BY created_at DESC LIMIT 1`
5. assert: entry exists with the notification details

### ENG-06: Tell-now always delivers regardless of throttling

**Steps:**
1. ensure engagement state is `throttled`
2. trigger a red-tier event (permission:blocked / approval needed)
3. check Telegram → assert:
   - notification delivered immediately
   - throttling does NOT apply to `tell-now` items

### ENG-07: Engagement recovery restores normal delivery

**Steps:**
1. ensure engagement state is `throttled`
2. respond to 3+ notifications in Telegram (tap inline keyboard buttons)
3. wait for engagement state recalculation
4. check logs → assert:
   - `engagement:state-changed` event with `state: 'normal'`
5. trigger a new `tell-when-active` notification
6. assert: notification delivered normally (not batched)

## Test Cases — Escalation

### ENG-08: Escalation re-delivers unacknowledged high-priority items

**Steps:**
1. ensure engagement state is `throttled` or normal
2. trigger a `tell-when-active` notification with `urgency_tier: 'yellow'`
3. do NOT respond to it
4. wait 4+ hours (or temporarily set `escalationHours` to a small value like `0.01` for testing)
5. check Telegram → assert:
   - re-delivered notification with "Reminder:" prefix on title
   - original message content preserved
6. query DB: `SELECT status FROM notification_queue WHERE id = '<original_id>'`
7. assert: status is `'escalated'`

### ENG-09: Escalation does not duplicate

**Steps:**
1. after ENG-08, wait another escalation interval
2. check Telegram → assert:
   - no second "Reminder:" message for the same notification
3. query DB → assert: only one escalation event per original notification

### ENG-10: Green-tier items never escalated

**Steps:**
1. trigger a `save-for-later` notification (green tier)
2. leave it unacknowledged for 4+ hours
3. assert: no "Reminder:" re-delivery via Telegram
4. query DB: `SELECT * FROM notification_queue WHERE urgency_tier = 'green' AND status = 'escalated'`
5. assert: no results (green items are never escalated)

### ENG-11: Escalation re-deliveries not counted as new deliveries

**Steps:**
1. trigger an escalation (from ENG-08)
2. query DB: `SELECT * FROM engagement_metrics WHERE event_type = 'notification_delivered' ORDER BY created_at DESC LIMIT 1`
3. assert: the escalation re-delivery is NOT recorded as a new delivery event (would inflate delivery count)

## Test Cases — Insight Auto-Dismiss

### ENG-12: Unacknowledged insights auto-dismissed

**Steps:**
1. trigger pattern analysis → generate insights
2. wait for insights to be delivered via Telegram
3. do NOT tap any buttons on the insight notifications
4. wait 24+ hours (or temporarily set `insightAutoDismissHours` to a small value)
5. trigger pattern analysis again (auto-dismiss runs before processing new insights)
6. query DB: `SELECT * FROM insights WHERE status = 'dismissed'`
7. assert: previously delivered but unacknowledged insights now have `status = 'dismissed'`

### ENG-13: Acknowledged insights not auto-dismissed

**Steps:**
1. trigger pattern analysis → generate insights
2. tap `[Useful]` on an insight notification in Telegram
3. wait 24+ hours, trigger pattern analysis again
4. query DB: `SELECT status FROM insights WHERE id = '<acted_insight_id>'`
5. assert: status remains `'acted'` (not dismissed)

### ENG-14: No follow-up for auto-dismissed insights

**Steps:**
1. after auto-dismiss (ENG-12), check Telegram
2. assert: no follow-up notification sent for dismissed insights

## Test Cases — Configuration

### ENG-15: Engagement thresholds configurable

**Steps:**
1. read: `config/suites.json` under `notifications.config`
2. assert:
   - `lowEngagementThreshold` exists (default 5)
   - `resumeThreshold` exists (default 3)
   - `escalationHours` exists (default 4)
   - `escalationIntervalMinutes` exists
3. read: `config/suites.json` under `proactive-intelligence.config`
4. assert:
   - `insightAutoDismissHours` exists (default 24)
