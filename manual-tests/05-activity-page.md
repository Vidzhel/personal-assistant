# 05 - Activity Page

Verify the Activity Log event display and polling behavior.

Prerequisites: Smoke tests (01) passing, some events exist (send a chat message or create a project first)

## Test Cases

### ACT-01: Page header

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert:
   - heading "Activity Log"
   - text "All system events in chronological order."

### ACT-02: Empty state

**Steps:**
1. navigate: `http://localhost:4000/activity` (when no events exist)
2. snapshot → assert:
   - text "No events recorded yet."

### ACT-03: Event entries display

**Steps:**
1. navigate: `http://localhost:4000/activity` (with events)
2. snapshot → assert:
   - at least 1 event entry visible
   - each event shows: event type text (e.g., "user:chat:message")
   - each event shows: source name
   - each event shows: timestamp text

### ACT-04: Events in newest-first order

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → inspect event timestamps

**Expected:**
- Events ordered with newest at top
- Timestamps decrease as you go down the list

### ACT-05: Polling every 5 seconds

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. monitor: network_requests for 15 seconds

**Expected:**
- GET `/api/events?limit=100` fires on page load
- Same request repeats every ~5 seconds
- At least 3 requests in 15-second window

### ACT-06: New events appear via polling

**Steps:**
1. navigate: `http://localhost:4000/activity` → snapshot → note event count
2. in separate tab, create a project or send a chat message
3. switch back to activity tab → wait: 5s
4. snapshot → assert: event count increased

**Notes:** Update is NOT instant — up to 5-second delay (REST polling, not WebSocket).

### ACT-07: Event payload and metadata

**Steps:**
1. navigate: `http://localhost:4000/activity` (with events)
2. snapshot → assert:
   - event type badge text visible (e.g., "user:chat:message")
   - source name visible (e.g., "api", "orchestrator")
   - timestamp in readable format
