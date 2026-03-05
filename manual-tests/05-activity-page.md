# 05 - Activity Page

Verify the Activity Log event display and polling behavior.

**Important:** The Activity page displays a simple event list with 5-second REST polling. It does NOT have filters, WebSocket real-time updates, or event detail views.

## Prerequisites

- Smoke tests (01) passing
- Some events exist in the system (send a chat message or create a project to generate events)

## Playwright MCP Tools Used

- `browser_snapshot` — inspect event list content
- `browser_network_requests` — verify polling interval
- `browser_take_screenshot` — visual verification

## Test Cases

### ACT-01: Page Header

**Steps:**
1. Navigate to `/activity`
2. Take a snapshot

**Expected:**
- "Activity Log" heading in large bold text
- Subtitle: "All system events in chronological order." in muted text (#737373)

### ACT-02: Empty State

**Steps:**
1. Navigate to `/activity` when no events exist in the database

**Expected:**
- Message: "No events recorded yet." in muted text
- No event cards or list items visible

### ACT-03: Event Card Display

**Steps:**
1. Navigate to `/activity` with events in the system
2. Take a snapshot and inspect individual event entries

**Expected:**
- Vertical list of event cards
- Each card has: background #141414, border #262626, rounded corners, padding
- Each card layout:
  - Left side: Event type badge in monospace text, small font, dark background (#1a1a1a), purple text (#6d28d9)
  - Right side (takes remaining width):
    - Top: Event payload as a raw JSON string (e.g., `{"content":"hello"}`), truncated with ellipsis if too long
    - Bottom: Source name, then a dot separator, then timestamp in locale format — all in extra-small muted text

### ACT-04: Events in Newest-First Order

**Steps:**
1. Look at the timestamps of events in the list

**Expected:**
- Events are ordered with the newest event at the top
- Timestamps decrease as you scroll down the list

### ACT-05: Polling Every 5 Seconds

**Steps:**
1. Navigate to `/activity`
2. Monitor network requests for 15 seconds

**Expected:**
- A `GET` request to `/api/events?limit=100` fires immediately on page load
- The same request repeats every ~5 seconds
- At least 3 requests visible in a 15-second window

### ACT-06: New Events Appear via Polling

**Steps:**
1. Open `/activity` in the browser
2. In a separate browser tab, navigate to `/projects` and create a new project (this generates an event)
3. Switch back to the activity tab and wait up to 5 seconds

**Expected:**
- A new event appears at the top of the list on the next poll cycle
- No manual page refresh needed
- The update is NOT instant — there may be up to a 5-second delay (REST polling, not WebSocket)

### ACT-07: Payload Display as JSON

**Steps:**
1. Inspect the payload text on various event cards

**Expected:**
- Payload is displayed as a compact JSON string (e.g., `{"content":"test","projectId":"abc-123"}`)
- No pretty-printing or indentation
- Long payloads are truncated to a single line with CSS ellipsis (...)

### ACT-08: Timestamp and Source Format

**Steps:**
1. Inspect the source and timestamp on event cards

**Expected:**
- Source name appears first (e.g., "api", "orchestrator", "skill-ticktick")
- Followed by a middle dot character (·)
- Then timestamp in browser locale format (e.g., "3/5/2026, 10:30:45 AM")

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 8     |       |
