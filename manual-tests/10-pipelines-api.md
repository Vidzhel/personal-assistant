# 10 - Pipelines API (Epic 2)

Verify pipeline YAML loading, CRUD API, manual triggering, execution history, and validation. These are backend-only API tests — no frontend UI exists for pipelines yet.

Prerequisites: Backend running (`npm run dev:core`), verified via `curl http://localhost:4001/api/health`

## Test Cases — Pipeline Listing (Story 2-1)

### PIPE-01: List all pipelines

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines`
2. assert response:
   - status 200
   - JSON array returned
   - at least 1 pipeline (morning-briefing should be loaded from config/pipelines/)

### PIPE-02: Get single pipeline by name

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/morning-briefing`
2. assert response:
   - status 200
   - JSON object with `config.name` = "morning-briefing"
   - `config.trigger.type` = "cron"
   - `config.trigger.schedule` = "0 6 * * *"
   - `executionOrder` is an array (DAG was validated)
   - `entryPoints` is an array with at least 1 entry

### PIPE-03: Get non-existent pipeline returns 404

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/does-not-exist`
2. assert response:
   - status 404
   - JSON body contains `error` field

### PIPE-04: Pipeline has correct node structure

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/morning-briefing`
2. assert response:
   - `config.nodes` is an object with keys: fetch-emails, fetch-tasks, check-urgency, compile-briefing, send-message
   - `config.connections` is an array with 4 connections
   - `config.settings.retry.maxAttempts` = 3
   - `config.settings.onError` = "stop"
   - `config.enabled` = true

## Test Cases — Pipeline CRUD (Story 2-5)

### PIPE-05: Create pipeline via PUT

**Steps:**
1. curl: `PUT http://localhost:4001/api/pipelines/test-pipeline` with Content-Type `text/yaml` and body:
   ```yaml
   name: test-pipeline
   description: Test pipeline for API validation
   version: 1
   trigger:
     type: manual
   nodes:
     step-one:
       skill: digest
       action: compile-briefing
       params: {}
   connections: []
   enabled: true
   ```
2. assert response:
   - status 200
   - JSON body contains `config.name` = "test-pipeline"
   - `config.trigger.type` = "manual"
3. curl: `GET http://localhost:4001/api/pipelines/test-pipeline`
4. assert response:
   - status 200
   - pipeline exists in the registry

### PIPE-06: PUT validates before writing — invalid YAML

**Steps:**
1. curl: `PUT http://localhost:4001/api/pipelines/bad-pipeline` with Content-Type `text/yaml` and body:
   ```yaml
   name: bad-pipeline
   description: Missing required fields
   ```
2. assert response:
   - status 400
   - JSON body contains `error` with validation details

### PIPE-07: PUT rejects name mismatch

**Steps:**
1. curl: `PUT http://localhost:4001/api/pipelines/my-pipeline` with Content-Type `text/yaml` and body:
   ```yaml
   name: different-name
   version: 1
   trigger:
     type: manual
   nodes:
     step-one:
       skill: digest
       action: test
       params: {}
   connections: []
   enabled: true
   ```
2. assert response:
   - status 400
   - JSON body `error` contains "must match URL parameter"

### PIPE-08: Update existing pipeline via PUT

**Steps:**
1. First create: `PUT http://localhost:4001/api/pipelines/test-pipeline` (from PIPE-05)
2. Update: `PUT http://localhost:4001/api/pipelines/test-pipeline` with Content-Type `text/yaml` and body:
   ```yaml
   name: test-pipeline
   description: Updated description
   version: 1
   trigger:
     type: manual
   nodes:
     step-one:
       skill: digest
       action: compile-briefing
       params: {}
     step-two:
       skill: telegram
       action: send-message
       params: {}
   connections:
     - from: step-one
       to: step-two
   enabled: true
   ```
3. assert response:
   - status 200
   - `config.description` = "Updated description"
   - `config.nodes` has 2 nodes (step-one, step-two)
4. curl: `GET http://localhost:4001/api/pipelines/test-pipeline`
5. assert: updated pipeline is in registry

### PIPE-09: Delete pipeline

**Steps:**
1. Ensure test-pipeline exists (from PIPE-05/08)
2. curl: `DELETE http://localhost:4001/api/pipelines/test-pipeline`
3. assert response:
   - status 204
4. curl: `GET http://localhost:4001/api/pipelines/test-pipeline`
5. assert response:
   - status 404 (pipeline removed)

