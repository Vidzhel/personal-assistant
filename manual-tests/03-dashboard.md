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
   - text "Online" (under Status card)
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

### DASH-07: Quick Actions panel

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - text "Quick Actions"
   - text "Open Projects"
   - text "View Schedules"
   - text "Manage Skills"

### DASH-08: Quick Actions navigate correctly

**Steps:**
1. navigate: `http://localhost:4000`
2. click: "Open Projects" → wait: 1s → snapshot → assert: heading "Projects"
3. navigate: `http://localhost:4000`
4. click: "View Schedules" → wait: 1s → snapshot → assert: heading "Schedules"
5. navigate: `http://localhost:4000`
6. click: "Manage Skills" → wait: 1s → snapshot → assert: heading "Skills"

### DASH-09: Health polling every 10 seconds

**Steps:**
1. navigate: `http://localhost:4000`
2. monitor: network_requests for 25 seconds

**Expected:**
- GET `/api/health` fires on initial load
- Additional `/api/health` requests every ~10 seconds
- At least 2 polling requests in 25-second window
