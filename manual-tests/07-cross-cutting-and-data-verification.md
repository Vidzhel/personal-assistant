# 07 - Cross-Cutting Concerns and Data Verification

Verify data consistency between pages, WebSocket behavior, error handling, and theme consistency.

## Prerequisites

- Smoke tests (01) passing
- At least one project with chat messages exists
- Backend API running with skills and schedules configured

## Playwright MCP Tools Used

- `browser_navigate` — navigate between pages
- `browser_snapshot` — compare data across pages
- `browser_network_requests` — verify API calls
- `browser_console_messages` — check for errors
- `browser_evaluate` — inspect JavaScript state if needed

## Test Cases — Data Consistency

### DATA-01: Skills Count Consistent Across Pages

**Steps:**
1. Navigate to `/skills` — count the skill cards
2. Navigate to `/` (Dashboard) — read the "Skills" status card value
3. Navigate to `/settings` — read the "Loaded Skills" list

**Expected:**
- All three locations show the same number of skills
- The skill names on Settings match the card titles on Skills page
- Dashboard count equals the number of cards on Skills page

### DATA-02: Projects Count Consistent

**Steps:**
1. Navigate to `/projects` — count the project cards
2. Navigate to `/` (Dashboard) — read the "Projects" status card value

**Expected:**
- Dashboard "Projects" count matches the number of project cards on the Projects page

### DATA-03: Schedules Count Consistent

**Steps:**
1. Navigate to `/schedules` — count the schedule cards
2. Navigate to `/` (Dashboard) — read the "Schedules" status card value

**Expected:**
- Dashboard "Schedules" count matches the number of schedule cards on the Schedules page

### DATA-04: Project Creation Updates All Views

**Steps:**
1. Note the current project count on Dashboard
2. Navigate to `/projects`, create a new project
3. Verify the new project appears in the list
4. Navigate to Dashboard, wait up to 10 seconds

**Expected:**
- Project immediately appears in the `/projects` grid after creation
- Dashboard "Projects" count increments after the next health poll (~10s)

## Test Cases — Error Handling

### ERR-01: Backend Unavailable — Dashboard Degrades Gracefully

**Steps:**
1. Navigate to Dashboard while backend is running — verify "Online" status
2. Stop the backend server
3. Wait up to 10 seconds for the next health poll
4. Take a snapshot

**Expected:**
- Status changes to "Offline" (red)
- No crash, no unhandled error overlay
- Page remains interactive (sidebar navigation still works)

### ERR-02: Backend Unavailable — Other Pages Handle Errors

**Steps:**
1. Stop the backend server
2. Navigate to `/projects`, take snapshot
3. Navigate to `/activity`, take snapshot
4. Navigate to `/skills`, take snapshot

**Expected:**
- Pages either show empty state or loading state
- No unhandled error overlay or crash
- No console errors that break the app (network failures are expected)
- Sidebar navigation continues to work

### ERR-03: Invalid Project ID

**Steps:**
1. Navigate to `/projects/this-id-does-not-exist`
2. Take a snapshot
3. Check console messages

**Expected:**
- Shows "Loading project..." text (stays in loading state since project is null)
- No crash or error page
- Console may show a network 404, but no unhandled JavaScript errors

## Test Cases — Theme Consistency

### THEME-01: Dark Theme Across All Pages

**Steps:**
1. Navigate through all 7 routes, taking a screenshot of each
2. Verify consistent dark theme

**Expected on every page:**
- Page background: dark (#0a0a0a)
- Card/panel backgrounds: slightly lighter dark (#141414)
- Borders: subtle gray (#262626)
- Primary text: light gray (#e5e5e5)
- Muted/secondary text: medium gray (#737373)
- Accent elements (buttons, active states, badges): purple (#6d28d9)
- No white backgrounds, no light-theme elements

### THEME-02: Interactive Element Colors

**Steps:**
1. On `/projects`, inspect the "New Project" button color
2. Open the creation form, inspect selected skill button color
3. Navigate to a project chat, inspect the "Send" button color
4. Inspect user chat message bubble color

**Expected:**
- All interactive/accent elements use purple (#6d28d9):
  - "New Project" button background
  - Selected skill buttons in creation form
  - "Send" button in chat
  - User message bubbles in chat
- Consistent purple accent across the entire app

### THEME-03: Status Colors

**Steps:**
1. On Dashboard, check Status card color
2. Navigate to `/schedules`, check Active/Disabled badge colors
3. Navigate to `/settings`, check Status value color

**Expected:**
- Green (#22c55e): "Online" status, "Active" schedule badge, "ok" status text
- Red (#ef4444): "Offline" status, "Disabled" schedule badge
- Yellow (#eab308): "Agents Running" when count > 0
- Colors are consistent everywhere they appear

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 10    |       |
