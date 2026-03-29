# V2 Manual Test Rewrite Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite all 32 manual test files to validate the Raven v2 architecture — capability library, project hierarchy, task execution engine, unified templates, permissions, agent builder, and updated dashboard.

**Architecture:** The v2 architecture replaces suite-based organization with a capability library, DB-stored agents with YAML filesystem agents, pipelines with unified task templates, and adds a task execution engine with three-gate validation. Tests are organized by v2 phase (matching the spec sections) rather than by v1 feature stories. Each test file is a standalone markdown document with numbered test cases using the existing manual test format (`navigate:`, `curl:`, `snapshot → assert:`, `click:`, etc.).

**Tech Stack:** Markdown manual test files, curl for API testing, browser assertions for UI testing, Fastify REST API, Next.js dashboard, SQLite database, WebSocket for live updates.

---

## File Structure

All files live in `manual-tests/`. The old 32 files are replaced with 15 focused v2 test files:

| New File | Covers | Replaces (v1) |
|----------|--------|---------------|
| `01-smoke-test.md` | Health, routes, console errors | 01 |
| `02-navigation-layout.md` | Sidebar, routing, responsive | 02 |
| `03-dashboard.md` | Status cards, life dashboard, polling | 03 |
| `04-capability-library.md` | Skill library API + browser, MCPs, progressive disclosure | 06 (skills part) |
| `05-project-hierarchy.md` | Filesystem projects, tree view, inheritance, context chain | 04 (project part), 28 |
| `06-agent-management.md` | YAML agents, skills binding, bash config, resolver | 27 |
| `07-task-execution-engine.md` | Task trees, dependency resolution, validation pipeline, retry | 13, 14, 26 |
| `08-task-templates.md` | Template CRUD, triggers, task types, interpolation, forEach | 10, 15 |
| `09-permissions-bash-access.md` | Graduated bash, bash gate, approval flow, audit | 28 (access part) |
| `10-agent-builder.md` | Scaffolding API, domain creation, verification | NEW |
| `11-chat-sessions.md` | Chat, sessions, task-board protocol, orchestrator triage | 04 (chat part), 09, 32 |
| `12-dashboard-v2-features.md` | Template page, task tree viz, skill browser, agent form | 16, 17 |
| `13-cross-cutting-verification.md` | Data consistency, error handling, WebSocket events | 07, 08 |
| `14-schedules-notifications.md` | Template scheduling, cron triggers, notification delivery | 06 (schedules part), 23, 24, 25 |
| `15-knowledge-system.md` | Knowledge graph, context injection, lifecycle, retrospective | 18, 19, 20, 21 |

**Files to delete (v1 tests fully superseded):**
All 32 existing files in `manual-tests/` (01 through 32). The v2 tests cover all functionality with updated expectations.

---

## V1 → V2 Terminology Mapping

Tests must use v2 terminology consistently:

| V1 Term | V2 Term |
|---------|---------|
| Suite | Capability / Skill (from library) |
| `suiteIds` on agents | `skills` array (library skill names) |
| Pipeline | Task Template |
| Pipeline node | Template task (with `type` field) |
| Pipeline run | Template instance / Task tree |
| `config/agents.json` | `projects/**/agents/*.yaml` |
| `config/suites.json` | `library/skills/**/config.json` |
| Agent task (flat) | Execution task (in a task tree) |
| Orchestrator relay | Orchestrator triage → engine execution |
| Binary bash access | Graduated bash access (none/sandboxed/scoped/full) |
| DB project | Filesystem `ProjectNode` |

---

### Task 1: Delete old v1 test files and create test directory structure

**Files:**
- Delete: all 32 files in `manual-tests/`

- [ ] **Step 1: Remove all v1 test files**

```bash
rm manual-tests/01-smoke-test.md
rm manual-tests/02-navigation-and-layout.md
rm manual-tests/03-dashboard.md
rm manual-tests/04-projects-and-chat.md
rm manual-tests/05-activity-page.md
rm manual-tests/06-skills-schedules-settings.md
rm manual-tests/07-cross-cutting-and-data-verification.md
rm manual-tests/08-integration-flows.md
rm manual-tests/09-sessions.md
rm manual-tests/10-pipelines-api.md
rm manual-tests/11-email-auto-triage.md
rm manual-tests/12-email-action-extraction.md
rm manual-tests/13-autonomous-task-management.md
rm manual-tests/14-stale-task-detection.md
rm manual-tests/15-pipeline-monitor.md
rm manual-tests/16-kanban-task-board.md
rm manual-tests/17-execution-metrics.md
rm manual-tests/18-knowledge-context-injection.md
rm manual-tests/19-knowledge-lifecycle.md
rm manual-tests/20-knowledge-graph.md
rm manual-tests/21-knowledge-context-ui.md
rm manual-tests/22-pattern-analysis-engine.md
rm manual-tests/23-urgency-tier-delivery-timing.md
rm manual-tests/24-engagement-based-throttling.md
rm manual-tests/25-category-snooze-notification-preferences.md
rm manual-tests/26-task-management-system.md
rm manual-tests/27-agent-management.md
rm manual-tests/28-meta-project-system-access.md
rm manual-tests/29-system-maintenance.md
rm manual-tests/30-conversational-config.md
rm manual-tests/31-config-history.md
rm manual-tests/32-session-retrospective.md
```

- [ ] **Step 2: Verify directory is empty**

```bash
ls manual-tests/
```

Expected: empty directory

- [ ] **Step 3: Commit**

```bash
git add -u manual-tests/
git commit -m "chore: remove v1 manual test files (superseded by v2 rewrite)"
```

---

### Task 2: Write 01-smoke-test.md

**Files:**
- Create: `manual-tests/01-smoke-test.md`

- [ ] **Step 1: Write the test file**