### PIPE-10: Delete non-existent pipeline returns 404

**Steps:**
1. curl: `DELETE http://localhost:4001/api/pipelines/does-not-exist`
2. assert response:
   - status 404
   - JSON body contains `error` field

## Test Cases — Manual Trigger (Story 2-2)

### PIPE-11: Trigger pipeline manually — 202 accepted

**Steps:**
1. curl: `POST http://localhost:4001/api/pipelines/morning-briefing/trigger`
2. assert response:
   - status 202
   - JSON body contains `runId` (UUID format)
   - JSON body contains `status` = "started"

**Notes:** Execution runs in background. The 202 response returns immediately — pipeline may still be executing.

### PIPE-12: Trigger non-existent pipeline — 404

**Steps:**
1. curl: `POST http://localhost:4001/api/pipelines/does-not-exist/trigger`
2. assert response:
   - status 404
   - JSON body contains `error` = "Pipeline not found"

### PIPE-13: Trigger disabled pipeline — 400

**Steps:**
1. First create a disabled pipeline:
   ```yaml
   name: disabled-test
   version: 1
   trigger:
     type: manual
   nodes:
     step-one:
       skill: digest
       action: test
       params: {}
   connections: []
   enabled: false
   ```
2. curl: `POST http://localhost:4001/api/pipelines/disabled-test/trigger`
3. assert response:
   - status 400
   - JSON body contains `error` = "Pipeline is disabled"
4. Cleanup: `DELETE http://localhost:4001/api/pipelines/disabled-test`

## Test Cases — Execution History (Story 2-2)

### PIPE-14: Get pipeline runs

**Steps:**
1. Trigger morning-briefing (PIPE-11) → wait 5s for execution
2. curl: `GET http://localhost:4001/api/pipelines/morning-briefing/runs`
3. assert response:
   - status 200
   - JSON array returned
   - at least 1 run entry
   - each run has: `id`, `pipeline_name`, `trigger_type`, `status`, `started_at`

### PIPE-15: Get pipeline runs with limit

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/morning-briefing/runs?limit=1`
2. assert response:
   - status 200
   - JSON array with at most 1 entry

### PIPE-16: Pipeline run has correct fields

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/morning-briefing/runs?limit=1`
2. assert first run entry:
   - `id` is a UUID string
   - `pipeline_name` = "morning-briefing"
   - `trigger_type` is one of: "cron", "event", "manual"
   - `status` is one of: "running", "completed", "failed"
   - `started_at` is ISO 8601 format
   - `node_results` is a JSON string (when present)

## Test Cases — DAG Validation (Story 2-1)

### PIPE-17: Reject pipeline with cycle

**Steps:**
1. curl: `PUT http://localhost:4001/api/pipelines/cycle-test` with Content-Type `text/yaml` and body:
   ```yaml
   name: cycle-test
   version: 1
   trigger:
     type: manual
   nodes:
     node-a:
       skill: digest
       action: test
       params: {}
     node-b:
       skill: digest
       action: test
       params: {}
   connections:
     - from: node-a
       to: node-b
     - from: node-b
       to: node-a
   enabled: true
   ```
2. assert response:
   - status 400
   - JSON body `error` contains "DAG validation failed" or cycle-related message

### PIPE-18: Reject pipeline with invalid node reference

**Steps:**
1. curl: `PUT http://localhost:4001/api/pipelines/bad-ref-test` with Content-Type `text/yaml` and body:
   ```yaml
   name: bad-ref-test
   version: 1
   trigger:
     type: manual
   nodes:
     node-a:
       skill: digest
       action: test
       params: {}
   connections:
     - from: node-a
       to: ghost-node
   enabled: true
   ```
2. assert response:
   - status 400
   - JSON body `error` contains reference to missing node

## Test Cases — Existing Routes Not Broken (Story 2-5)

### PIPE-19: Health endpoint still works

**Steps:**
1. curl: `GET http://localhost:4001/api/health`
2. assert response:
   - status 200
   - JSON body contains `status` = "ok"

### PIPE-20: All existing API routes functional

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines` → assert: status 200
2. curl: `GET http://localhost:4001/api/pipelines/morning-briefing` → assert: status 200
3. curl: `GET http://localhost:4001/api/pipelines/morning-briefing/runs` → assert: status 200

**Notes:** Verifies that CRUD additions (PUT/DELETE) didn't break existing GET/POST routes.
