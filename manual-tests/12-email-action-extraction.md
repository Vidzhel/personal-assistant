# 12 - Email Action Item Extraction & Task Creation (Story 4.2)

Verify action items are extracted from emails via AI, TickTick tasks are created, Telegram notifications are sent, and retry logic handles failures. These are backend-only tests — no frontend UI.

Prerequisites:
- Backend running (`npm run dev:core` from your own terminal, NOT inside Claude Code)
- Gmail credentials configured and IMAP watcher running
- TickTick credentials configured and verified working
- Telegram bot connected
- Email triage rules active with at least one rule having `"extractActions": true` (e.g., newsletter-archive)
- Verified via `curl http://localhost:4001/api/health`

## Test Cases — Single Action Item Extraction (AC #1)

### EXTRACT-01: Email with one action item creates one TickTick task

**Steps:**
1. Send an email to the monitored Gmail account with a clear single action item in the body, e.g.:
   > "Please send the quarterly report by Friday."
2. Ensure the email matches a triage rule with `"extractActions": true` (e.g., send from an address matching the newsletter rule, or add the sender to a rule)
3. Watch logs for the full pipeline: `email:new` → `email:triage:action-items` → action-extractor processing

**Assertions:**
- Log shows `email:triage:action-items` event received by action-extractor service
- Log shows `executeApprovedAction` called for `gmail:get-email` (green tier — silent email fetch)
- Log shows `executeApprovedAction` called for `gmail:search-emails` with extraction prompt (green tier — AI analysis)
- Log shows extracted action items JSON with 1 item: title, dueDate, priority, context
- Log shows `executeApprovedAction` called for `ticktick:create-task` (yellow tier — notified)
- TickTick app shows new task with title matching the extracted action item
- Task has a due date (if "Friday" was parsed correctly)
- Task has a note referencing the source email (sender + subject)

### EXTRACT-02: Task created with correct metadata

**Steps:**
1. After EXTRACT-01, open the created task in TickTick
2. Verify task fields

**Assertions:**
- Task title is a concise, actionable description (e.g., "Send the quarterly report")
- Task due date is set to the next Friday (if mentioned in email)
- Task priority reflects the extracted priority level
- Task description/note contains reference to source email: sender name and subject line

## Test Cases — Multiple Action Items (AC #2)

### EXTRACT-03: Email with multiple action items creates multiple tasks

**Steps:**
1. Send an email with multiple clear action items, e.g.:
   > "Hi, a few things:
   > 1. Please update the project plan by Monday.
   > 2. Schedule a meeting with the design team this week.
   > 3. Review the budget spreadsheet and send comments."
2. Ensure the email matches a rule with `"extractActions": true`
3. Watch logs for extraction and task creation

**Assertions:**
- Log shows AI extraction returned 3 action items
- Log shows 3 separate `ticktick:create-task` calls
- TickTick app shows 3 new tasks, each with distinct titles
- Each task has appropriate due dates (if specified in the email)
- `email:action-extract:completed` event emitted with `tasksCreated: 3`

### EXTRACT-04: Email with no action items creates no tasks

**Steps:**
1. Send a purely informational email (no tasks, requests, or deadlines), e.g.:
   > "FYI — the server migration completed successfully. No action needed."
2. Ensure the email matches a rule with `"extractActions": true`
3. Watch logs for extraction

**Assertions:**
- Log shows AI extraction returned empty array `[]`
- No `ticktick:create-task` calls made
- No Telegram notification sent (nothing was created)
- `email:action-extract:completed` event emitted with `tasksCreated: 0`

## Test Cases — Telegram Notification (AC #3)

### EXTRACT-05: Notification sent after task creation

**Steps:**
1. Trigger action extraction that creates at least 1 task (e.g., repeat EXTRACT-01)
2. Check Telegram for notification

**Assertions:**
- Telegram notification received with title "Tasks from Email"
- Body includes: "Created N tasks from email: [sender] — [subject]"
- N matches the number of tasks actually created
- Inline keyboard has [View Tasks] button

### EXTRACT-06: View Tasks button works

**Steps:**
1. After receiving notification from EXTRACT-05, tap the [View Tasks] button in Telegram

**Assertions:**
- Button triggers `t:l:` callback (list tasks)
- Telegram responds with task list or task management interface

## Test Cases — Graceful Degradation (AC #4)

### EXTRACT-07: Gmail fetch failure handled gracefully

**Steps:**
1. Temporarily break Gmail credentials or simulate API unavailability
2. Trigger an `email:triage:action-items` event (either via a real email or API):
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "email:triage:action-items", "payload": {"emailId": "test-id-123"}}'
   ```
3. Watch logs for error handling

**Assertions:**
- Log shows error from `gmail:get-email` executeApprovedAction
- Log shows `email:action-extract:failed` event emitted with error details
- Service continues running — no crash
- Subsequent events are still processed when Gmail is restored

### EXTRACT-08: TickTick failure triggers retry queue

**Steps:**
1. Temporarily break TickTick credentials (rename or modify token)
2. Trigger action extraction with an email that has action items
3. Watch logs for retry queue behavior

**Assertions:**
- Log shows `ticktick:create-task` failure
- Log shows item added to retry queue with `attempts: 1`
- After ~5 minutes, log shows retry attempt
- After 3 failed attempts, Telegram notification sent: "Failed to create tasks from email: [sender] — [subject]. Please review manually."
- Notification includes [View Email] button
- Service continues running throughout

### EXTRACT-09: Retry succeeds after transient failure

**Steps:**
1. Break TickTick credentials
2. Trigger action extraction (item enters retry queue)
3. Restore TickTick credentials before retry interval (within 5 minutes)
4. Wait for retry to fire

**Assertions:**
- Log shows retry attempt with restored credentials
- Task creation succeeds on retry
- Item removed from retry queue
- Success notification sent to Telegram

### EXTRACT-10: Partial task creation failure

**Steps:**
1. Trigger extraction of an email with 3 action items
2. Simulate partial failure (e.g., break credentials after first task is created)
3. Watch logs

**Assertions:**
- Log shows some `ticktick:create-task` calls succeeded and some failed
- Only failed items are queued for retry (not all 3)
- Notification reflects partial success: "Created 1 task from email..." (for the succeeded task)
- Retry queue contains only the failed items
