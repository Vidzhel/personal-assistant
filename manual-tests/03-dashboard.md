# 03 - Dashboard Page

Verify status cards, live activity feed (WebSocket), quick actions panel, and health polling.

## Prerequisites

- Smoke tests (01) passing
- Backend running with skills loaded

## Playwright MCP Tools Used

- `browser_snapshot` — card content and structure
- `browser_network_requests` — verify health polling
- `browser_click` — quick action links
- `browser_take_screenshot` — visual verification
- `browser_resize` — responsive layout

## Test Cases

### DASH-01: Page Header Content

**Steps:**
1. Navigate to `http://localhost:3000`
2. Take a snapshot

**Expected:**
- "Dashboard" as the main heading (large, bold)
- "Raven Personal Assistant" as subtitle in smaller muted text (#737373)

### DASH-02: Six Status Cards Present

**Steps:**
1. On dashboard, take a snapshot
2. Identify the six status cards

**Expected:**
- Six cards in a horizontal row (at wide viewport), each with card background (#141414) and border (#262626)
- Card labels (in muted text): "Status", "Skills", "Projects", "Agents Running", "Queue", "Schedules"
- Each card shows a value below its label

### DASH-03: Status Card Values and Colors

**Steps:**
1. Take a snapshot of the status cards
2. Inspect each card's value and its color

**Expected:**
- "Status": "Online" in green (#22c55e) when backend is healthy
- "Skills": a number (e.g., 4) in purple (#6d28d9)
- "Projects": a number in default text color (#e5e5e5)
- "Agents Running": "0" in muted (#737373) when idle, or a number in yellow (#eab308) when active
- "Queue": "0" in muted (#737373) when empty
- "Schedules": a number in muted (#737373)

### DASH-04: Status Cards Reflect Live Data

**Steps:**
1. Note the "Projects" count on the dashboard
2. Open a new tab, navigate to `/projects`, create a new project
3. Return to dashboard tab, wait up to 10 seconds for health poll refresh
4. Check the "Projects" count again

**Expected:**
- Projects count increments by 1 after the health poll refreshes
- The dashboard polls `/api/health` every 10 seconds, so the update may take up to 10s

### DASH-05: Offline State Display

**Steps:**
1. Stop the backend API server (or disconnect network)
2. Wait up to 10 seconds on the dashboard

**Expected:**
- "Status" card changes to "Offline" in red (#ef4444)
- Other cards may show "0" or retain stale values
- No crash, no error overlay — graceful degradation

### DASH-06: Live Activity Feed — Empty State

**Steps:**
1. Navigate to dashboard with no recent WebSocket events
2. Look at the "Live Activity" panel on the left

**Expected:**
- "Live Activity" heading in small semibold text
- Message: "No activity yet. Events will appear here in real-time." in muted text
- The panel has a max height of about 320px with scroll capability

### DASH-07: Live Activity Feed — Events Appear in Real-Time

**Steps:**
1. Open dashboard in browser
2. In a separate browser tab, navigate to a project and send a chat message
3. Switch back to the dashboard tab
4. Watch the "Live Activity" panel

**Expected:**
- A new event appears at the top of the activity feed without any page refresh
- The event appears almost instantly (WebSocket push, not polling)
- The event shows: type badge (e.g., "user:chat:message"), timestamp, and content text

### DASH-08: Activity Feed Event Display Format

**Steps:**
1. After events appear in the activity feed, take a snapshot
2. Inspect individual event entries

**Expected:**
- Each event row shows:
  - Event type badge: monospace text, small font, accent-colored (#6d28d9) on dark background (#1a1a1a), left-aligned
  - Timestamp: locale time string, right-aligned on the same line
  - Content: text extracted from event payload (content, title, or subject field), truncated to single line
- Rows separated by bottom borders (#262626)
- Maximum 50 events displayed; oldest dropped when exceeded

### DASH-09: Quick Actions Panel Content

**Steps:**
1. On dashboard, inspect the right panel
2. Take a snapshot of the "Quick Actions" section

**Expected:**
- "Quick Actions" heading
- Three action items stacked vertically, each with dark background (#0a0a0a), border (#262626):
  1. "Open Projects" — description: "Chat with Raven about your tasks"
  2. "View Schedules" — description: "Morning digest and recurring tasks"
  3. "Manage Skills" — description: "Configure integrations"
- Each action has a label in medium font and a description in smaller muted text

### DASH-10: Quick Actions Navigate Correctly

**Steps:**
1. Click "Open Projects" quick action
2. Verify navigation
3. Go back to dashboard
4. Click "View Schedules" quick action
5. Verify navigation
6. Go back to dashboard
7. Click "Manage Skills" quick action
8. Verify navigation

**Expected:**
- "Open Projects" navigates to `/projects`
- "View Schedules" navigates to `/schedules`
- "Manage Skills" navigates to `/skills`
- Correct sidebar link highlights on each page

### DASH-11: Health Polling Every 10 Seconds

**Steps:**
1. Navigate to dashboard
2. Monitor network requests for 25 seconds

**Expected:**
- `GET` request to `/api/health` fires on initial load
- Additional `/api/health` requests every ~10 seconds
- At least 2 polling requests visible in the 25-second observation window

### DASH-12: Two-Column Layout — Activity and Quick Actions

**Steps:**
1. On dashboard at wide viewport (1280px+), take screenshot
2. Resize to 640px, take screenshot

**Expected:**
- At 1280px+: "Live Activity" and "Quick Actions" panels sit side by side in two columns
- At 640px: Panels stack vertically (Activity above, Quick Actions below)
- Both panels have card styling (background #141414, border #262626)

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 12    |       |
