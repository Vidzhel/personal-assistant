# 08 - Task Templates (Phase 4)

Validates unified task template system — CRUD, triggers, all task types, interpolation, forEach fan-out, and template scheduling.

Prerequisites: Both servers running, `projects/**/templates/` has at least one template YAML

## Test Cases — Template API

### TPL-01: List all templates

**Steps:**
1. curl: `GET http://localhost:4001/api/templates`
2. assert response:
   - status 200
   - JSON array returned
   - each template has: `name`, `displayName`, `tasks` (array), `trigger` (array)

### TPL-02: Get template by name

**Steps:**
1. curl: `GET http://localhost:4001/api/templates` → note a template `name`
2. curl: `GET http://localhost:4001/api/templates/{name}`
3. assert response:
   - status 200
   - has `name`, `displayName`, `description`
   - has `params` object (may be empty)
   - has `plan` with `approval` and `parallel` fields
   - has `tasks` array with at least 1 task

### TPL-03: Template tasks have correct structure

**Steps:**
1. curl: `GET http://localhost:4001/api/templates/{name}`
2. inspect `tasks` array
3. each task has: `id`, `type`, `title`
4. agent tasks have: `prompt`, optional `agent`
5. code tasks have: `script`
6. condition tasks have: `expression`
7. notify tasks have: `channel`, `message`
8. delay tasks have: `duration`
9. approval tasks have: `message`

### TPL-04: Non-existent template returns 404

**Steps:**
1. curl: `GET http://localhost:4001/api/templates/nonexistent-template`
2. assert: status 404

### TPL-05: Template trigger (manual)

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/templates/{name}/trigger \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
2. assert response:
   - status 200 or 202
   - response includes a task tree ID or run ID

### TPL-06: Template trigger with params

**Steps:**
1. find a template with defined `params` (e.g., `date` param)
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/templates/{name}/trigger \
     -H "Content-Type: application/json" \
     -d '{"params": {"date": "2026-03-29"}}'
   ```
3. assert: status 200 or 202
4. assert: the created task tree uses the provided params

## Test Cases — Task Types

### TPL-07: Agent task type executes correctly

**Steps:**
1. trigger a template that contains an `agent` type task
2. wait for execution
3. assert: agent task spawned an agent, produced a summary and artifacts

### TPL-08: Code task type executes a script

**Steps:**
1. trigger a template with a `code` type task
2. wait for execution
3. assert: script ran, stdout captured as artifact
4. assert: zero tokens consumed (deterministic execution)

### TPL-09: Condition task evaluates expression

**Steps:**
1. trigger a template with a `condition` type task
2. wait for execution
3. assert: condition task has `result` (boolean)
4. assert: downstream tasks with `runIf` referencing this condition behave correctly (skip if false)

### TPL-10: Notify task sends notification

**Steps:**
1. trigger a template with a `notify` type task
2. assert: notification was sent to the specified channel (check Telegram or event log)

### TPL-11: Delay task pauses execution

**Steps:**
1. trigger a template with a `delay` type task (short duration, e.g., "5s" for testing)
2. observe: task stays in `in_progress` for the delay duration
3. after duration: task completes and unblocks dependents

### TPL-12: Approval task pauses for user input

**Steps:**
1. trigger a template with an `approval` type task
2. assert: task status = `pending_approval`
3. assert: template execution pauses at this task
4. approve via API: `POST /api/task-trees/{treeId}/tasks/{taskId}/approve`
5. assert: execution resumes

## Test Cases — Interpolation & Dynamic Behavior

### TPL-13: Template parameter interpolation

**Steps:**
1. trigger a template with a `date` param set to "today"
2. observe agent task prompts
3. assert: `{{ date }}` in task prompts is replaced with "today"

### TPL-14: Cross-task artifact reference

**Steps:**
1. trigger a template where task B references `{{ task-a.summary }}`
2. wait for task A to complete
3. observe task B's prompt
4. assert: `{{ task-a.summary }}` replaced with task A's actual summary text

### TPL-15: forEach dynamic fan-out

**Steps:**
1. trigger a template with a `forEach` task
2. assert: multiple child tasks created (one per item in the forEach collection)
3. assert: each child task has `{{ item }}` resolved to the correct collection element

## Test Cases — Templates UI

### TPL-16: Templates page lists all templates

**Steps:**
1. navigate: `http://localhost:4000/templates`
2. snapshot → assert:
   - heading "Templates"
   - template cards displayed
   - each card shows: name, description, trigger type badges

### TPL-17: Template trigger from UI

**Steps:**
1. navigate: `http://localhost:4000/templates`
2. find a template with manual trigger
3. click: "Run" or "Trigger" button
4. assert: confirmation shown or task tree created
5. navigate to Tasks page
6. assert: new task tree visible

### TPL-18: Template count matches API

**Steps:**
1. curl: `GET http://localhost:4001/api/templates` → note length
2. navigate: `http://localhost:4000/templates` → count visible templates
3. assert: counts match
