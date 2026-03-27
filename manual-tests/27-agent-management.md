# 27 - Agent Management & Skill Binding (Story 10.2)

Verify named agent CRUD, suite binding, agent resolver, orchestrator delegation, and dashboard management UI.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), at least one suite registered

## Test Cases — Agent CRUD API

### AGENT-01: List all agents

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert response:
   - status 200
   - JSON array returned
   - at least 1 agent (default orchestrator catch-all)
   - each agent has: `id`, `name`, `description`, `instructions`, `suiteIds`, `isDefault`, `createdAt`

### AGENT-02: Default agent exists

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert: one agent has `isDefault` = true
3. assert: default agent has `suiteIds` empty or includes all suites (catch-all)

### AGENT-03: Create a named agent

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/agents \
     -H "Content-Type: application/json" \
     -d '{"name": "test-agent", "description": "Test agent for manual testing", "instructions": "You are a test agent.", "suiteIds": []}'
   ```
2. assert response:
   - status 200 or 201
   - `name` = "test-agent"
   - `description` and `instructions` match input
   - `id` is a UUID
   - `isDefault` = false

### AGENT-04: Create agent with suite bindings

**Steps:**
1. get available suites: `GET http://localhost:4001/api/suites`
2. note a suite name
3. curl:
   ```bash
   curl -X POST http://localhost:4001/api/agents \
     -H "Content-Type: application/json" \
     -d '{"name": "bound-agent", "description": "Agent with suites", "suiteIds": ["{suiteName}"]}'
   ```
4. assert: `suiteIds` array contains the bound suite name

### AGENT-05: Update agent

**Steps:**
1. note agent ID from AGENT-03
2. curl:
   ```bash
   curl -X PUT http://localhost:4001/api/agents/{id} \
     -H "Content-Type: application/json" \
     -d '{"description": "Updated description", "instructions": "Updated instructions."}'
   ```
3. assert response:
   - `description` = "Updated description"
   - `name` unchanged

### AGENT-06: Delete agent

**Steps:**
1. curl: `DELETE http://localhost:4001/api/agents/{id}` (non-default agent)
2. assert: status 200 or 204
3. curl: `GET http://localhost:4001/api/agents/{id}`
4. assert: status 404

### AGENT-07: Cannot delete default agent

**Steps:**
1. find default agent ID: `GET http://localhost:4001/api/agents` → find `isDefault: true`
2. curl: `DELETE http://localhost:4001/api/agents/{defaultId}`
3. assert: status 400 or 403
4. curl: `GET http://localhost:4001/api/agents/{defaultId}`
5. assert: default agent still exists

### AGENT-08: Duplicate name rejected

**Steps:**
1. create agent with name "unique-agent" (AGENT-03 pattern)
2. attempt to create another with the same name
3. assert: status 400 or 409 with error about duplicate name

## Test Cases — Suite Binding & Resolution (AC: 2, 3, 4)

### AGENT-09: Bound agent only gets its suites' capabilities

**Steps:**
1. create agent bound to a single suite (e.g., "email")
2. assign agent to a project and start a chat
3. check agent task logs → assert:
   - only the bound suite's MCP servers are included in agent context
   - no MCP servers from other suites

### AGENT-10: Default agent gets all capabilities

**Steps:**
1. start a chat in a project using the default agent
2. check agent task logs → assert:
   - all registered suites' capabilities are available

## Test Cases — Git Auto-Commit (AC: 6)

### AGENT-11: Agent config changes committed to git

**Steps:**
1. create or update a named agent via API
2. check: `git log -1 --oneline -- config/agents.json`
3. assert: recent commit mentions agent config update
4. check: `cat config/agents.json`
5. assert: file contains the new/updated agent entry

## Test Cases — Dashboard UI (AC: 5, 6)

### AGENT-12: Agents page shows all agents

**Steps:**
1. navigate to the agents page in the dashboard
2. snapshot → assert:
   - each agent shows: name, description, assigned suites
   - task counts visible (completed, in-progress)
   - default agent has a distinct indicator

### AGENT-13: Agent form modal — create

**Steps:**
1. click "Create Agent" or similar button
2. snapshot → assert:
   - form with fields: name, description, instructions (textarea), suite bindings (checkboxes)
3. fill in form and submit
4. snapshot → assert: new agent appears in the list

### AGENT-14: Agent form modal — edit

**Steps:**
1. click edit on an existing agent
2. snapshot → assert:
   - form pre-filled with current values
3. modify description and save
4. snapshot → assert: updated description shown in list

### AGENT-15: Agent running indicator

**Steps:**
1. while an agent has running tasks
2. navigate to agents page
3. snapshot → assert:
   - green dot visible next to the agent name with running tasks

### AGENT-16: Agent task history link

**Steps:**
1. click task history link on an agent card
2. snapshot → assert:
   - navigates to filtered task view showing only that agent's tasks
   - tasks show chronological entries with title, status, duration, artifacts