```markdown
# 01 - Smoke Test (v2)

Quick prerequisite validation. Run first before any other tests.

Prerequisites: Both servers running (`npm run dev:core` + `npm run dev:web`)

## Test Cases — Backend Health

### SM-01: API health endpoint responds

**Steps:**
1. curl: `GET http://localhost:4001/api/health`
2. assert response:
   - status 200
   - JSON has `status` = "ok"
   - JSON has `uptime` (number > 0)

### SM-02: API returns skill list

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. assert response:
   - status 200
   - JSON array returned
   - at least 1 skill entry

### SM-03: API returns project list

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert response:
   - status 200
   - JSON array returned

### SM-04: API returns template list

**Steps:**
1. curl: `GET http://localhost:4001/api/templates`
2. assert response:
   - status 200
   - JSON array returned

### SM-05: API returns agent list

**Steps:**
1. curl: `GET http://localhost:4001/api/agents`
2. assert response:
   - status 200
   - JSON array with at least 1 agent (default)

### SM-06: Task trees endpoint responds

**Steps:**
1. curl: `GET http://localhost:4001/api/task-trees`
2. assert response:
   - status 200
   - JSON array returned (may be empty)

## Test Cases — Frontend Health

### SM-07: Dashboard loads successfully

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"
   - NO error overlay or blank screen

### SM-08: All v2 routes load without errors

**Steps:**
1. navigate: `http://localhost:4000` → assert: heading "Dashboard"
2. click: link "Projects" → wait: 1s → assert: heading "Projects"
3. click: link "Activity" → wait: 1s → assert: heading "Activity Timeline"
4. click: link "Templates" → wait: 1s → assert: heading "Templates"
5. click: link "Tasks" → wait: 1s → assert: heading "Tasks"
6. click: link "Agents" → wait: 1s → assert: heading "Agents"
7. click: link "Skills" → wait: 1s → assert: heading "Skills"
8. click: link "Schedules" → wait: 1s → assert: heading "Schedules"
9. click: link "Settings" → wait: 1s → assert: heading "Settings"
10. click: link "Dashboard" → wait: 1s → assert: heading "Dashboard"

**Notes:** Each navigation should update the URL. No blank screens or error overlays at any step.

### SM-09: No JavaScript console errors on navigation

**Steps:**
1. navigate: `http://localhost:4000`
2. navigate through all routes from SM-08
3. check: console_messages for errors
4. assert: no `error` level messages (warnings are acceptable)

### SM-10: WebSocket connection established

**Steps:**
1. navigate: `http://localhost:4000`
2. wait: 2s
3. check: WebSocket connection to `ws://localhost:4001/ws` is open
4. assert: connection state = OPEN
```

- [ ] **Step 2: Verify file renders correctly**

```bash
head -5 manual-tests/01-smoke-test.md
```

Expected: `# 01 - Smoke Test (v2)` as first line

- [ ] **Step 3: Commit**

```bash
git add manual-tests/01-smoke-test.md
git commit -m "test: add v2 smoke test (01)"
```

---

### Task 3: Write 02-navigation-layout.md

**Files:**
- Create: `manual-tests/02-navigation-layout.md`

- [ ] **Step 1: Write the test file**

```markdown
# 02 - Navigation & Layout (v2)

Validates sidebar navigation, active states, routing, and responsive design for the v2 dashboard.

Prerequisites: Both servers running

## Test Cases — Sidebar Structure

### NAV-01: Sidebar renders all v2 navigation links

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert sidebar contains:
   - text "RAVEN"
   - link "Dashboard"
   - link "Projects"
   - link "Activity"
   - link "Templates"
   - link "Tasks"
   - link "Agents"
   - link "Skills"
   - link "Schedules"
   - link "Settings"

**Notes:** "Pipelines" link from v1 is removed. "Templates" and "Tasks" replace it. "Agents" and "Skills" are separate from the old combined page.

### NAV-02: Active state highlights current route

**Steps:**
1. navigate: `http://localhost:4000`
2. assert: "Dashboard" link has active styling (highlighted background or font weight)
3. click: link "Projects"
4. wait: 1s
5. assert: "Projects" link has active styling
6. assert: "Dashboard" link does NOT have active styling

### NAV-03: Active state persists on sub-routes

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. assert: "Projects" link has active styling
3. click: any project card (or navigate to `/projects/{id}`)
4. wait: 1s
5. assert: "Projects" link still has active styling (sub-route keeps parent active)

### NAV-04: Client-side navigation (no full page reload)

**Steps:**
1. navigate: `http://localhost:4000`
2. click: link "Projects"
3. assert: URL changed to `/projects` without full page reload (check: no browser loading indicator)
4. click: link "Templates"
5. assert: URL changed to `/templates` without full reload

## Test Cases — Responsive Layout

### NAV-05: Desktop layout (1280px+)

**Steps:**
1. navigate: `http://localhost:4000`
2. set viewport: 1280×800
3. snapshot → assert:
   - sidebar is visible and expanded
   - main content area has generous width
   - cards display in multi-column grid

### NAV-06: Tablet layout (768-1279px)

**Steps:**
1. set viewport: 768×1024
2. navigate: `http://localhost:4000`
3. snapshot → assert:
   - sidebar collapses or shows icons only
   - main content fills available width
   - cards stack into fewer columns

### NAV-07: Mobile layout (<768px)

**Steps:**
1. set viewport: 375×812
2. navigate: `http://localhost:4000`
3. snapshot → assert:
   - sidebar is hidden (hamburger menu or similar toggle)
   - content is single column
   - no horizontal scrollbar
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/02-navigation-layout.md
git commit -m "test: add v2 navigation & layout tests (02)"
```

---

### Task 4: Write 03-dashboard.md

**Files:**
- Create: `manual-tests/03-dashboard.md`

- [ ] **Step 1: Write the test file**

```markdown
# 03 - Dashboard (v2)

Verifies dashboard status cards, life dashboard, live activity, and health polling for v2.

Prerequisites: Both servers running

## Test Cases — Status Cards

### DASH-01: Dashboard header and structure

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"
   - status indicator showing "Online" or "Offline"

