# 05 - Activity Timeline (Story 5.2)

Verify the Activity Timeline with rich event cards, source/type filters, and polling behavior.

Prerequisites: Smoke tests (01) passing, some events exist (send a chat message or trigger a pipeline first)

## Test Cases

### ACT-01: Page header

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert:
   - heading "Activity Timeline"
   - text "Chronological view of all autonomous Raven actions."

### ACT-02: Empty state (no events)

**Steps:**
1. navigate: `http://localhost:4000/activity` (when no events exist, or clear DB)
2. snapshot → assert:
   - text "No events recorded yet."

### ACT-03: EventCard display

**Steps:**
1. navigate: `http://localhost:4000/activity` (with events)
2. snapshot → assert:
   - at least 1 event card visible
   - each card has: icon circle (w-8 h-8 rounded-full, colored border)
   - each card has: description text (truncated single line)
   - each card has: source badge (monospace text, e.g. "api", "orchestrator")
   - each card has: relative timestamp (e.g. "2m ago", "1h ago")

### ACT-04: Events in newest-first order

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → inspect event timestamps

**Expected:**
- Events ordered with newest at top
- Relative timestamps increase as you go down the list

### ACT-05: Source filter dropdown

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert:
   - select element with aria-label "Filter by source"
   - default option text "All sources"
   - options populated dynamically from `/api/events/sources`

### ACT-06: Type filter dropdown

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert:
   - select element with aria-label "Filter by event type"
   - default option text "All types"
   - options populated dynamically from `/api/events/types`

### ACT-07: Filter by source

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. click: source filter dropdown → select a specific source (e.g. "orchestrator")
3. snapshot → assert:
   - only events with that source are displayed
   - all visible source badges match selected value

### ACT-08: Filter by event type

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. click: type filter dropdown → select a specific type
3. snapshot → assert:
   - only events with that type are displayed

### ACT-09: Combined filters

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. click: source filter → select a source
3. click: type filter → select a type
4. snapshot → assert:
   - events filtered by both source AND type

### ACT-10: Clear filters button

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert: no "Clear filters" button visible (no filters active)
3. click: source filter → select a source
4. snapshot → assert: "Clear filters" button appears
5. click: "Clear filters" button
6. snapshot → assert:
   - both dropdowns reset to default ("All sources", "All types")
   - "Clear filters" button hidden
   - all events visible again

### ACT-11: Empty state with filters

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. click: source filter → select a source that has no events matching selected type (or use a rare combination)
3. snapshot → assert:
   - text "No matching events" (different from ACT-02 empty state)

### ACT-12: Polling every 5 seconds

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. monitor: network_requests for 15 seconds

**Expected:**
- GET `/api/events?limit=200` fires on page load
- Same request repeats every ~5 seconds
- At least 3 requests in 15-second window

### ACT-13: Polling respects active filters

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. click: source filter → select "orchestrator"
3. monitor: network_requests for 10 seconds

**Expected:**
- GET requests include `source=orchestrator` query param
- URL pattern: `/api/events?limit=200&source=orchestrator`

### ACT-14: Filter metadata polling (30s interval)

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. monitor: network_requests for 60 seconds

**Expected:**
- GET `/api/events/sources` fires on page load
- GET `/api/events/types` fires on page load
- Both repeat every ~30 seconds (slower than event polling)

### ACT-15: New events appear via polling

**Steps:**
1. navigate: `http://localhost:4000/activity` → snapshot → note event count
2. in separate tab, create a project or send a chat message
3. switch back to activity tab → wait: 5s
4. snapshot → assert: event count increased

**Notes:** Update is NOT instant — up to 5-second delay (REST polling, not WebSocket).
