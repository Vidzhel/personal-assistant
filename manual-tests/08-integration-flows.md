# 08 - Integration Flows

End-to-end scenarios that exercise the full stack: project creation, chat, agent tasks, and dashboard reflection. Uses snapshot-first verification.

## Prerequisites

- Both servers running: `npm run dev` (or `npm run dev:core` + `npm run dev:web` separately)
- Run `.claude/skills/browser-testing/scripts/check-devserver.sh` to verify both servers
- Backend API healthy: `curl http://localhost:3001/api/health` returns `status: "ok"`

## Playwright MCP Tools Used

- `browser_navigate` — load pages
- `browser_snapshot` — primary verification (accessibility tree)
- `browser_take_screenshot` — supplementary visual evidence
- `browser_click` — interact with UI elements
- `browser_type` — enter text in inputs
- `browser_wait_for` — wait for async updates
- `browser_console_messages` — check for JS errors
- `browser_network_requests` — verify API calls

## Test Cases

### INT-01: Create Test Project & Verify

**Steps:**
1. Navigate to `http://localhost:3000/projects`
2. Take a snapshot — note current project count
3. Click "New Project" button
4. Fill in project name: "Integration Test"
5. Select ticktick skill if available
6. Submit the form
7. Wait 2 seconds for API response
8. Take a snapshot of the projects list

**Expected:**
- New project "Integration Test" appears in the project list
- Project card shows the project name and selected skills

### INT-02: Send Chat Message & Verify User Bubble

**Steps:**
1. Navigate to the "Integration Test" project (click on it from projects list)
2. Take a snapshot — verify chat view loads with empty or welcome state
3. Find the chat input field
4. Type "List my tasks" and submit (press Enter)
5. Wait 2 seconds
6. Take a snapshot of the chat area

**Expected:**
- User message bubble appears with text "List my tasks"
- Message is visually distinct (right-aligned or different background)
- Chat input is cleared after sending

### INT-03: Verify Agent Task Spawns

**Steps:**
1. After sending chat in INT-02, navigate to `http://localhost:3000/activity`
2. Wait 3 seconds for events to propagate
3. Take a snapshot of the activity feed

**Expected:**
- An `agent:task:request` event appears in the activity log
- Event shows source "orchestrator" and skill "orchestrator"
- Event timestamp is recent (within last minute)

### INT-04: Verify Agent Response

**Steps:**
1. Navigate back to the "Integration Test" project chat
2. Wait up to 30 seconds, taking snapshots every 5 seconds
3. Look for an assistant response bubble

**Expected:**
- An assistant response bubble appears below the user message
- OR an error message appears (acceptable if no API credentials configured)
- The chat does not remain in a permanent loading state

### INT-05: Dashboard Reflects New Project

**Steps:**
1. Navigate to `http://localhost:3000` (dashboard)
2. Take a snapshot of the status cards area

**Expected:**
- "Projects" status card shows a count that includes the newly created project
- Count is >= 1

### INT-06: Activity Page Shows Events

**Steps:**
1. Navigate to `http://localhost:3000/activity`
2. Take a snapshot

**Expected:**
- Activity log contains events from the chat interaction (INT-02/INT-03)
- Both `user:chat:message` and `agent:task:request` events visible
- Events are ordered by most recent first

### INT-07: Console Error Check

**Steps:**
1. After completing INT-01 through INT-06, check browser console messages
2. Review all console output

**Expected:**
- No `TypeError`, `ReferenceError`, or `Unhandled` errors in console
- Warnings are acceptable (React hydration warnings, deprecation notices)
- Network errors to external APIs are acceptable if credentials not configured

### INT-08: Health Endpoint Accuracy

**Steps:**
1. Navigate to `http://localhost:3000` (dashboard)
2. Take a snapshot of the status cards

**Expected:**
- "Status" card shows "Online" in green
- "Skills" card shows a number matching the actual loaded skills count
- Values are consistent with `curl http://localhost:3001/api/health` response

## Results

| Date | Tester | INT-01 | INT-02 | INT-03 | INT-04 | INT-05 | INT-06 | INT-07 | INT-08 | Overall | Notes |
|------|--------|--------|--------|--------|--------|--------|--------|--------|--------|---------|-------|
|      |        |        |        |        |        |        |        |        |        |         |       |