### DASH-02: Status cards display live data

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert presence of status cards:
   - "Status" card (Online/Offline indicator)
   - "Skills" card (count from capability library)
   - "Projects" card (count from project registry)
   - "Agents Running" card (count of active agent tasks)
   - "Templates" card (count from template registry)
   - "Schedules" card (count of active schedules)

### DASH-03: Status card counts match API data

**Steps:**
1. curl: `GET http://localhost:4001/api/skills` → note array length as SKILL_COUNT
2. curl: `GET http://localhost:4001/api/projects` → note array length as PROJECT_COUNT
3. curl: `GET http://localhost:4001/api/templates` → note array length as TEMPLATE_COUNT
4. curl: `GET http://localhost:4001/api/schedules` → note array length as SCHEDULE_COUNT
5. navigate: `http://localhost:4000`
6. assert: Skills card shows SKILL_COUNT
7. assert: Projects card shows PROJECT_COUNT
8. assert: Templates card shows TEMPLATE_COUNT
9. assert: Schedules card shows SCHEDULE_COUNT

## Test Cases — Life Dashboard

### DASH-04: Life dashboard summary cards

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - "Actions Today" card with count
   - "Active Task Trees" card with count (v2: replaces "Active Pipelines")
   - "Pending Approvals" card with count
   - "System Health" card

### DASH-05: Life dashboard data comes from API

**Steps:**
1. curl: `GET http://localhost:4001/api/dashboard/life`
2. assert response:
   - status 200
   - JSON has `actionsToday` (number)
   - JSON has `activeTrees` or `activePipelines` (number)
   - JSON has `pendingApprovals` (number)
   - JSON has `systemHealth` (string)

## Test Cases — Live Activity

### DASH-06: Live activity feed displays events

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - "Live Activity" section exists
   - events displayed with description, source badge, timestamp (or empty state message)

### DASH-07: Live activity updates via WebSocket

**Steps:**
1. navigate: `http://localhost:4000`
2. trigger an event (e.g., send a chat message in another tab)
3. wait: 3s
4. assert: new event appears in Live Activity feed without page refresh

## Test Cases — Polling

### DASH-08: Health polling every 10 seconds

**Steps:**
1. navigate: `http://localhost:4000`
2. open browser Network tab, filter by `/api/health`
3. wait: 25s
4. assert: at least 2 health requests visible (initial + polling)

### DASH-09: Card navigation to detail pages

**Steps:**
1. navigate: `http://localhost:4000`
2. click: "Projects" status card
3. assert: navigated to `/projects`
4. navigate back to `/`
5. click: "Skills" status card
6. assert: navigated to `/skills`
7. navigate back to `/`
8. click: "Templates" status card
9. assert: navigated to `/templates`
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/03-dashboard.md
git commit -m "test: add v2 dashboard tests (03)"
```

---

### Task 5: Write 04-capability-library.md

**Files:**
- Create: `manual-tests/04-capability-library.md`

This tests the **Phase 1** capability library — the hierarchical skill system replacing suites.

- [ ] **Step 1: Write the test file**

```markdown
# 04 - Capability Library (Phase 1)

Validates the hierarchical skill library, MCP definitions, progressive disclosure, and skill browser UI.

Prerequisites: Both servers running, `library/` directory populated with skills and MCPs

## Test Cases — Skills API

### LIB-01: List all skills

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. assert response:
   - status 200
   - JSON array returned
   - each entry has: `name`, `description`, `version`
   - at least 1 skill present

### LIB-02: Skill entries include capability metadata

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. pick any skill from the list
3. assert it has:
   - `capabilities` array (e.g., `["mcp-server", "agent-definition"]`)
   - `mcpServers` object (may be empty)
   - `agentDefinitions` object (may be empty)

### LIB-03: Skill count matches dashboard

**Steps:**
1. curl: `GET http://localhost:4001/api/skills` → note length as API_COUNT
2. navigate: `http://localhost:4000`
3. assert: "Skills" status card shows API_COUNT

## Test Cases — MCP Definitions

### LIB-04: MCPs are independently defined

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. find a skill that references MCPs
3. assert: MCP config includes `command`, `args` fields
4. assert: MCP configs are namespaced (prefixed with skill/mcp name)

**Notes:** MCPs are a shared library resource. Multiple skills can reference the same MCP by name. MCP definitions live in `library/mcps/*.json` on disk.

## Test Cases — Skills Browser UI

### LIB-05: Skills page loads with card display

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - heading "Skills"
   - at least 1 skill card
   - each card shows: name, description, version

### LIB-06: Skill cards show capability badges

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - skill cards display capability badges (e.g., "mcp-server", "event-source")
   - badges are visually distinct (colored tags or pills)

### LIB-07: Skill detail shows MCP and agent info

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. click: any skill card with MCP capability
3. assert: expanded view shows:
   - MCP server names referenced
   - agent definition names
   - skill description in full

### LIB-08: Hierarchical skill library browser

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. assert: skills are organized by domain categories:
   - domains like "file-management", "communication", "productivity", "finance", "system"
   - each domain is collapsible or acts as a section header
3. click: expand a domain category
4. assert: child skills within that domain are displayed

**Notes:** This tests the progressive disclosure Tier 0 (discovery) view. The browser shows skill names + descriptions organized by domain hierarchy matching `library/skills/` structure.

### LIB-09: Skill count consistent across pages

**Steps:**
1. navigate: `http://localhost:4000/skills` → count visible skill cards as UI_COUNT
2. navigate: `http://localhost:4000` → read "Skills" status card as DASH_COUNT
3. curl: `GET http://localhost:4001/api/skills` → note length as API_COUNT
4. assert: UI_COUNT = DASH_COUNT = API_COUNT
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/04-capability-library.md
git commit -m "test: add v2 capability library tests (04)"
```

---

### Task 6: Write 05-project-hierarchy.md

**Files:**
- Create: `manual-tests/05-project-hierarchy.md`

This tests **Phase 2** — filesystem-based project hierarchy with inheritance.

- [ ] **Step 1: Write the test file**

```markdown
# 05 - Project Hierarchy (Phase 2)

