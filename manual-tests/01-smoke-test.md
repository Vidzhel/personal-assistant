# 01 - Smoke Test

Quick prerequisite validation. Run first before any other tests. Takes under 2 minutes.

## Prerequisites

- Frontend dev server running at `http://localhost:3000` (`npm run dev:web`)
- Backend API running at `http://localhost:3001` (`npm run dev:core`)
- Alternatively, run both together: `npm run dev` (uses concurrently)
- Run `.claude/skills/browser-testing/scripts/check-devserver.sh` to verify both servers

## Playwright MCP Tools Used

- `browser_navigate` — load pages
- `browser_snapshot` — inspect rendered content
- `browser_console_messages` — check for JS errors
- `browser_network_requests` — verify API calls succeed

## Test Cases

### SM-01: Dashboard Loads Successfully

**Steps:**
1. Navigate to `http://localhost:3000`
2. Take a snapshot of the page

**Expected:**
- Page renders with dark background (#0a0a0a)
- "Dashboard" heading visible in large bold text
- "Raven Personal Assistant" subtitle visible in muted gray (#737373)
- Six status cards visible in a row below the heading
- Two panels below cards: "Live Activity" on left, "Quick Actions" on right

### SM-02: Sidebar Renders Correctly

**Steps:**
1. On the dashboard page, take a snapshot
2. Inspect the sidebar region on the left

**Expected:**
- Fixed sidebar on the left, approximately 224px wide
- "RAVEN" text at top in purple (#6d28d9), bold
- "Personal Assistant" subtitle below in small muted text (#737373)
- Six navigation links listed vertically with icon characters:
  - `~` Dashboard
  - `#` Projects
  - `>` Activity
  - `@` Schedules
  - `*` Skills
  - `%` Settings
- "Dashboard" link is highlighted (brighter text, background accent)
- All other links show muted text color (#737373)

### SM-03: All Routes Load Without Errors

**Steps:**
1. Click "Projects" in sidebar, take snapshot — verify "Projects" heading appears
2. Click "Activity" in sidebar, take snapshot — verify "Activity Log" heading appears
3. Click "Schedules" in sidebar, take snapshot — verify "Schedules" heading appears
4. Click "Skills" in sidebar, take snapshot — verify "Skills" heading appears
5. Click "Settings" in sidebar, take snapshot — verify "Settings" heading appears
6. Click "Dashboard" in sidebar, take snapshot — verify "Dashboard" heading appears

**Expected:**
- Each page loads with the correct heading
- No error pages, blank screens, or crash messages
- The clicked sidebar link becomes highlighted on each navigation
- URL updates correctly for each route

### SM-04: No JavaScript Console Errors

**Steps:**
1. Navigate to `http://localhost:3000`
2. Check console messages
3. Navigate through all 6 routes (Dashboard, Projects, Activity, Schedules, Skills, Settings)
4. Check console messages again after each navigation

**Expected:**
- No red error messages (TypeError, ReferenceError, Unhandled, etc.)
- Warnings are acceptable
- Network request failures to API endpoints indicate backend is not running (fail the prerequisite, not this test)

### SM-05: API Connectivity Verified via Health Status

**Steps:**
1. Navigate to `http://localhost:3000`
2. Take a snapshot and find the first status card

**Expected:**
- First status card shows label "Status" with value "Online" in green (#22c55e)
- If it shows "Offline" in red (#ef4444), the backend API is not reachable — fix prerequisites before continuing
- The "Skills" card shows a number > 0 (skills are loaded)

## Results

| Date | Tester | SM-01 | SM-02 | SM-03 | SM-04 | SM-05 | Overall | Notes |
|------|--------|-------|-------|-------|-------|-------|---------|-------|
|      |        |       |       |       |       |       |         |       |
