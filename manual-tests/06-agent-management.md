# 06 - Agent Management (v2)

Validates YAML-based agent CRUD, skill binding (replaces suite binding), bash access configuration, and agent resolver.

Prerequisites: Both servers running, capability library loaded with skills

## Test Cases — Agent CRUD API

### AGT-01: List all agents

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert response:
   - status 200
   - JSON array returned
   - at least 1 agent (default agent)
   - each agent has: `id`, `name`, `description`, `skills`, `isDefault`, `createdAt`

**Notes:** In v2, agents have `skills` (array of library skill names) instead of `suiteIds`.

### AGT-02: Default agent exists

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert: one agent has `isDefault` = true
3. assert: default agent gets all capabilities (catch-all)

### AGT-03: Create a named agent with skills

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/agents \
     -H "Content-Type: application/json" \
     -d '{
       "name": "test-agent-v2",
       "description": "Test agent for v2",
       "instructions": "You are a test agent.",
       "skills": ["calendar-read", "raven-tasks"]
     }'
   ```
2. assert response:
   - status 200 or 201
   - `name` = "test-agent-v2"
   - `skills` array contains "calendar-read" and "raven-tasks"
   - `isDefault` = false
   - `id` is a UUID

### AGT-04: Get agent by ID

**Steps:**
1. note agent ID from AGT-03
2. curl: `GET http://localhost:4001/api/agents/{id}`
3. assert response:
   - status 200
   - `name` = "test-agent-v2"
   - `skills`, `description`, `instructions` match created values

### AGT-05: Update agent

**Steps:**
1. note agent ID from AGT-03
2. curl:
   ```bash
   curl -X PATCH http://localhost:4001/api/agents/{id} \
     -H "Content-Type: application/json" \
     -d '{"description": "Updated v2 description", "skills": ["calendar-read"]}'
   ```
3. assert response:
   - `description` = "Updated v2 description"
   - `skills` = ["calendar-read"] (raven-tasks removed)
   - `name` unchanged

### AGT-06: Delete agent

**Steps:**
1. note agent ID from AGT-03
2. curl: `DELETE http://localhost:4001/api/agents/{id}`
3. assert: status 200 or 204
4. curl: `GET http://localhost:4001/api/agents/{id}`
5. assert: status 404

### AGT-07: Cannot delete default agent

**Steps:**
1. find default agent ID: `GET http://localhost:4001/api/agents` → find `isDefault: true`
2. curl: `DELETE http://localhost:4001/api/agents/{defaultId}`
3. assert: status 400 or 403
4. curl: `GET http://localhost:4001/api/agents/{defaultId}`
5. assert: status 200 (still exists)

### AGT-08: Duplicate name rejected

**Steps:**
1. create agent "dup-test": `POST http://localhost:4001/api/agents` with `{"name": "dup-test", "description": "first"}`
2. assert: status 200 or 201
3. create another "dup-test": `POST http://localhost:4001/api/agents` with `{"name": "dup-test", "description": "second"}`
4. assert: status 409 or 400

### AGT-09: Agent resolver gives bound agent only its skills' capabilities

**Steps:**
1. create agent with specific skills (e.g., `skills: ["email-triage"]`)
2. verify via API that agent's resolved capabilities only include MCPs from those skills
3. assert: agent does NOT get MCPs from skills it doesn't have

**Notes:** In v2, agent capability resolution reads the agent's `skills` list, looks up each in the library, and collects only those MCPs. The default (catch-all) agent gets everything.

## Test Cases — Agent Form UI

### AGT-10: Agents page shows all agents

**Steps:**
1. navigate: `http://localhost:4000/agents` (or `/projects/{id}` → "Agents" tab)
2. snapshot → assert:
   - agent cards displayed
   - each card shows: name, description, model
   - default agent is visually marked

### AGT-11: Agent form includes v2 fields

**Steps:**
1. navigate to agents page
2. click: "New Agent" or create button
3. snapshot → assert form fields:
   - "Name" input
   - "Description" textarea
   - "Instructions" textarea
   - "Skills" multi-select (shows available library skills)
   - "Model" dropdown (haiku, sonnet, opus)
   - "Max Turns" number input
   - "Bash Access" dropdown (none, sandboxed, scoped, full)
   - "Project Scope" selector (which project this agent belongs to)

### AGT-12: Skill selection from library

**Steps:**
1. open agent create/edit form
2. click: "Skills" selector
3. assert: dropdown shows available skills from capability library
4. select 2 skills
5. assert: selected skills appear as chips/tags in the field

### AGT-13: Agent task history

**Steps:**
1. navigate to agents page
2. click: an agent card
3. assert: agent detail shows task history
4. curl: `GET http://localhost:4001/api/agents/{id}/tasks`
5. assert: response is array of tasks assigned to this agent
