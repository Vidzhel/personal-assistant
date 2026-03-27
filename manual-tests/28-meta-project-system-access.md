# 28 - Meta-Project & System Access Control (Story 10.3)

Verify the meta-project existence, system access control enforcement, and prompt-based access gating.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`)

## Test Cases — Meta-Project Existence (AC: 1, 8)

### META-01: Meta-project exists in database

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert:
   - one project has `isMeta` = true and `id` = "meta"
   - meta-project `name` = "Raven System"
   - meta-project `systemAccess` = "read-write"

### META-02: Meta-project pinned at top in dashboard

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. snapshot → assert:
   - "Raven System" project appears first or pinned with distinct icon/badge
   - visually distinguishable from regular projects (gear icon or similar)

### META-03: Meta-project chat works

**Steps:**
1. navigate to the Raven System project chat
2. send: "What projects exist?"
3. wait: for assistant response
4. assert: response includes information about existing projects (meta-project has system access)

### META-04: Meta-project cannot be deleted

**Steps:**
1. curl: `DELETE http://localhost:4001/api/projects/meta`
2. assert: status 400
3. curl: `GET http://localhost:4001/api/projects/meta`
4. assert: meta-project still exists

## Test Cases — System Access Levels (AC: 4, 5, 6)

### META-05: Default project has system_access = none

**Steps:**
1. create a new project:
   ```bash
   curl -X POST http://localhost:4001/api/projects \
     -H "Content-Type: application/json" \
     -d '{"name": "Test Project"}'
   ```
2. assert response: `systemAccess` = "none"

### META-06: Update project system access

**Steps:**
1. curl:
   ```bash
   curl -X PUT http://localhost:4001/api/projects/{id} \
     -H "Content-Type: application/json" \
     -d '{"systemAccess": "read"}'
   ```
2. assert response: `systemAccess` = "read"
3. curl:
   ```bash
   curl -X PUT http://localhost:4001/api/projects/{id} \
     -H "Content-Type: application/json" \
     -d '{"systemAccess": "read-write"}'
   ```
4. assert response: `systemAccess` = "read-write"

### META-07: Cannot set isMeta on regular project

**Steps:**
1. curl:
   ```bash
   curl -X PUT http://localhost:4001/api/projects/{id} \
     -H "Content-Type: application/json" \
     -d '{"isMeta": true}'
   ```
2. assert: status 400 or field ignored

## Test Cases — Prompt-Based Access Enforcement (AC: 4, 6, 7)

### META-08: No-access project blocks system file requests

**Steps:**
1. create a project with `systemAccess` = "none"
2. navigate to that project's chat
3. send: "Show me the contents of config/skills.json"
4. wait: for assistant response
5. assert: response explains that this project does not have system access

### META-09: Read-access project allows reading only

**Steps:**
1. set a project to `systemAccess` = "read"
2. navigate to that project's chat
3. send: "Show me the current pipeline configuration"
4. wait: for response → assert: response includes config information (read allowed)
5. send: "Modify the morning-briefing pipeline to run at 7am"
6. wait: for response → assert: response explains the project only has read access

### META-10: Read-write project can propose changes

**Steps:**
1. set a project to `systemAccess` = "read-write"
2. navigate to that project's chat
3. send: "Show me the morning-briefing pipeline and suggest improvements"
4. wait: for response → assert: response includes both reading config and suggestions

### META-11: Tool use instructions injected

**Steps:**
1. trigger any agent task in any project
2. check agent task logs for the prompt
3. assert: prompt includes instruction about purposeful tool use (not speculatively exploring codebase)

## Test Cases — Audit Logging (AC: 6)

### META-12: System access configuration is audited

**Steps:**
1. trigger a chat in a project with any system_access level
2. check audit log:
   ```bash
   curl http://localhost:4001/api/audit?action=system:access:configured
   ```
3. assert: audit entry exists with `projectId`, `systemAccess`, `projectName` details