Validates filesystem-based project structure, tree view, context inheritance, and agent scoping.

Prerequisites: Both servers running, `projects/` directory has at least one project with a sub-project

## Test Cases — Project API

### PROJ-01: List all projects

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert response:
   - status 200
   - JSON array returned
   - each project has: `id`, `name`, `description`
   - at least the global (`_global`) project exists

### PROJ-02: Project detail includes filesystem metadata

**Steps:**
1. curl: `GET http://localhost:4001/api/projects` → pick a project `id`
2. curl: `GET http://localhost:4001/api/projects/{id}`
3. assert response:
   - status 200
   - has `name`, `description`
   - has `skills` array
   - has `systemAccess` field (`none`, `read`, or `read-write`)

### PROJ-03: Create a new project

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects \
     -H "Content-Type: application/json" \
     -d '{"name": "test-project-v2", "description": "Test project for v2 manual testing", "skills": []}'
   ```
2. assert response:
   - status 200 or 201
   - `name` = "test-project-v2"
   - `id` is a UUID

### PROJ-04: Project hierarchy reflects filesystem

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert: projects with sub-projects show parent-child relationship
3. assert: project paths correspond to `projects/` directory structure on disk

**Notes:** The project registry scans `projects/` on boot. Each directory with a `context.md` becomes a project. Nested directories become sub-projects.

### PROJ-05: Meta-project exists and is protected

**Steps:**
1. curl: `GET http://localhost:4001/api/projects`
2. assert: one project has `isMeta` = true, name "Raven System" (or similar)
3. curl: `DELETE http://localhost:4001/api/projects/{metaProjectId}`
4. assert: status 400 or 403 (cannot delete meta-project)

### PROJ-06: System access levels enforced

**Steps:**
1. find a project with `systemAccess` = "none"
2. send a chat message requesting system file access in that project's context
3. assert: agent does not access system files
4. update project to `systemAccess` = "read"
5. send same request
6. assert: agent can read but not modify system files

## Test Cases — Project Tree UI

### PROJ-07: Projects page shows project list

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. snapshot → assert:
   - heading "Projects"
   - project cards or tree nodes displayed
   - each shows name, description

### PROJ-08: Project tree view shows hierarchy

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. assert: projects displayed in tree structure (parent → child indentation)
3. assert: top-level projects shown at root level
4. assert: sub-projects shown indented under their parent

### PROJ-09: Project detail page with tabs

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: any project card
3. wait: 1s
4. snapshot → assert:
   - project name displayed as heading
   - tab bar with tabs: "Overview", "Tasks", "Agents", "Templates", "Knowledge", "Sessions"
   - "Overview" tab is active by default

### PROJ-10: Project Agents tab shows scoped agents

**Steps:**
1. navigate to a project detail page
2. click: "Agents" tab
3. assert: agents scoped to this project are listed
4. assert: global agents are also visible (inherited)
5. assert: each agent shows: name, description, model, skills list

### PROJ-11: Project Templates tab shows scoped templates

**Steps:**
1. navigate to a project detail page
2. click: "Templates" tab
3. assert: templates scoped to this project are listed
4. assert: global templates are also visible (inherited)

### PROJ-12: Project count consistent across views

**Steps:**
1. curl: `GET http://localhost:4001/api/projects` → note length as API_COUNT
2. navigate: `http://localhost:4000/projects` → count displayed projects as UI_COUNT
3. navigate: `http://localhost:4000` → read "Projects" card as DASH_COUNT
4. assert: API_COUNT = UI_COUNT = DASH_COUNT

### PROJ-13: Invalid project ID returns 404

**Steps:**
1. curl: `GET http://localhost:4001/api/projects/nonexistent-uuid-12345`
2. assert: status 404
3. navigate: `http://localhost:4000/projects/nonexistent-uuid-12345`
4. assert: error message or redirect (no crash)
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/05-project-hierarchy.md
git commit -m "test: add v2 project hierarchy tests (05)"
```

---

### Task 7: Write 06-agent-management.md

**Files:**
- Create: `manual-tests/06-agent-management.md`

This tests **YAML-based agent management** with skills binding (not suites) and bash config.

- [ ] **Step 1: Write the test file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/06-agent-management.md
git commit -m "test: add v2 agent management tests (06)"
```

---

### Task 8: Write 07-task-execution-engine.md

**Files:**
- Create: `manual-tests/07-task-execution-engine.md`

This tests **Phase 3** — the task-board execution engine, dependency resolution, and three-gate validation.

- [ ] **Step 1: Write the test file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/07-task-execution-engine.md
git commit -m "test: add v2 task execution engine tests (07)"
```

---

### Task 9: Write 08-task-templates.md

**Files:**
- Create: `manual-tests/08-task-templates.md`

This tests **Phase 4** — unified task templates replacing pipelines.

- [ ] **Step 1: Write the test file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/08-task-templates.md
git commit -m "test: add v2 task templates tests (08)"
```

---

### Task 10: Write 09-permissions-bash-access.md

**Files:**
- Create: `manual-tests/09-permissions-bash-access.md`

This tests **Phase 5** — graduated bash access and permission enforcement.

- [ ] **Step 1: Write the test file**

