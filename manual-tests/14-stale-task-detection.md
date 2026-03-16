# 14 - Stale Task Detection & Nudging (Story 4.4)

Verify stale task detection based on configurable thresholds, AI-generated nudge suggestions, batch Telegram notifications with inline actions, config hot-reload, and exclusion rules. These are backend-only tests — no frontend UI.

Prerequisites:
- Backend running (`npm run dev:core` from your own terminal, NOT inside Claude Code)
- TickTick credentials configured and verified working
- TickTick has tasks with varying ages: some modified >7 days ago (stale), some recently modified (fresh)
- Telegram bot connected
- `config/stale-task-rules.json` exists with default settings (`staleDays: 7`)
- Schedule `stale-task-nudge` exists in `config/schedules.json` (cron: `0 9 * * *`)
- Verified via `curl http://localhost:4001/api/health`

## Test Cases — Stale Task Detection (AC #1)

### STALE-01: Manual trigger detects stale tasks

**Steps:**
1. Ensure TickTick has at least 2-3 tasks not modified in >7 days
2. Trigger stale detection manually:
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:stale-detect-request", "payload": {"source": "api"}}'
   ```
3. Watch terminal logs for the full detection cycle

**Assertions:**
- Log shows `task-management:stale-detect-request` event received by stale-detector service
- Log shows `executeApprovedAction` called for `ticktick:get-tasks` (green tier — silent fetch)
- Log shows task list fetched with task count
- Log shows stale task filtering: tasks with `modifiedDate` older than 7 days identified
- Log shows stale task count (should match tasks >7 days old)

### STALE-02: Fresh tasks are not flagged as stale

**Steps:**
1. Create a new task in TickTick (will have today's modifiedDate)
2. Trigger stale detection (STALE-01 method)
3. Watch logs

**Assertions:**
- Newly created task does NOT appear in the stale task list
- Only tasks with modifiedDate >7 days old are included

### STALE-03: Schedule trigger fires correctly

**Steps:**
1. Temporarily change the stale-task-nudge cron in `config/schedules.json` to fire soon (e.g., `*/2 * * * *`)
2. Wait for the schedule to fire
3. Watch logs

**Assertions:**
- Log shows `schedule:triggered` event with `taskType: 'stale-task-nudge'`
- Stale-detector service picks up the event
- Full detection cycle runs
- Restore the original cron after testing

## Test Cases — AI-Generated Nudges (AC #2)

### STALE-04: AI generates actionable nudge suggestions

**Steps:**
1. Ensure TickTick has stale tasks of varying types:
   - An overdue task with clear next steps (should get "do-today")
   - A vague task with no description (should get "break-down" or "drop")
   - A task that's been stale >30 days (should lean toward "drop" or "complete")
2. Trigger stale detection (STALE-01 method)
3. Watch logs for AI nudge generation

**Assertions:**
- Log shows second `executeApprovedAction` for `ticktick:get-tasks` with nudge generation prompt (green tier)
- Log shows nudge response parsed as JSON array
- Each nudge entry has: `taskId`, `taskTitle`, `staleDays`, `suggestedAction`, `reason`
- `suggestedAction` is one of: `do-today`, `complete`, `snooze`, `break-down`, `drop`
- Suggestions match the task context (e.g., overdue → "do-today", vague → "break-down")

### STALE-05: Break-down suggestion includes subtask ideas

**Steps:**
1. Ensure a stale task with a vague title (e.g., "Organize things") exists
2. Trigger stale detection
3. Check logs for the break-down suggestion

**Assertions:**
- Nudge for the vague task has `suggestedAction: "break-down"`
- Nudge includes `breakdownSuggestions` array with 3-5 concrete subtask ideas
- Subtask suggestions are specific and actionable

## Test Cases — Telegram Batch Notification (AC #3, #4)

### STALE-06: Small batch notification with per-task buttons (<=5 stale tasks)

**Steps:**
1. Ensure TickTick has 2-3 stale tasks (not more than 5)
2. Trigger stale detection (STALE-01 method)
3. Check Telegram for notification

**Assertions:**
- Telegram notification received with title containing "Stale Task Nudge" and task count
- Body lists each stale task with: title, staleness (e.g., "14d stale"), suggested action, and reason
- Inline keyboard has per-task action buttons:
  - [Do Today] for tasks with "do-today" suggestion
  - [Snooze 1w] for tasks with "snooze" suggestion
  - [Break Down] for tasks with "break-down" suggestion
  - [Drop] for tasks with "drop" suggestion

### STALE-07: Large batch notification with summary (>5 stale tasks)

**Steps:**
1. Ensure TickTick has more than 5 stale tasks (create old tasks if needed)
2. Trigger stale detection
3. Check Telegram for notification

**Assertions:**
- Telegram notification is a summary format (not individual per-task buttons)
- Body shows count and high-level summary
- Inline keyboard has [View All Stale Tasks] button instead of per-task buttons
- Message is not excessively long (stays readable)

### STALE-08: Do Today button works

**Steps:**
1. After receiving stale task notification (STALE-06), tap the [Do Today] button for a task

**Assertions:**
- Task is updated in TickTick: priority set to high, due date set to today
- Telegram confirms the action
- Task no longer appears as stale on next detection run

### STALE-09: Snooze 1w button works

**Steps:**
1. Tap the [Snooze 1w] button for a stale task

**Assertions:**
- Task due date is pushed forward by 7 days in TickTick
- Telegram confirms the snooze
- Task won't appear as stale again for at least 7 days

### STALE-10: Break Down button works

**Steps:**
1. Tap the [Break Down] button for a task that had break-down suggestion

**Assertions:**
- `t:bd:{taskId}` callback is triggered
- AI generates 3-5 subtask suggestions via `ticktick:get-task-details` + creation
- Subtasks are created in TickTick under the same project
- Telegram confirms breakdown with subtask list

### STALE-11: Drop button works

**Steps:**
1. Tap the [Drop] button for a stale task

**Assertions:**
- Task is completed/archived in TickTick (yellow tier — not deleted)
- Telegram confirms the drop action

### STALE-12: View All Stale Tasks button works

**Steps:**
1. After receiving a large batch notification (STALE-07), tap [View All Stale Tasks]

**Assertions:**
- `t:stale:list` callback is triggered
- Triggers `task-management:stale-detect-request` event (re-runs detection)
- New notification sent with full stale task list

## Test Cases — Config and Exclusion Rules

### STALE-13: Exclude tags filter works

**Steps:**
1. Ensure `config/stale-task-rules.json` has `"excludeTags": ["someday", "waiting-for"]`
2. Create or ensure a stale task (>7 days) tagged with "someday" in TickTick
3. Trigger stale detection

**Assertions:**
- Task tagged "someday" does NOT appear in the stale task list
- Other stale tasks without excluded tags are still detected
- Log shows exclusion filtering applied

### STALE-14: Exclude projects filter works

**Steps:**
1. Add a project name to `config/stale-task-rules.json` `"excludeProjects"` array
2. Ensure a stale task exists in that project
3. Trigger stale detection

**Assertions:**
- Task in the excluded project does NOT appear in the stale task list
- Stale tasks in other projects are still detected

### STALE-15: maxNudgesPerRun limits output

**Steps:**
1. Set `"maxNudgesPerRun": 3` in `config/stale-task-rules.json`
2. Ensure TickTick has more than 3 stale tasks
3. Trigger stale detection

**Assertions:**
- Only 3 stale tasks are processed (not all)
- Tasks are selected by highest staleDays first (oldest tasks get nudged first)
- Completion event shows `nudgesSent: 3` even if more stale tasks exist

### STALE-16: Config hot-reload updates rules without restart

**Steps:**
1. Edit `config/stale-task-rules.json` — change `staleDays` from 7 to 3
2. Save the file
3. Watch logs for config reload
4. Trigger stale detection

**Assertions:**
- Log shows `config:reloaded` event received by stale-detector service
- Log shows rules updated with new staleDays value
- Stale detection now uses 3-day threshold (more tasks should be flagged as stale)
- Restore to `staleDays: 7` after testing

### STALE-17: Invalid config preserves previous rules

**Steps:**
1. Edit `config/stale-task-rules.json` — introduce invalid data (e.g., `"staleDays": "not-a-number"`)
2. Save the file
3. Watch logs

**Assertions:**
- Log shows config reload with Zod validation error
- Log shows previous rules preserved
- Next stale detection run uses old (valid) rules
- Fix the config file afterward

## Test Cases — Failure Handling

### STALE-18: TickTick fetch failure emits failure event

**Steps:**
1. Temporarily break TickTick credentials
2. Trigger stale detection (STALE-01 method)

**Assertions:**
- Log shows `ticktick:get-tasks` failure
- Log shows `task-management:stale-detect:failed` event emitted with error
- No Telegram notification sent
- Service continues running — no crash

### STALE-19: AI nudge generation failure handled gracefully

**Steps:**
1. Verify via logs during a normal run — if AI returns invalid JSON, the service handles it
2. Alternatively, verify via unit tests

**Assertions:**
- If AI returns non-JSON, log shows parsing warning
- `task-management:stale-detect:failed` event emitted
- No crash, service continues

### STALE-20: No stale tasks found — silent completion

**Steps:**
1. Ensure all TickTick tasks were recently modified (within 7 days)
2. Trigger stale detection

**Assertions:**
- Log shows 0 stale tasks found after filtering
- `task-management:stale-detect:completed` event emitted with `staleCount: 0`
- No Telegram notification sent (skip "0 tasks" notifications)
- Service completes cleanly

### STALE-21: Concurrent run guard prevents overlap

**Steps:**
1. Trigger stale detection twice in rapid succession:
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:stale-detect-request", "payload": {"source": "api"}}'
   # immediately again
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:stale-detect-request", "payload": {"source": "api"}}'
   ```

**Assertions:**
- First trigger runs normally
- Second trigger logs warning about already running and is skipped
- Only one completion event emitted
