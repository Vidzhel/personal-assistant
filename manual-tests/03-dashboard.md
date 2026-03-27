# 03 - Dashboard Page

Verify status cards, live activity feed, quick actions, and health polling.

Prerequisites: Smoke tests (01) passing, backend running with skills loaded

## Test Cases

### DASH-01: Page header content

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"

### DASH-02: Six status cards present

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - text "Status"
   - text "Skills"
   - text "Projects"
   - text "Agents Running"
   - text "Queue"
   - text "Schedules"

### DASH-03: Status card values

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - text "Online" OR text "Degraded" (under Status card)
   - text matching a number (under Skills, Projects, Schedules)

### DASH-04: Status cards reflect live data

**Steps:**
1. navigate: `http://localhost:4000` → snapshot → note Projects count
2. open new tab → navigate: `http://localhost:4000/projects`
3. create a new project
4. switch back to dashboard tab → wait: 10s
5. snapshot → assert: Projects count incremented by 1

**Notes:** Dashboard polls `/api/health` every 10 seconds, so update may take up to 10s.

### DASH-05: Live Activity feed — empty state

**Steps:**
1. navigate: `http://localhost:4000` (with no recent events)
2. snapshot → assert:
   - text "Live Activity"
   - text "No activity yet" OR list with 0 items

### DASH-06: Live Activity feed — events appear

**Steps:**
1. navigate: `http://localhost:4000`
2. in separate tab, send a chat message in a project
3. switch back to dashboard → wait: 3s
4. snapshot → assert:
   - text "Live Activity"
   - at least 1 event entry visible (event type text present)

**Notes:** Events arrive via WebSocket — should appear almost instantly without page refresh.

### DASH-07: Life Dashboard summary cards

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - link "Actions Today" with numeric count
   - link "Active Pipelines" with numeric count
   - link "Pending Approvals" with numeric count
   - link "System Health" with status text

**Notes:** These cards replaced the old Quick Actions panel in the Life Dashboard redesign (Story 10.6).

### DASH-08: Summary card navigation

**Steps:**
1. click: link "Actions Today" → assert URL contains `/activity`
2. go-back
3. click: link "Active Pipelines" → assert URL contains `/pipelines`
4. go-back
5. click: link "System Health" → assert URL contains `/settings`

### DASH-09: Health polling every 10 seconds

**Steps:**
1. navigate: `http://localhost:4000`
2. monitor: network_requests for 25 seconds

**Expected:**
- GET `/api/health` fires on initial load
- Additional `/api/health` requests every ~10 seconds
- At least 2 polling requests in 25-second window

## Test Cases — Life Dashboard (Story 10.6)

### DASH-10: Life dashboard summary cards

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - card "Actions Today" with a count (links to `/activity`)
   - card "Active Pipelines" with a count
   - card "Pending Approvals" with a count
   - card "System Health" with a status badge

### DASH-11: Latest Insights section

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - section "Latest Insights" (or similar heading)
   - up to 5 insight entries with: type icon, title, truncated content
   - insights link to knowledge page

### DASH-12: Upcoming Events section

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - section "Upcoming Events" (or similar heading)
   - scheduled runs listed with: name, time, type
   - events link to schedules page

### DASH-13: Dashboard sections are clickable

**Steps:**
1. navigate: `http://localhost:4000`
2. click: "Actions Today" card → assert: navigates to `/activity`
3. navigate back
4. click: "Pending Approvals" card → assert: navigates to approvals/settings page
5. navigate back
6. click: an entry in "Upcoming Events" → assert: navigates to `/schedules`

### DASH-14: Life dashboard API

**Steps:**
1. curl: `GET http://localhost:4001/api/dashboard/life`
2. assert response:
   - status 200
   - JSON body contains: `autonomousActionsCount`, `activePipelines`, `pendingApprovalsCount`, `latestInsights`, `systemHealth`, `upcomingEvents`
   - counts are numbers, arrays have expected structure