```markdown
# 09 - Permissions & Bash Access (Phase 5)

Validates graduated bash access (none/sandboxed/scoped/full), command validation, path restrictions, mandatory deny rules, and audit logging.

Prerequisites: Both servers running, at least one agent with bash config

## Test Cases — Bash Access Levels

### PERM-01: Agent with `access: none` cannot run bash

**Steps:**
1. find or create an agent with `bash.access: none`
2. send a chat message requesting a bash command (e.g., "run `ls /tmp`")
3. assert: agent does NOT execute bash command
4. assert: agent responds with inability to run commands (or uses alternative tools)

### PERM-02: Agent with `access: sandboxed` runs whitelisted commands only

**Steps:**
1. find or create agent with:
   ```yaml
   bash:
     access: sandboxed
     allowedCommands: ["ls", "cat"]
     deniedCommands: ["rm *"]
   ```
2. request: "run `ls /tmp`"
3. assert: command executes successfully
4. request: "run `rm /tmp/testfile`"
5. assert: command is BLOCKED with reason mentioning "rm" is not allowed

### PERM-03: Agent with `access: scoped` respects path boundaries

**Steps:**
1. find or create agent with:
   ```yaml
   bash:
     access: scoped
     allowedPaths: ["data/artifacts/**", "/tmp/raven-*"]
     deniedPaths: [".env", ".git/**", "projects/**"]
   ```
2. request: "run `cat data/artifacts/test.txt`"
3. assert: command allowed (within allowedPaths)
4. request: "run `cat .env`"
5. assert: command BLOCKED (in deniedPaths)
6. request: "run `cat projects/context.md`"
7. assert: command BLOCKED (in deniedPaths)

### PERM-04: Agent with `access: full` can run any command

**Steps:**
1. this level should only be available for system admin / meta-project agents
2. verify that `access: full` agents can run arbitrary commands
3. assert: requires red-tier approval for the session

## Test Cases — Mandatory Deny Rules

### PERM-05: .env always denied regardless of access level

**Steps:**
1. for each access level (sandboxed, scoped, full):
2. attempt: `cat .env`
3. assert: BLOCKED in all cases
4. assert: error reason mentions mandatory deny

### PERM-06: .git/ always denied

**Steps:**
1. for each access level:
2. attempt: `cat .git/config`
3. assert: BLOCKED
4. attempt: `ls .git/refs/`
5. assert: BLOCKED

### PERM-07: Catastrophic rm patterns always denied

**Steps:**
1. attempt: `rm -rf /`
2. assert: BLOCKED regardless of access level
3. attempt: `rm -rf ~`
4. assert: BLOCKED

## Test Cases — Pipe Chain Validation

### PERM-08: All commands in pipe chain are validated

**Steps:**
1. agent with `sandboxed` access, allowed: ["ls", "grep"]
2. request: `ls /tmp | grep test`
3. assert: allowed (both commands whitelisted)
4. request: `ls /tmp | rm -f test`
5. assert: BLOCKED (rm not whitelisted)

## Test Cases — Audit Logging

### PERM-09: Bash commands logged to audit trail

**Steps:**
1. execute several bash commands (allowed and denied)
2. curl: `GET http://localhost:4001/api/audit-logs?limit=10`
3. assert: recent entries include bash command attempts
4. assert: each entry has `outcome` (executed, denied), `details` (command), `timestamp`

### PERM-10: Audit log filterable by outcome

**Steps:**
1. curl: `GET http://localhost:4001/api/audit-logs?outcome=denied`
2. assert: only denied entries returned
3. curl: `GET http://localhost:4001/api/audit-logs?outcome=executed`
4. assert: only executed entries returned

## Test Cases — Permission Tiers

### PERM-11: Green tier actions execute silently

**Steps:**
1. trigger a green-tier action (e.g., read operation)
2. assert: executes without notification or approval prompt
3. assert: logged in audit trail

### PERM-12: Yellow tier actions execute with notification

**Steps:**
1. trigger a yellow-tier action (e.g., write operation)
2. assert: executes but generates a notification/report
3. assert: logged in audit trail

### PERM-13: Red tier actions require approval

**Steps:**
1. trigger a red-tier action (e.g., destructive operation or elevated bash)
2. assert: action is queued for approval
3. assert: notification sent (Telegram or dashboard)
4. approve via API
5. assert: action then executes
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/09-permissions-bash-access.md
git commit -m "test: add v2 permissions & bash access tests (09)"
```

---

### Task 11: Write 10-agent-builder.md

**Files:**
- Create: `manual-tests/10-agent-builder.md`

This tests **Phase 6** — the agent builder that scaffolds project domains.

- [ ] **Step 1: Write the test file**

```markdown
# 10 - Agent Builder (Phase 6)

Validates the agent builder that scaffolds entire project domains from natural language descriptions.

Prerequisites: Both servers running, capability library loaded

## Test Cases — Agent Builder Conversation

### BLD-01: Agent builder understands domain request

**Steps:**
1. create a new project or use an existing one
2. send chat message: "Set up a project for tracking my university coursework"
3. assert: agent responds with clarifying questions about:
   - what tools/integrations to use
   - recurring patterns (weekly reviews, exam prep)
   - agents needed
   - autonomy level

### BLD-02: Agent builder produces a design plan

**Steps:**
1. answer the clarifying questions from BLD-01
2. assert: agent produces a structured plan showing:
   - proposed project hierarchy (directories)
   - agent definitions (names, skills, descriptions)
   - template definitions (names, triggers, task sequences)
   - schedule definitions (cron expressions)

### BLD-03: Agent builder awaits approval before scaffolding

**Steps:**
1. after plan is presented
2. assert: agent asks for confirmation before writing files
3. respond: "looks good, proceed"
4. assert: agent begins scaffolding

### BLD-04: Scaffolding creates filesystem structure

**Steps:**
1. after approval
2. verify on disk:
   - `projects/{project-name}/context.md` exists
   - `projects/{project-name}/agents/*.yaml` files created
   - `projects/{project-name}/templates/*.yaml` files created (if applicable)
   - `projects/{project-name}/schedules/*.yaml` files created (if applicable)

### BLD-05: Scaffolded agents reference valid library skills

**Steps:**
1. read the created agent YAML files
2. assert: every skill in the `skills` array exists in the capability library
3. assert: YAML is valid (name is kebab-case, has required fields)

### BLD-06: Scaffolded templates have valid task structures

**Steps:**
1. read the created template YAML files
2. assert: `tasks` array is non-empty
3. assert: `blockedBy` references point to existing task IDs within same template
4. assert: `agent` references point to agents accessible at this scope

