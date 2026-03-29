# 14 - Schedules & Notifications (v2)

Validates template scheduling (cron triggers), notification delivery, urgency classification, and engagement tracking.

Prerequisites: Both servers running, at least one schedule defined

## Test Cases — Schedule API

### SCHED-01: List schedules

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules`
2. assert response:
   - status 200
   - JSON array returned
   - each schedule has: cron expression, template reference, enabled flag

### SCHED-02: Schedule references valid template

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules`
2. for each schedule, note its `template` field
3. curl: `GET http://localhost:4001/api/templates/{templateName}`
4. assert: template exists (status 200)

### SCHED-03: Schedules page displays correctly

**Steps:**
1. navigate: `http://localhost:4000/schedules`
2. snapshot → assert:
   - heading "Schedules"
   - schedule cards with: name, cron expression, template name
   - enabled/disabled toggle or badge
   - next run time displayed

### SCHED-04: Schedule count matches dashboard

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules` → note length
2. navigate: `http://localhost:4000` → read "Schedules" card
3. assert: counts match

## Test Cases — Notification Delivery

### SCHED-05: Event timeline shows notifications

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. assert: events displayed chronologically (newest first)
3. assert: notification events show source badge and description
4. assert: filter dropdowns for source and type work

### SCHED-06: Activity page polling

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. open Network tab
3. wait: 15s
4. assert: at least 2 event poll requests visible

### SCHED-07: Notification preferences — snooze a category

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/notifications/snooze \
     -H "Content-Type: application/json" \
     -d '{"category": "digest", "duration": "1h"}'
   ```
2. assert: status 200
3. curl: `GET http://localhost:4001/api/notifications/snooze`
4. assert: "digest" category appears in active snoozes

### SCHED-08: Snoozed notifications are held

**Steps:**
1. snooze "digest" category (from SCHED-07)
2. trigger a digest notification
3. assert: notification NOT delivered immediately
4. assert: notification held until snooze expires

### SCHED-09: Approvals and system health never snoozable

**Steps:**
1. attempt to snooze "approval" category
2. assert: error — approvals are not snoozable
3. attempt to snooze "system-health" category
4. assert: error — system health alerts are not snoozable

## Test Cases — Settings Page

### SCHED-10: Settings page displays system info

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. snapshot → assert:
   - heading "Settings"
   - System info card (API URL, uptime, version)
   - Configuration section
