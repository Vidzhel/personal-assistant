# 01 - Smoke Test (v2)

Quick prerequisite validation. Run first before any other tests.

Prerequisites: Both servers running (`npm run dev:core` + `npm run dev:web`)

## Test Cases — Backend Health

### SM-01: API health endpoint responds

**Steps:**
1. curl: `GET http://localhost:4001/api/health`
2. assert response:
   - status 200
   - JSON has `status` = "ok"
   - JSON has `uptime` (number > 0)

### SM-02: API returns skill list

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. assert response:
   - status 200
   - JSON array returned
   - at least 1 skill entry

### SM-03: API returns project list

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert response:
   - status 200
   - JSON array returned

### SM-04: API returns template list

**Steps:**
1. curl: `GET http://localhost:4001/api/templates`
2. assert response:
   - status 200
   - JSON array returned

### SM-05: API returns agent list

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert response:
   - status 200
   - JSON array with at least 1 agent (default)

### SM-06: Task trees endpoint responds

**Steps:**
1. curl: `GET http://localhost:4001/api/task-trees`
2. assert response:
   - status 200
   - JSON array returned (may be empty)

## Test Cases — Frontend Health

### SM-07: Dashboard loads successfully

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"
   - NO error overlay or blank screen

### SM-08: All v2 routes load without errors

**Steps:**
1. navigate: `http://localhost:4000` → assert: heading "Dashboard"
2. click: link "Projects" → wait: 1s → assert: heading "Projects"
3. click: link "Activity" → wait: 1s → assert: heading "Activity Timeline"
4. click: link "Templates" → wait: 1s → assert: heading "Templates"
5. click: link "Tasks" → wait: 1s → assert: heading "Tasks"
6. click: link "Agents" → wait: 1s → assert: heading "Agents"
7. click: link "Skills" → wait: 1s → assert: heading "Skills"
8. click: link "Schedules" → wait: 1s → assert: heading "Schedules"
9. click: link "Settings" → wait: 1s → assert: heading "Settings"
10. click: link "Dashboard" → wait: 1s → assert: heading "Dashboard"

**Notes:** Each navigation should update the URL. No blank screens or error overlays at any step.

### SM-09: No JavaScript console errors on navigation

**Steps:**
1. navigate: `http://localhost:4000`
2. navigate through all routes from SM-08
3. check: console_messages for errors
4. assert: no `error` level messages (warnings are acceptable)

### SM-10: WebSocket connection established

**Steps:**
1. navigate: `http://localhost:4000`
2. wait: 2s
3. check: WebSocket connection to `ws://localhost:4001/ws` is open
4. assert: connection state = OPEN
