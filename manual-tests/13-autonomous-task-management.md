# 13 - Autonomous Task Management (Story 4.3)

Verify scheduled autonomous task management: task fetching, AI analysis, permission-gated action execution (green/yellow/red tiers), summary notifications, and manual triggers. These are backend-only tests — no frontend UI.

Prerequisites:
- Backend running (`npm run dev:core` from your own terminal, NOT inside Claude Code)
- TickTick credentials configured and verified working
- TickTick has existing tasks across projects (some overdue, some with varying priorities)
- Telegram bot connected
- Schedule `autonomous-task-management` exists in `config/schedules.json` (cron: `0 */6 * * *`)
- Verified via `curl http://localhost:4001/api/health`

## Test Cases — Schedule Trigger and Task Fetch (AC #2)

### AUTO-01: Manual trigger via API runs full autonomous management cycle

**Steps:**
1. Trigger autonomous management manually by emitting the manage-request event:
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:manage-request", "payload": {"source": "api"}}'
   ```
2. Watch terminal logs for the full cycle

**Assertions:**
- Log shows `task-management:manage-request` event received by autonomous-manager service
- Log shows `isRunning` guard set to `true`
- Log shows `executeApprovedAction` called for `ticktick:get-tasks` (green tier — silent task fetch)
- Log shows task list fetched successfully with task count
- Log shows second `executeApprovedAction` for `ticktick:get-tasks` with AI analysis prompt (green tier)
- Log shows AI recommendations parsed as JSON array
- Log shows `isRunning` guard reset to `false` after completion

### AUTO-02: Schedule trigger fires correctly

**Steps:**
1. Check `config/schedules.json` for the autonomous-task-management schedule entry
2. Temporarily change the cron to fire soon (e.g., `*/2 * * * *` for every 2 minutes) to test
3. Wait for the schedule to fire
4. Watch logs

**Assertions:**
- Log shows `schedule:triggered` event with `taskType: 'autonomous-task-management'`
- Autonomous-manager service picks up the event (NOT the orchestrator — it skips due to `findSuiteForTaskType` returning null)
- Full management cycle runs (same as AUTO-01)
- Restore the original cron schedule after testing

## Test Cases — Green-Tier Silent Reads (AC #2)

### AUTO-03: Task fetch is silent (no user notification)

**Steps:**
1. Trigger autonomous management (AUTO-01)
2. Watch specifically for notification events during the task fetch phase

**Assertions:**
- `ticktick:get-tasks` calls are green tier — no `notification` event emitted
- No `permission:approved` event for green-tier reads
- No Telegram message during task fetch phase
- Only the final summary notification is sent (after actions are executed)

## Test Cases — Yellow-Tier Updates with Notification (AC #1, #3)

### AUTO-04: Task update executes and notifies

**Steps:**
1. Ensure TickTick has an overdue task with low priority (the AI should recommend bumping priority)
2. Trigger autonomous management (AUTO-01)
3. Watch logs for update action execution

**Assertions:**
- Log shows AI recommended `"update-task"` action for the overdue task with confidence `"medium"` or `"high"`
- Log shows `executeApprovedAction` called for `ticktick:update-task` (yellow tier)
- Log shows `permission:approved` event for the update
- Task is updated in TickTick (check the app — priority should be higher)
- Action counted as `executed` in completion event

### AUTO-05: Task completion executes and notifies

**Steps:**
1. Create a task in TickTick with a title like "DONE: cleanup old files" (the AI should recommend completing it)
2. Trigger autonomous management (AUTO-01)
3. Watch logs for complete action

**Assertions:**
- Log shows AI recommended `"complete-task"` for the "DONE:" task
- Log shows `executeApprovedAction` called for `ticktick:complete-task` (yellow tier)
- Task is marked complete in TickTick
- Action counted as `executed` in completion event

### AUTO-06: Summary notification sent via Telegram

**Steps:**
1. After a run with at least 1 executed action (AUTO-04 or AUTO-05)
2. Check Telegram for notification

**Assertions:**
- Telegram notification received with title "Autonomous Task Management"
- Body includes summary: "Completed N task actions: X updates, Y completions. Z actions queued for approval."
- Inline keyboard has [View Tasks] button
- Counts match the actual actions taken

## Test Cases — Red-Tier Approval Queue (AC #4)

### AUTO-07: Task deletion queued for approval (not executed)

**Steps:**
1. Create two nearly identical tasks in TickTick (obvious duplicates — the AI should recommend deleting one)
2. Trigger autonomous management (AUTO-01)
3. Watch logs for delete action handling

**Assertions:**
- Log shows AI recommended `"delete-task"` action
- Log shows `executeApprovedAction` called for `ticktick:delete-task` (red tier)
- Log shows `executeApprovedAction` returned `{ success: false }` with error containing "queued"
- Log shows action counted as `queued` (NOT `failed`)
- Task is NOT deleted in TickTick (still exists)
- `permission:blocked` event emitted
- Pending approval created in database:
  ```bash
  curl http://localhost:4001/api/permissions/pending
  ```
  Should show the delete action awaiting approval

### AUTO-08: Approve queued deletion via API

**Steps:**
1. After AUTO-07, get the pending approval ID from the API:
   ```bash
   curl http://localhost:4001/api/permissions/pending
   ```
2. Approve the deletion:
   ```bash
   curl -X POST http://localhost:4001/api/permissions/pending/{id}/approve
   ```
3. Check TickTick

**Assertions:**
- Approval accepted (200 response)
- Task is now deleted in TickTick
- Audit log records the approval

## Test Cases — Confidence Filtering

### AUTO-09: Low-confidence recommendations are skipped

**Steps:**
1. Trigger autonomous management with a task list where the AI is likely to produce low-confidence recommendations (tasks that are ambiguous or recently modified)
2. Watch logs for confidence filtering

**Assertions:**
- Log shows AI recommendations with mixed confidence levels
- Log shows low-confidence recommendations filtered out (not executed)
- Only `"medium"` and `"high"` confidence actions are passed to `executeApprovedAction`
- Completion event reflects only the filtered (executed) count

## Test Cases — Concurrent Run Guard

### AUTO-10: Second trigger during active run is skipped

**Steps:**
1. Trigger autonomous management (AUTO-01)
2. Immediately trigger again before the first run completes:
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:manage-request", "payload": {"source": "api"}}'
   # wait 1 second
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "task-management:manage-request", "payload": {"source": "api"}}'
   ```
