# 13 - Cross-Cutting Verification (v2)

Validates data consistency across pages, error handling, WebSocket events, and end-to-end integration flows.

Prerequisites: Both servers running

## Test Cases — Data Consistency

### XC-01: Skill count consistent across all views

**Steps:**
1. curl: `GET http://localhost:4001/api/skills` → note length as API_COUNT
2. navigate: `http://localhost:4000/skills` → count skill cards as UI_SKILLS
3. navigate: `http://localhost:4000` → read "Skills" card as DASH_SKILLS
4. assert: API_COUNT = UI_SKILLS = DASH_SKILLS

### XC-02: Project count consistent

**Steps:**
1. curl: `GET http://localhost:4001/api/projects` → API_COUNT
2. navigate: `http://localhost:4000/projects` → UI_COUNT
3. navigate: `http://localhost:4000` → DASH_COUNT
4. assert: API_COUNT = UI_COUNT = DASH_COUNT

### XC-03: Template count consistent

**Steps:**
1. curl: `GET http://localhost:4001/api/templates` → API_COUNT
2. navigate: `http://localhost:4000/templates` → UI_COUNT
3. navigate: `http://localhost:4000` → DASH_COUNT
4. assert: API_COUNT = UI_COUNT = DASH_COUNT

### XC-04: Agent count consistent

**Steps:**
1. curl: `GET http://localhost:4001/api/agents` → API_COUNT
2. navigate: `http://localhost:4000/agents` → UI_COUNT
3. assert: API_COUNT = UI_COUNT

### XC-05: Creating a resource updates all views

**Steps:**
1. create a new project via API
2. navigate: `http://localhost:4000/projects` → assert: new project visible
3. navigate: `http://localhost:4000` → assert: Projects card count incremented
4. wait: 10s (polling interval)
5. assert: dashboard reflects updated count

## Test Cases — Error Handling

### XC-06: Backend unavailable — dashboard graceful degradation

**Steps:**
1. stop the backend (`npm run dev:core` — kill it)
2. navigate: `http://localhost:4000`
3. assert: dashboard shows "Offline" status
4. assert: no crash, no unhandled error overlay
5. navigate to other pages (Projects, Skills)
6. assert: pages show error state but don't crash
7. restart backend
8. wait: 10s
9. assert: dashboard recovers to "Online"

### XC-07: Invalid resource IDs handled gracefully

**Steps:**
1. navigate: `http://localhost:4000/projects/invalid-id-99999`
2. assert: error message or redirect (not blank screen or crash)
3. curl: `GET http://localhost:4001/api/agents/invalid-id`
4. assert: status 404 with JSON error body
5. curl: `GET http://localhost:4001/api/task-trees/invalid-id`
6. assert: status 404

### XC-08: Sidebar navigation works during backend issues

**Steps:**
1. stop backend
2. click through sidebar links (Dashboard, Projects, Skills, etc.)
3. assert: client-side navigation works (URL changes, pages render)
4. assert: pages show loading/error states but app doesn't crash

## Test Cases — WebSocket Events

### XC-09: WebSocket connection resilience

**Steps:**
1. navigate: `http://localhost:4000`
2. assert: WebSocket connected
3. stop and restart backend
4. wait: 10s
5. assert: WebSocket reconnects automatically

### XC-10: Task events propagate to UI

**Steps:**
1. navigate: `http://localhost:4000`
2. trigger a task (via chat or template trigger)
3. assert: activity feed updates with task events
4. assert: dashboard status cards update (Active Agents, etc.)

## Test Cases — End-to-End Integration

### XC-11: Full flow — create project → chat → task tree → completion

**Steps:**
1. create a project via API or UI
2. navigate to project page
3. send a complex chat message that triggers PLANNED mode
4. assert: task tree created and visible
5. approve the task tree
6. wait for execution
7. assert: tasks complete with validation
8. assert: results visible in chat
9. navigate to Activity page
10. assert: events for the entire flow are logged

### XC-12: Template trigger → task tree → notification flow

**Steps:**
1. trigger a template via API
2. assert: task tree created
3. observe execution
4. assert: tasks complete
5. if template includes notify task: assert notification sent
6. navigate to Tasks page
7. assert: task tree visible with correct status

### XC-13: Console error check across all v2 pages

**Steps:**
1. navigate through all v2 pages:
   - Dashboard, Projects, Activity, Templates, Tasks, Agents, Skills, Schedules, Settings
2. check: console_messages for errors at each page
3. assert: no error-level console messages (warnings acceptable)
