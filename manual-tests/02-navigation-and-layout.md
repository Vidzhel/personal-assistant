# 02 - Navigation and Layout

Verify sidebar navigation, active states, routing, and responsive layout behavior.

## Prerequisites

- Smoke tests (01) passing
- At least one project exists in the system (for sub-route active state test)

## Playwright MCP Tools Used

- `browser_snapshot` — inspect DOM structure
- `browser_click` — click navigation links
- `browser_resize` — test responsive breakpoints
- `browser_take_screenshot` — visual verification

## Test Cases

### NAV-01: Sidebar Link Structure

**Steps:**
1. Navigate to `http://localhost:3000`
2. Take a snapshot and inspect the sidebar navigation links

**Expected:**
- Six links in the sidebar nav, each with a monospace icon character and text label:
  - `~` Dashboard (links to `/`)
  - `#` Projects (links to `/projects`)
  - `>` Activity (links to `/activity`)
  - `@` Schedules (links to `/schedules`)
  - `*` Skills (links to `/skills`)
  - `%` Settings (links to `/settings`)

### NAV-02: Active State Highlights Current Route

**Steps:**
1. Navigate to `/` — take snapshot, note which sidebar link is highlighted
2. Click "Projects" — take snapshot, note highlight
3. Click "Activity" — take snapshot, note highlight
4. Click "Schedules" — take snapshot, note highlight
5. Click "Skills" — take snapshot, note highlight
6. Click "Settings" — take snapshot, note highlight

**Expected:**
- At each step, exactly ONE sidebar link is highlighted (bright text, background accent #1a1a1a)
- The highlighted link matches the current route:
  - `/` → Dashboard
  - `/projects` → Projects
  - `/activity` → Activity
  - `/schedules` → Schedules
  - `/skills` → Skills
  - `/settings` → Settings
- All non-active links show muted text (#737373), transparent background

### NAV-03: Active State on Sub-routes

**Steps:**
1. Navigate to `/projects`
2. Click on a project card to navigate to `/projects/[some-id]`
3. Take snapshot of sidebar

**Expected:**
- "Projects" link remains highlighted even though URL is `/projects/[id]`
- Dashboard link is NOT highlighted
- The highlight persists because the pathname starts with `/projects`

### NAV-04: Client-Side Navigation (No Full Reload)

**Steps:**
1. Navigate to `/`
2. Click "Projects" in sidebar
3. Observe the page transition

**Expected:**
- Page content changes smoothly without a white flash or full page reload
- Sidebar stays visible throughout the transition
- URL updates to `/projects` in the address bar
- This is Next.js client-side navigation (no full HTML refetch)

### NAV-05: Main Content Scrolls, Sidebar Does Not

**Steps:**
1. Navigate to a page with enough content to require scrolling (e.g., `/activity` with many events)
2. Scroll the main content area down

**Expected:**
- Main content area scrolls vertically
- Sidebar remains fixed and fully visible — does not scroll with content
- No horizontal scrollbar appears
- Body has `overflow: hidden`, main has `overflow-y: auto`

### NAV-06: Responsive — Status Cards Grid

**Steps:**
1. Navigate to `/` (Dashboard)
2. Resize browser to width 640px, take screenshot
3. Resize to 768px, take screenshot
4. Resize to 1280px, take screenshot

**Expected:**
- At 640px wide: Status cards arranged in 2-column grid
- At 768px wide: Status cards in 3-column grid
- At 1280px wide: All 6 status cards in a single row (6-column grid)

### NAV-07: Responsive — Project Cards Grid

**Steps:**
1. Navigate to `/projects` (need 3+ projects for meaningful test)
2. Resize to 640px, take screenshot
3. Resize to 768px, take screenshot
4. Resize to 1280px, take screenshot

**Expected:**
- At 640px: Project cards stack in 1 column
- At 768px: 2-column grid
- At 1280px: 3-column grid

### NAV-08: Responsive — Skills Grid

**Steps:**
1. Navigate to `/skills`
2. Resize to 640px, take screenshot
3. Resize to 768px, take screenshot

**Expected:**
- At 640px: Skill cards stack in 1 column
- At 768px+: 2-column grid side by side

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 8     |       |
