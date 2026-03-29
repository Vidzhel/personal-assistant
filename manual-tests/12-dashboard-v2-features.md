# 12 - Dashboard V2 Feature Pages

Validates the v2 dashboard pages: Tasks (board + tree view), Agent Monitor, and Execution Metrics.

Prerequisites: Both servers running, some completed task trees exist

## Test Cases — Tasks Page

### DFP-01: Tasks page header and tabs

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - heading "Tasks"
   - tabs: "Board", "Agent Monitor" (or similar)

### DFP-02: Board view with status columns

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. assert: board view displays columns:
   - "To Do" column
   - "In Progress" column
   - "Completed" column
3. assert: tasks are placed in correct columns by status

### DFP-03: List/Board view toggle

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. find: view toggle (board/list)
3. click: switch to list view
4. assert: tasks displayed as rows in a table/list
5. click: switch to board view
6. assert: tasks displayed as cards in columns

### DFP-04: Filter controls

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. assert: filter controls present (search, status dropdown, source dropdown)
3. type: search query
4. assert: tasks filtered by search text
5. select: status filter (e.g., "completed")
6. assert: only completed tasks shown

### DFP-05: Agent Monitor tab

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. click: "Agent Monitor" tab
3. snapshot → assert:
   - active agent sessions listed (or empty state)
   - each active agent shows: name, current task, duration
4. assert: polling updates agent status

### DFP-06: Agent Monitor terminate button

**Steps:**
1. if an agent is running:
2. click: terminate/cancel button next to the agent
3. assert: agent task cancelled
4. assert: agent disappears from active list after refresh

## Test Cases — Task Tree Visualization

### DFP-07: Task tree view

**Steps:**
1. navigate to a task tree detail (via Tasks page or URL)
2. assert: tree visualization shows:
   - nodes for each task in the tree
   - edges showing dependencies (blockedBy relationships)
   - color coding by status (green=completed, blue=running, gray=pending)

### DFP-08: Task tree approval controls

**Steps:**
1. find a task tree in `pending_approval` status
2. assert: "Approve" and "Cancel" buttons visible
3. click: "Approve"
4. assert: tree status changes to `running`
5. assert: tasks begin executing

### DFP-09: Task tree status updates in real-time

**Steps:**
1. observe a running task tree
2. assert: task statuses update as they progress (via WebSocket or polling)
3. assert: tree visualization reflects current status without manual refresh

## Test Cases — Execution Metrics

### DFP-10: Metrics page loads

**Steps:**
1. navigate: `http://localhost:4000/metrics` (or equivalent)
2. snapshot → assert:
   - period selector (1h, 24h, 7d, 30d)
   - summary cards: Total Tasks, Success Rate, Avg Duration

### DFP-11: Period selector changes data

**Steps:**
1. click: "24h" period button
2. assert: metrics refresh for 24h window
3. click: "7d"
4. assert: metrics refresh for 7d window
5. assert: counts change appropriately

### DFP-12: Per-skill breakdown table

**Steps:**
1. navigate to metrics page
2. assert: skill breakdown table shows:
   - skill name
   - task count
   - success rate
   - average duration

### DFP-13: Auto-refresh every 10 seconds

**Steps:**
1. navigate to metrics page
2. open Network tab
3. wait: 25s
4. assert: at least 2 metrics API requests visible