### BLD-07: Builder verifies its own output

**Steps:**
1. after scaffolding completes
2. assert: agent runs library validation on created files
3. assert: agent confirms all references resolve correctly

## Test Cases — Scaffolding Limits

### BLD-08: Builder refuses to reference non-existent skills

**Steps:**
1. request: "create an agent that uses the 'quantum-computing' skill"
2. assert: builder either asks for clarification or explains that skill doesn't exist
3. assert: builder suggests available skills instead

### BLD-09: Builder nesting limit (max 3 levels)

**Steps:**
1. request a deeply nested project structure (global → project → sub → sub-sub)
2. assert: builder limits to 3 levels (global → project → sub-project)
3. assert: builder explains the nesting constraint
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/10-agent-builder.md
git commit -m "test: add v2 agent builder tests (10)"
```

---

### Task 12: Write 11-chat-sessions.md

**Files:**
- Create: `manual-tests/11-chat-sessions.md`

This tests chat, sessions, and the task-board protocol.

- [ ] **Step 1: Write the test file**

```markdown
# 11 - Chat & Sessions (v2)

Validates chat functionality, session lifecycle, task-board protocol awareness, and orchestrator triage modes.

Prerequisites: Both servers running, at least one project exists

## Test Cases — Chat Basics

### CHAT-01: Send a chat message

**Steps:**
1. navigate to a project page: `http://localhost:4000/projects/{id}`
2. type in chat input: "Hello, what can you help me with?"
3. click: send button (or press Enter)
4. assert: user message bubble appears
5. wait: up to 30s
6. assert: assistant response appears

### CHAT-02: Chat creates a session

**Steps:**
1. send a message in a new project (or after clicking "New Chat")
2. assert: session selector shows current session
3. assert: session has an ID (displayed in selector, truncated)
4. assert: turn count increments after exchange

### CHAT-03: New Chat button creates fresh session

**Steps:**
1. send a few messages to establish a session
2. click: "New Chat" button
3. assert: chat clears
4. assert: session selector shows new session (different ID)
5. send a message
6. assert: new session has turn count = 1

### CHAT-04: Session switching loads correct messages

**Steps:**
1. have at least 2 sessions
2. click: session selector dropdown
3. select: a previous session
4. assert: messages from that session load
5. switch back to the other session
6. assert: correct messages displayed

## Test Cases — Session Management

### CHAT-05: Session auto-naming from first message

**Steps:**
1. start a new session
2. send: "Help me prepare for my calculus exam tomorrow"
3. assert: session name auto-generated from first message content (not the raw ID)

### CHAT-06: Edit session name

**Steps:**
1. click: session name in selector
2. type: new name "Exam Prep Session"
3. press Enter or click save
4. assert: session name updated
5. refresh page
6. assert: new name persists

### CHAT-07: Pin/unpin session

**Steps:**
1. find the pin button on a session
2. click: pin
3. assert: session marked as pinned
4. refresh page
5. assert: pinned session appears at top of session list
6. click: unpin
7. assert: session no longer pinned

### CHAT-08: Session debug panel

**Steps:**
1. open session debug panel (click debug/inspector button)
2. assert: shows sections:
   - Session metadata (ID, status, turn count)
   - Messages list
   - Tasks associated with session
   - Audit entries
3. click: "Copy All" button
4. assert: debug data copied to clipboard

## Test Cases — Orchestrator Triage (v2)

### CHAT-09: DIRECT mode — simple query

**Steps:**
1. send: "What time is it?"
2. assert: response arrives quickly (single agent call, no task tree created)
3. curl: `GET http://localhost:4001/api/task-trees`
4. assert: no new task tree created for this request (DIRECT mode skips the engine)

### CHAT-10: DELEGATED mode — substantial single-agent work

**Steps:**
1. send: "Summarize my emails from today" (requires one agent with email skills)
2. assert: a task is created for this work
3. assert: task goes through validation after completion

### CHAT-11: PLANNED mode — multi-agent complex work

**Steps:**
1. send: "Create a study plan for my upcoming exams, check my calendar for exam dates, and draft a revision schedule"
2. assert: orchestrator creates a task tree with multiple tasks
3. assert: task tree status = `pending_approval` (plan displayed for review)
4. assert: plan shows task breakdown with agent assignments and dependencies
5. approve the plan
6. assert: execution begins

### CHAT-12: Task-board protocol — agent creates/claims tasks

**Steps:**
1. trigger a DELEGATED or PLANNED request
2. observe the task tree
3. assert: agent sets task status to `in_progress` when starting
4. assert: agent attaches artifacts as it works
5. assert: agent completes task with summary
6. assert: only task ID + summary returned to orchestrator (not full content)

## Test Cases — Session Retrospective

### CHAT-13: Idle session triggers retrospective

**Steps:**
1. have a session with several turns
2. wait for idle timeout (configurable, default 30 min — use API trigger for testing)
3. curl: `POST http://localhost:4001/api/sessions/{id}/retrospective` (manual trigger)
4. assert: retrospective produces:
   - summary
   - decisions list
   - action items
   - candidate knowledge bubbles

### CHAT-14: Session compaction on long conversations

**Steps:**
1. have a session with many messages (exceeds threshold)
2. assert: older messages are compacted (summarized)
3. assert: session continues working with compacted context
4. assert: compaction block stored with summary

### CHAT-15: Session search

**Steps:**
1. have multiple sessions with different names
2. use session search to find by name
3. assert: matching sessions returned
4. search by description
5. assert: matching sessions returned
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/11-chat-sessions.md
git commit -m "test: add v2 chat & sessions tests (11)"
```

---

### Task 13: Write 12-dashboard-v2-features.md

**Files:**
- Create: `manual-tests/12-dashboard-v2-features.md`

Tests the v2 dashboard feature pages: task tree visualization, agent monitor, and metrics.

- [ ] **Step 1: Write the test file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/12-dashboard-v2-features.md
git commit -m "test: add v2 dashboard feature page tests (12)"
```

