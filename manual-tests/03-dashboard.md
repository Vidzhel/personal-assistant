# 03 - Dashboard (v2)

Verifies dashboard status cards, life dashboard, live activity, and health polling for v2.

Prerequisites: Both servers running

## Test Cases — Status Cards

### DASH-01: Dashboard header and structure

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"
   - status indicator showing "Online" or "Offline"

### DASH-02: Status cards display live data

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert presence of status cards:
   - "Status" card (Online/Offline indicator)
   - "Skills" card (count from capability library)
   - "Projects" card (count from project registry)
   - "Agents Running" card (count of active agent tasks)
   - "Templates" card (count from template registry)
   - "Schedules" card (count of active schedules)

### DASH-03: Status card counts match API data

**Steps:**
1. curl: `GET http://localhost:4001/api/skills` → note array length as SKILL_COUNT
2. curl: `GET http://localhost:4001/api/projects` → note array length as PROJECT_COUNT
3. curl: `GET http://localhost:4001/api/templates` → note array length as TEMPLATE_COUNT
4. curl: `GET http://localhost:4001/api/schedules` → note array length as SCHEDULE_COUNT
5. navigate: `http://localhost:4000`
6. assert: Skills card shows SKILL_COUNT
7. assert: Projects card shows PROJECT_COUNT
8. assert: Templates card shows TEMPLATE_COUNT
9. assert: Schedules card shows SCHEDULE_COUNT

## Test Cases — Life Dashboard

### DASH-04: Life dashboard summary cards

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - "Actions Today" card with count
   - "Active Task Trees" card with count (v2: replaces "Active Pipelines")
   - "Pending Approvals" card with count
   - "System Health" card

### DASH-05: Life dashboard data comes from API

**Steps:**
1. curl: `GET http://localhost:4001/api/dashboard/life`
2. assert response:
   - status 200
   - JSON has `actionsToday` (number)
   - JSON has `activeTrees` or `activePipelines` (number)
   - JSON has `pendingApprovals` (number)
   - JSON has `systemHealth` (string)

## Test Cases — Live Activity

### DASH-06: Live activity feed displays events

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - "Live Activity" section exists
   - events displayed with description, source badge, timestamp (or empty state message)

### DASH-07: Live activity updates via WebSocket

**Steps:**
1. navigate: `http://localhost:4000`
2. trigger an event (e.g., send a chat message in another tab)
3. wait: 3s
4. assert: new event appears in Live Activity feed without page refresh

## Test Cases — Polling

### DASH-08: Health polling every 10 seconds

**Steps:**
1. navigate: `http://localhost:4000`
2. open browser Network tab, filter by `/api/health`
3. wait: 25s
4. assert: at least 2 health requests visible (initial + polling)

### DASH-09: Card navigation to detail pages

**Steps:**
1. navigate: `http://localhost:4000`
2. click: "Projects" status card
3. assert: navigated to `/projects`
4. navigate back to `/`
5. click: "Skills" status card
6. assert: navigated to `/skills`
7. navigate back to `/`
8. click: "Templates" status card
9. assert: navigated to `/templates`
