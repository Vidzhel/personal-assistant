# 16 - Task Management Page (Story 5.4 / 10.1)

Verify the Tasks page with dual-tab layout: Tasks board/list and Agent Monitor.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`)

## Test Cases — Tasks Tab (Board View)

### TASK-01: Page header and tabs

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - heading "Tasks"
   - text "Manage work items across all sources."
   - button "Tasks" (tab, active by default)
   - button "Agent Monitor" (tab)

### TASK-02: Board view with three columns

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - text "To Do" with count
   - text "In Progress" with count
   - text "Completed" with count

### TASK-03: List/Board view toggle

**Steps:**
1. snapshot → find button for view toggle (List/Board)
2. click: List view button → snapshot → assert:
   - task items displayed as list rows
3. click: Board view button → snapshot → assert:
   - task items displayed in columns

### TASK-04: Filter controls

**Steps:**
1. snapshot → assert:
   - textbox for search
   - combobox or dropdown for status filter (todo, in_progress, completed)
   - combobox or dropdown for source filter (manual, agent, template, ticktick, pipeline)

### TASK-05: Empty column state

**Steps:**
1. If any column has 0 count, snapshot → assert:
   - text "No tasks" in empty column

## Test Cases — Agent Monitor Tab

### TASK-06: Agent Monitor tab content

**Steps:**
1. click: button "Agent Monitor"
2. snapshot → assert:
   - text "No agents currently active" (if no agents running)
   - button "Show Recent Executions" with count

### TASK-07: Recent executions list

**Steps:**
1. click: button "Show Recent Executions"
2. snapshot → assert:
   - list of past agent runs
   - each entry shows: skill name, status badge (completed/failed), duration

### TASK-08: Execution entry details

**Steps:**
1. snapshot → assert entries show:
   - skill name (e.g., "orchestrator", "task-management")
   - status text ("completed" or "failed")
   - duration (e.g., "69.3s")
