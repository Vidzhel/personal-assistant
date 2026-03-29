# 07 - Task Execution Engine (Phase 3)

Validates task tree lifecycle, dependency resolution, three-gate validation pipeline, retry with feedback, and task status transitions.

Prerequisites: Both servers running, at least one agent configured

## Test Cases — Task Tree API

### TEE-01: List task trees

**Steps:**
1. curl: `GET http://localhost:4001/api/task-trees`
2. assert response:
   - status 200
   - JSON array returned (may be empty)

### TEE-02: Get task tree by ID

**Steps:**
1. trigger a planned task (send a complex request via chat that creates a task tree)
2. curl: `GET http://localhost:4001/api/task-trees`
3. note a tree `id`
4. curl: `GET http://localhost:4001/api/task-trees/{id}`
5. assert response:
   - status 200
   - has `id`, `status`, `tasks` (array or map), `createdAt`
   - `status` is one of: `pending_approval`, `running`, `completed`, `failed`, `cancelled`

### TEE-03: Task tree contains execution tasks

**Steps:**
1. curl: `GET http://localhost:4001/api/task-trees/{id}`
2. inspect `tasks` field
3. assert each task has:
   - `id` (string)
   - `node` with `type` field (agent, code, condition, notify, delay, approval)
   - `status` (pending_approval, todo, ready, in_progress, validating, completed, failed, blocked, skipped, cancelled)
   - `artifacts` (array)
   - `retryCount` (number)

### TEE-04: Non-existent tree returns 404

**Steps:**
1. curl: `GET http://localhost:4001/api/task-trees/nonexistent-id`
2. assert: status 404

## Test Cases — Task Status Transitions

### TEE-05: Task tree status lifecycle

**Steps:**
1. create a task tree that requires approval (e.g., PLANNED mode)
2. curl: `GET http://localhost:4001/api/task-trees/{id}`
3. assert: `status` = `pending_approval`
4. curl: `POST http://localhost:4001/api/task-trees/{id}/approve`
5. assert: status 200
6. curl: `GET http://localhost:4001/api/task-trees/{id}`
7. assert: `status` = `running`
8. wait for completion
9. curl: `GET http://localhost:4001/api/task-trees/{id}`
10. assert: `status` = `completed` or `failed`

### TEE-06: Cancel a running task tree

**Steps:**
1. start a task tree (approve it)
2. curl: `POST http://localhost:4001/api/task-trees/{id}/cancel`
3. assert: status 200
4. curl: `GET http://localhost:4001/api/task-trees/{id}`
5. assert: `status` = `cancelled`
6. assert: all non-completed tasks are `cancelled`

### TEE-07: Individual task approval within a tree

**Steps:**
1. find a tree with an approval-type task
2. curl: `POST http://localhost:4001/api/task-trees/{treeId}/tasks/{taskId}/approve`
3. assert: status 200
4. curl: `GET http://localhost:4001/api/task-trees/{treeId}`
5. assert: the approved task status changed from `pending_approval`

## Test Cases — Dependency Resolution

### TEE-08: Tasks with no dependencies start immediately

**Steps:**
1. create/observe a task tree with independent tasks (no `blockedBy`)
2. approve the tree
3. assert: all root tasks (no blockedBy) move to `ready` or `in_progress` simultaneously
4. assert: tasks with `blockedBy` remain in `todo` until dependencies complete

### TEE-09: Dependent tasks unblock after predecessor completes

**Steps:**
1. observe a task tree with A → B dependency (B `blockedBy: [A]`)
2. wait for task A to complete
3. assert: task B status changes from `todo` to `ready` or `in_progress`

### TEE-10: Circular dependency detection

**Steps:**
1. (unit test level) verify that the dependency resolver rejects task trees where A blocks B and B blocks A
2. assert: tree creation fails with a meaningful error about circular dependencies

**Notes:** This is enforced at tree creation time by `validateDag()` in `dependency-resolver.ts`.

## Test Cases — Three-Gate Validation Pipeline

### TEE-11: Gate 1 — Programmatic validation

**Steps:**
1. observe a completed agent task in a tree
2. curl: `GET http://localhost:4001/api/task-trees/{id}`
3. find the completed task
4. assert: `validationResult.gate1Passed` = true
5. assert: task has `summary` (non-empty string)

**Notes:** Gate 1 checks: did agent set status to completed? Are required artifacts present? Do artifacts exist on disk?

### TEE-12: Gate 2 — Evaluator agent validation

**Steps:**
1. observe a completed task where evaluator is enabled (default)
2. assert: `validationResult.gate2Passed` is true or false
3. if false, assert: `validationResult.gate2Reason` is a non-empty string explaining failure

**Notes:** Gate 2 spawns a Haiku model evaluator that gives binary PASS/FAIL with one-sentence reason.

### TEE-13: Gate 3 — Quality review (when enabled)

**Steps:**
1. create a task with `validation.qualityReview: true` in its config
2. wait for task completion and validation
3. assert: `validationResult.gate3Score` is a number 1-5
4. assert: `validationResult.gate3Feedback` is present
5. if score < threshold: `validationResult.gate3Passed` = false

### TEE-14: Retry on validation failure

**Steps:**
1. observe a task that failed validation (any gate)
2. assert: `retryCount` incremented
3. assert: task was re-queued with feedback from the failure
4. assert: `lastError` contains the failure reason
5. if `retryCount` < `maxRetries`: task runs again
6. if `retryCount` >= `maxRetries`: task status = `failed`

## Test Cases — Task Artifacts

### TEE-15: Task artifacts attached on completion

**Steps:**
1. observe a completed task in a tree
2. curl: `GET http://localhost:4001/api/task-trees/{id}`
3. find the completed task
4. assert: `artifacts` is an array
5. each artifact has: `type` (file, data, reference), `label`
6. file artifacts have `filePath` that exists on disk

### TEE-16: Downstream tasks can reference upstream artifacts

**Steps:**
1. observe a tree where task B depends on task A
2. task A completes with artifacts
3. task B's prompt or context includes references to task A's results
4. assert: task B can access task A's summary and artifact data

## Test Cases — Task Management API (CRUD)

### TEE-17: List tasks with filters

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks`
2. assert: status 200, JSON array
3. curl: `GET http://localhost:4001/api/tasks?status=completed`
4. assert: all returned tasks have status "completed"

### TEE-18: Get task counts by status

**Steps:**
1. curl: `GET http://localhost:4001/api/tasks/counts`
2. assert: status 200
3. assert: JSON has counts per status (queued, running, completed, failed)

### TEE-19: Create a standalone task

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/tasks \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Test task for v2", "skillName": "system", "priority": "normal"}'
   ```
2. assert response:
   - status 200 or 201
   - `id` present
   - `status` = "queued"

### TEE-20: Complete a task

**Steps:**
1. note task ID from TEE-19
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/tasks/{id}/complete \
     -H "Content-Type: application/json" \
     -d '{"result": "Task completed successfully", "artifacts": []}'
   ```
3. assert: status 200
4. curl: `GET http://localhost:4001/api/tasks/{id}`
5. assert: `status` = "completed"
