# Dashboard Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the Next.js dashboard to surface the new v2 architecture — project hierarchy with sub-projects, task tree visualization, template management, skill library browser, and agent YAML editor.

**Architecture:** Extend existing pages and components. Add new pages for templates and task trees. Update API client with new endpoints. Follow existing patterns (Zustand stores, usePolling, grid layouts, tab registry).

**Tech Stack:** Next.js 15, React 19, Zustand, Tailwind CSS 4, existing api-client.ts patterns

---

### Task 1: Update API Client with New Endpoints

**Files:**
- Modify: `packages/web/src/lib/api-client.ts`

- [ ] **Step 1: Add new API functions**

Add functions for all Phase 1-6 endpoints:

```typescript
// Templates
export async function fetchTemplates(): Promise<TemplateRecord[]>
export async function fetchTemplate(name: string): Promise<TemplateRecord>
export async function triggerTemplate(name: string, params?: Record<string, unknown>): Promise<{ treeId: string }>

// Task Trees
export async function fetchTaskTrees(): Promise<TaskTreeRecord[]>
export async function fetchTaskTree(id: string): Promise<TaskTreeDetailRecord>
export async function approveTaskTree(id: string): Promise<void>
export async function cancelTaskTree(id: string): Promise<void>
export async function approveTaskTreeTask(treeId: string, taskId: string): Promise<void>

// Scaffolding
export async function scaffoldDomain(plan: ScaffoldPlan): Promise<ScaffoldResult>
export async function scaffoldProject(input: ScaffoldProjectInput): Promise<void>

// Project children
export async function fetchProjectChildren(id: string): Promise<ProjectChildRecord[]>
```

Define corresponding TypeScript interfaces for API responses.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(web): add API client functions for templates, task trees, and scaffolding"
```

---

### Task 2: Project Hierarchy View

**Files:**
- Modify: `packages/web/src/app/projects/page.tsx`
- Create: `packages/web/src/components/project/ProjectTree.tsx`

- [ ] **Step 1: Add tree/flat view toggle**

Add a toggle button to the projects page: "Tree" | "Flat" (default: flat for backward compat).

- [ ] **Step 2: Create ProjectTree component**

A tree view that shows projects with indented sub-projects:

```
UNI Spring 2026
  ├─ Calculus
  ├─ Physics
  └─ English Lit
Freelance
  ├─ Client A
  └─ Client B
Personal
  ├─ Finance
  └─ Health
```

Each node is clickable → navigates to `/projects/{id}`.
Shows agent count and template count badges.

Uses the enriched project API response (parentId, children) from Phase 2.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(web): add project hierarchy tree view with sub-project navigation"
```

---

### Task 3: Templates Page

**Files:**
- Create: `packages/web/src/app/templates/page.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.tsx` (add Templates nav item)

- [ ] **Step 1: Create templates page**

Grid of template cards showing:
- Template name and displayName
- Description
- Task count
- Trigger types (badges: manual, schedule, event)
- "Trigger" button for manual templates

Click to expand → shows full task list with dependencies visualized as a simple list with indent/arrows.

- [ ] **Step 2: Add trigger functionality**

"Trigger" button opens a simple form for params (if template has params), then calls `triggerTemplate()`. Shows the returned treeId with link to task tree view.

- [ ] **Step 3: Add to sidebar**

Add Templates nav item to Sidebar.tsx between Pipelines and Tasks.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): add templates page with trigger functionality"
```

---

### Task 4: Task Trees Page

**Files:**
- Create: `packages/web/src/app/task-trees/page.tsx`
- Create: `packages/web/src/components/task-trees/TaskTreeView.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create task trees page**

List of active task trees with:
- Tree ID (truncated), status badge, plan description
- Task count, completion progress (completed/total)
- Created timestamp
- "Approve" button for pending_approval trees
- "Cancel" button

- [ ] **Step 2: Create TaskTreeView component**