3. Watch logs

**Assertions:**
- First run proceeds normally
- Second trigger logs warning: "already running" or similar
- Second trigger is skipped — no duplicate execution
- First run completes normally with proper completion event

## Test Cases — Failure Handling

### AUTO-11: TickTick fetch failure emits failure event

**Steps:**
1. Temporarily break TickTick credentials
2. Trigger autonomous management (AUTO-01)
3. Watch logs

**Assertions:**
- Log shows `ticktick:get-tasks` failure
- Log shows `task-management:autonomous:failed` event emitted with error details
- No notification sent (nothing was executed)
- Service continues running — no crash

### AUTO-12: AI analysis returns invalid JSON

**Steps:**
1. This is difficult to trigger manually — verify via unit tests
2. If possible, verify by checking logs during a normal run that JSON parsing includes error handling

**Assertions:**
- If AI returns non-JSON, log shows parsing warning
- `task-management:autonomous:failed` event emitted
- No crash, service continues

### AUTO-13: No actions needed (clean task list)

**Steps:**
1. Ensure all TickTick tasks are well-organized (correct priorities, no duplicates, no stale items)
2. Trigger autonomous management (AUTO-01)
3. Watch logs

**Assertions:**
- Log shows AI analysis returned empty recommendations or all low-confidence
- `task-management:autonomous:completed` event emitted with `executedCount: 0`, `queuedCount: 0`
- No Telegram notification sent (skip "0 actions" notifications)
