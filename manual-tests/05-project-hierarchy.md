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
