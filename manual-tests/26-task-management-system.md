# 26 - Task Management System (Story 10.1)

Verify the advanced task management system: task CRUD, templates, agent assignment, TickTick sync, artifact tracking, archival, and task detail views.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), verified via health check

## Test Cases — Task CRUD API

### TASK-MGMT-01: Create a task via API

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/tasks \
     -H "Content-Type: application/json" \
     -d '{"title": "Test task", "description": "Manual test task", "status": "todo", "source": "manual"}'
   ```
2. assert response:
   - status 200 or 201
   - JSON body contains `id` (UUID), `title` = "Test task", `status` = "todo", `source` = "manual"
   - `created_at` and `updated_at` are ISO 8601 strings

### TASK-MGMT-02: List tasks with filters

**Steps:**
1. create 2+ tasks with different statuses (todo, in_progress)
2. curl: `GET http://localhost:4001/api/tasks?status=todo`
3. assert response:
   - status 200
   - all returned tasks have `status` = "todo"
4. curl: `GET http://localhost:4001/api/tasks?status=in_progress`
5. assert: only in_progress tasks returned

### TASK-MGMT-03: Update a task

**Steps:**
1. note a task ID from TASK-MGMT-01
2. curl:
   ```bash
   curl -X PATCH http://localhost:4001/api/tasks/{id} \
     -H "Content-Type: application/json" \
     -d '{"status": "in_progress", "description": "Updated description"}'
   ```
3. assert response:
   - status 200
   - `status` = "in_progress"
   - `description` = "Updated description"
   - `updated_at` changed from original

### TASK-MGMT-04: Complete a task with artifacts

**Steps:**
1. curl:
   ```bash
   curl -X PATCH http://localhost:4001/api/tasks/{id} \
     -H "Content-Type: application/json" \
     -d '{"status": "completed", "artifacts": ["data/reports/output.md", "data/logs/run.log"]}'
   ```
2. assert response:
   - `status` = "completed"
   - `completed_at` is set (ISO 8601)
   - `artifacts` array contains the two file paths

### TASK-MGMT-05: Get task by ID with full detail

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks/{id}`
2. assert response:
   - status 200
   - all fields present: `id`, `title`, `description`, `prompt`, `status`, `assigned_agent_id`, `project_id`, `artifacts`, `created_at`, `updated_at`, `completed_at`

### TASK-MGMT-06: Filter tasks by project

**Steps:**
1. create tasks assigned to different projects
2. curl: `GET http://localhost:4001/api/tasks?projectId={projectId}`
3. assert: only tasks for that project returned

## Test Cases — Task with Agent Assignment (AC: 2, 5)

### TASK-MGMT-07: Task assigned to named agent

**Steps:**
1. get list of named agents: `GET http://localhost:4001/api/agents`
2. create a task with `assigned_agent_id`:
   ```bash
   curl -X POST http://localhost:4001/api/tasks \
     -H "Content-Type: application/json" \
     -d '{"title": "Agent task", "assigned_agent_id": "{agentId}", "project_id": "{projectId}"}'
   ```
3. assert: task created with `assigned_agent_id` populated

### TASK-MGMT-08: Subtask linked via parent_task_id

**Steps:**
1. create a parent task (TASK-MGMT-01)
2. create a subtask:
   ```bash
   curl -X POST http://localhost:4001/api/tasks \
     -H "Content-Type: application/json" \
     -d '{"title": "Subtask", "parent_task_id": "{parentId}", "source": "agent"}'
   ```
3. assert: subtask has `parent_task_id` set
4. curl: `GET http://localhost:4001/api/tasks?parentTaskId={parentId}`
5. assert: subtask appears in results

## Test Cases — Task Archival (AC: 8)

### TASK-MGMT-09: Completed tasks are archived after 24h

**Steps:**
1. verify there are completed tasks older than 24 hours
2. trigger the archival job (if manual trigger exists) or wait for it to run
3. curl: `GET http://localhost:4001/api/tasks?status=archived`
4. assert: previously-completed tasks now show `status` = "archived"

### TASK-MGMT-10: Archived tasks hidden from default views

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks` (no status filter)
2. assert: no tasks with `status` = "archived" in default results
3. curl: `GET http://localhost:4001/api/tasks?status=archived`
4. assert: archived tasks queryable explicitly

## Test Cases — Task Count Dashboard (AC: 7)

### TASK-MGMT-11: Task counts by status

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks/counts`
2. assert response:
   - JSON object with keys: `todo`, `in_progress`, `completed`, `archived`
   - values are numbers matching actual task counts

### TASK-MGMT-12: Project-scoped task counts

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks/counts?projectId={projectId}`
2. assert: counts reflect only tasks for that project

## Test Cases — Tasks Page UI (AC: 7, 10, 11)

### TASK-MGMT-13: Tasks page shows task list

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - heading "Tasks" or tab for task views
   - tasks listed with: title, status badge, project name, source, timestamps
   - status grouping or filtering controls visible

### TASK-MGMT-14: Task detail view

**Steps:**
1. navigate to tasks page
2. click a task card/row
3. snapshot → assert:
   - full task metadata: title, description, status, project, assigned agent
   - prompt shown (if present)
   - artifact links shown (if present)
   - subtasks listed (if any)
   - parent task link (if subtask)
   - timestamps: created, updated, completed

### TASK-MGMT-15: Agent Monitor tab shows running agents

**Steps:**
1. trigger an agent task (send a chat message to start agent processing)
2. navigate to tasks page → Agent Monitor tab
3. snapshot → assert:
   - running/queued agents visible with: agent/skill name, project name, task prompt, elapsed time, status
   - empty state shown if nothing running

### TASK-MGMT-16: Agent Monitor terminate button

**Steps:**
1. while an agent is running, click "Terminate" on Agent Monitor tab
2. snapshot → assert:
   - task status changes to cancelled/failed
   - monitor updates in real-time

### TASK-MGMT-17: Agent Monitor auto-refresh

**Steps:**
1. open Agent Monitor tab with running agents
2. wait 10 seconds
3. monitor: network_requests → assert:
   - polling requests every ~3 seconds
   - at least 3 refresh cycles in 10 seconds