---

### Task 14: Write 13-cross-cutting-verification.md

**Files:**
- Create: `manual-tests/13-cross-cutting-verification.md`

- [ ] **Step 1: Write the test file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/13-cross-cutting-verification.md
git commit -m "test: add v2 cross-cutting verification tests (13)"
```

---

### Task 15: Write 14-schedules-notifications.md

**Files:**
- Create: `manual-tests/14-schedules-notifications.md`

- [ ] **Step 1: Write the test file**

```markdown
# 14 - Schedules & Notifications (v2)

Validates template scheduling (cron triggers), notification delivery, urgency classification, and engagement tracking.

Prerequisites: Both servers running, at least one schedule defined

## Test Cases — Schedule API

### SCHED-01: List schedules

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules`
2. assert response:
   - status 200
   - JSON array returned
   - each schedule has: cron expression, template reference, enabled flag

### SCHED-02: Schedule references valid template

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules`
2. for each schedule, note its `template` field
3. curl: `GET http://localhost:4001/api/templates/{templateName}`
4. assert: template exists (status 200)

### SCHED-03: Schedules page displays correctly

**Steps:**
1. navigate: `http://localhost:4000/schedules`
2. snapshot → assert:
   - heading "Schedules"
   - schedule cards with: name, cron expression, template name
   - enabled/disabled toggle or badge
   - next run time displayed

### SCHED-04: Schedule count matches dashboard

**Steps:**
1. curl: `GET http://localhost:4001/api/schedules` → note length
2. navigate: `http://localhost:4000` → read "Schedules" card
3. assert: counts match

## Test Cases — Notification Delivery

### SCHED-05: Event timeline shows notifications

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. assert: events displayed chronologically (newest first)
3. assert: notification events show source badge and description
4. assert: filter dropdowns for source and type work

### SCHED-06: Activity page polling

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. open Network tab
3. wait: 15s
4. assert: at least 2 event poll requests visible

### SCHED-07: Notification preferences — snooze a category

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/notifications/snooze \
     -H "Content-Type: application/json" \
     -d '{"category": "digest", "duration": "1h"}'
   ```
2. assert: status 200
3. curl: `GET http://localhost:4001/api/notifications/snooze`
4. assert: "digest" category appears in active snoozes

### SCHED-08: Snoozed notifications are held

**Steps:**
1. snooze "digest" category (from SCHED-07)
2. trigger a digest notification
3. assert: notification NOT delivered immediately
4. assert: notification held until snooze expires

### SCHED-09: Approvals and system health never snoozable

**Steps:**
1. attempt to snooze "approval" category
2. assert: error — approvals are not snoozable
3. attempt to snooze "system-health" category
4. assert: error — system health alerts are not snoozable

## Test Cases — Settings Page

### SCHED-10: Settings page displays system info

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. snapshot → assert:
   - heading "Settings"
   - System info card (API URL, uptime, version)
   - Configuration section
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/14-schedules-notifications.md
git commit -m "test: add v2 schedules & notifications tests (14)"
```

---

### Task 16: Write 15-knowledge-system.md

**Files:**
- Create: `manual-tests/15-knowledge-system.md`

- [ ] **Step 1: Write the test file**

```markdown
# 15 - Knowledge System (v2)

Validates knowledge graph, context injection, lifecycle management, and retrospective features.

Prerequisites: Both servers running, some knowledge bubbles exist

## Test Cases — Knowledge CRUD

### KN-01: Create a knowledge bubble

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge \
     -H "Content-Type: application/json" \
     -d '{"title": "Test Knowledge", "content": "This is test knowledge for v2", "tags": ["test", "v2"], "domain": "system"}'
   ```
2. assert: status 200 or 201
3. assert: response has `id`, `title`, `content`, `tags`

### KN-02: List knowledge bubbles

**Steps:**
1. curl: `GET http://localhost:4001/api/knowledge`
2. assert: status 200
3. assert: JSON array with knowledge entries

### KN-03: Search knowledge

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge/search \
     -H "Content-Type: application/json" \
     -d '{"query": "test knowledge v2"}'
   ```
2. assert: status 200
3. assert: results include the bubble from KN-01

## Test Cases — Knowledge Context Injection

### KN-04: Chat response includes knowledge context

**Steps:**
1. create knowledge about a topic (e.g., "My calculus exam is on April 5th")
2. start a new chat session
3. send: "When is my calculus exam?"
4. assert: agent response references the knowledge (mentions April 5th)

### KN-05: Knowledge references tracked per session

**Steps:**
1. after a chat that used knowledge context
2. check session debug panel or API
3. assert: references list shows which bubbles were injected
4. assert: each reference has a relevance score

## Test Cases — Knowledge Graph UI

### KN-06: Knowledge graph page loads

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - graph visualization canvas (or list view)
   - view mode buttons (Links, Tags, Timeline, Clusters, Domains)
   - search input
   - filter panel

### KN-07: Graph view modes switch correctly

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. click: each view mode button (Links, Tags, Timeline, Clusters, Domains)
3. assert: graph re-renders for each mode
4. assert: no errors or blank screen on mode switch

### KN-08: Knowledge search from graph page

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. type: search query in search input
3. click: search button (or press Enter)
4. assert: graph highlights or filters to matching nodes
5. clear search
6. assert: graph reverts to full view

### KN-09: Node detail panel

**Steps:**
1. click: a knowledge node in the graph
2. assert: detail panel opens showing:
   - title, content
   - tags
   - domain
   - permanence level
   - linked nodes
3. click: close button
4. assert: panel closes

### KN-10: Filter by tags and domain

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. add a tag filter (e.g., "test")
3. assert: only nodes with that tag shown
4. add a domain filter (e.g., "system")
5. assert: only matching nodes shown
6. click: "Clear all filters"
7. assert: all nodes visible again

## Test Cases — Knowledge Lifecycle

### KN-11: Stale bubble detection

**Steps:**
1. curl: `GET http://localhost:4001/api/knowledge/stale`
2. assert: status 200
3. assert: returns array of stale bubbles (not accessed recently, based on permanence rules)