Click a tree → shows the full task tree visualization:
- Each task as a card/row showing: id, title, type badge, status badge, agent name
- Dependencies shown as arrows or indentation
- Artifacts listed for completed tasks
- Validation result shown for validated tasks
- Retry count shown if > 0

Simple layout — not a full graph visualization, just an ordered list with dependency indicators:

```
[✓] check-schedule (agent: schedule-agent) — completed
  └─ [▶] gather-notes (agent: knowledge-agent) — in_progress
       └─ [○] generate-guide (agent: study-agent) — todo
            └─ [○] send-summary (notify: telegram) — todo
```

- [ ] **Step 3: Add to sidebar**

Add "Task Trees" nav item after Tasks.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): add task trees page with tree visualization and approval controls"
```

---

### Task 5: Skill Library Browser

**Files:**
- Modify: `packages/web/src/app/skills/page.tsx`

- [ ] **Step 1: Enhance skills page**

The current skills page shows suite-based skills. Update to also show library skills organized by domain:

```
File Management
  ├─ Documents: pdf, docx, xlsx, pptx
  └─ Media: ffmpeg, transcription

Communication
  ├─ Email: gmail
  └─ Messaging: telegram

Productivity
  ├─ Task Management: ticktick
  ├─ Scheduling: calendar
  └─ Briefing: daily-digest
```

Each skill shows: name, description, MCPs required, model tier, tools.

Fetch from existing `/api/skills` endpoint (which now returns library data alongside suite data).

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(web): enhance skills page with hierarchical library browser"
```

---

### Task 6: Update Agent Form for Skills + Bash

**Files:**
- Modify: `packages/web/src/components/agents/AgentFormModal.tsx`
- Modify: `packages/web/src/stores/agent-store.ts`

- [ ] **Step 1: Add skills multi-select**

Replace or supplement the suite selector with a skills multi-select. Fetch available skills from the API.

- [ ] **Step 2: Add bash access config**

Add a dropdown for bash access level (none/sandboxed/scoped/full). When sandboxed or scoped selected, show text fields for allowedCommands, allowedPaths, deniedPaths.

- [ ] **Step 3: Add project scope selector**

Add a dropdown for project scope when creating agents — determines which project directory the YAML is written to.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): update agent form with skills selection, bash config, and project scope"
```

---

### Task 7: Update Project Detail with New Tabs

**Files:**
- Modify: `packages/web/src/components/project/project-tab-registry.ts`
- Create: `packages/web/src/components/project/ProjectTemplatesTab.tsx`
- Create: `packages/web/src/components/project/ProjectAgentsTab.tsx`

- [ ] **Step 1: Add Templates tab**

Shows templates scoped to this project (from project hierarchy). Click to expand details. "Trigger" button for manual templates.

- [ ] **Step 2: Add Agents tab**

Shows agents scoped to this project (from project hierarchy). Indicates which are inherited vs. defined at this level. "Edit" and "Create Agent" buttons.

- [ ] **Step 3: Register new tabs**

Add to the default tab registry:
```typescript
{ key: 'agents', label: 'Agents', component: ProjectAgentsTab },
{ key: 'templates', label: 'Templates', component: ProjectTemplatesTab },
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): add Agents and Templates tabs to project detail page"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Build web package**: `npm run build -w packages/web` (or just type-check since Next.js builds on demand)
- [ ] **Step 2: Run lint**: `npm run check`
- [ ] **Step 3: Verify dashboard loads**: start dev server and check each new page works
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: complete Phase 7 — dashboard updates for Raven v2"
```

---

## Summary

After completing all 8 tasks:

- **API client**: new functions for templates, task trees, scaffolding, project children
- **Project hierarchy**: tree view with sub-projects, badges
- **Templates page**: grid view with trigger functionality
- **Task trees page**: tree visualization with approval controls, progress tracking
- **Skill library**: hierarchical browser organized by domain
- **Agent form**: skills selection, bash config, project scope
- **Project detail**: new Agents and Templates tabs