### KN-12: Merge knowledge bubbles

**Steps:**
1. create 2 similar bubbles
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge/merge \
     -H "Content-Type: application/json" \
     -d '{"bubbleIds": ["{id1}", "{id2}"], "mergedTitle": "Merged Knowledge"}'
   ```
3. assert: status 200
4. assert: merged bubble created, originals removed or linked

### KN-13: Knowledge retrospective

**Steps:**
1. curl: `POST http://localhost:4001/api/knowledge/retrospective/trigger`
2. assert: status 200
3. curl: `GET http://localhost:4001/api/knowledge/retrospective`
4. assert: retrospective summary returned

## Test Cases — Project Knowledge

### KN-14: Link bubble to project

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/knowledge/link \
     -H "Content-Type: application/json" \
     -d '{"bubbleId": "{bubbleId}"}'
   ```
2. assert: status 200
3. curl: `GET http://localhost:4001/api/projects/{projectId}/knowledge`
4. assert: linked bubble appears in project knowledge

### KN-15: Knowledge tab in project detail

**Steps:**
1. navigate to a project detail page
2. click: "Knowledge" tab
3. assert: linked knowledge bubbles displayed
4. assert: data sources section visible
5. assert: option to add/remove knowledge links
```

- [ ] **Step 2: Commit**

```bash
git add manual-tests/15-knowledge-system.md
git commit -m "test: add v2 knowledge system tests (15)"
```

---

### Task 17: Final review and commit

- [ ] **Step 1: Verify all 15 test files exist**

```bash
ls -la manual-tests/
```

Expected: 15 files (01 through 15), no v1 files remaining.

- [ ] **Step 2: Verify test file numbering and naming**

```bash
ls manual-tests/ | sort
```

Expected output:
```
01-smoke-test.md
02-navigation-layout.md
03-dashboard.md
04-capability-library.md
05-project-hierarchy.md
06-agent-management.md
07-task-execution-engine.md
08-task-templates.md
09-permissions-bash-access.md
10-agent-builder.md
11-chat-sessions.md
12-dashboard-v2-features.md
13-cross-cutting-verification.md
14-schedules-notifications.md
15-knowledge-system.md
```

- [ ] **Step 3: Count total test cases across all files**

```bash
grep -c "^### " manual-tests/*.md | tail -1
```

Expected: ~150+ individual test cases across all files.

- [ ] **Step 4: Verify v2 terminology — no v1 terms**

```bash
grep -i "suiteIds\|pipeline_runs\|config/agents.json\|config/suites.json" manual-tests/*.md
```

Expected: no matches (all v1 terms replaced with v2 equivalents).

- [ ] **Step 5: Final commit**

```bash
git add manual-tests/
git commit -m "test: complete v2 manual test rewrite (15 files, all phases covered)"
```

---

## Coverage Matrix

| V2 Spec Section | Test File(s) | Key Test IDs |
|-----------------|-------------|-------------|
| §2 Task Execution Engine | 07, 12 | TEE-01→20, DFP-07→09 |
| §2.5 Three-Gate Validation | 07 | TEE-11→14 |
| §2.8 Task-Board Protocol | 11 | CHAT-09→12 |
| §3 Capability Library | 04 | LIB-01→09 |
| §3.2 Progressive Disclosure | 04 | LIB-08 |
| §4 Project Hierarchy | 05 | PROJ-01→13 |
| §4.2 Inheritance | 05 | PROJ-10→11 |
| §5 Agent Builder | 10 | BLD-01→09 |
| §5.2 Unified Templates | 08 | TPL-01→18 |
| §5.3 Task Types (all 7) | 08 | TPL-07→12 |
| §5.4 Template Interpolation | 08 | TPL-13→15 |
| §5.5 Dynamic Fan-Out | 08 | TPL-15 |
| §6 Permissions | 09 | PERM-01→13 |
| §6.1 Graduated Bash | 09 | PERM-01→04 |
| §6.6 Mandatory Denies | 09 | PERM-05→07 |
| §7 Validation | 07, 08 | TEE-10, TPL-03 |
| §8 DB vs Filesystem | 05 | PROJ-04 |
| Agent YAML Management | 06 | AGT-01→13 |
| Dashboard (v2) | 03, 12 | DASH-01→09, DFP-01→13 |
| Chat & Sessions | 11 | CHAT-01→15 |
| Knowledge System | 15 | KN-01→15 |
| Notifications | 14 | SCHED-05→09 |
| Cross-Cutting | 13 | XC-01→13 |
| Smoke/Nav | 01, 02 | SM-01→10, NAV-01→07 |

## V1 Tests Not Carried Forward

These v1 test files tested features that are fully replaced or subsumed by v2:

| V1 File | Reason Not Carried Forward |
|---------|--------------------------|
| 10-pipelines-api.md | Replaced by task templates (08) |
| 11-email-auto-triage.md | Skill-specific; covered by capability library (04) + chat (11) |
| 12-email-action-extraction.md | Skill-specific; covered by capability library + templates |
| 14-stale-task-detection.md | Subsumed by task execution engine (07) |
| 15-pipeline-monitor.md | Replaced by task tree visualization (12) |
| 22-pattern-analysis-engine.md | Proactive intelligence unchanged; tested via templates (08) |
| 29-system-maintenance.md | Maintenance pipeline → maintenance template; tested via templates (08) |
| 30-conversational-config.md | Config management approach unchanged; tested via chat (11) |
| 31-config-history.md | Git-based history unchanged; covered by cross-cutting (13) |

**Note:** Email triage, action extraction, stale task detection, pattern analysis, and system maintenance are now **template-driven workflows** (not custom pipeline code). Their correctness is validated by testing the template system (08) and task execution engine (07) generically, rather than per-workflow manual tests.
