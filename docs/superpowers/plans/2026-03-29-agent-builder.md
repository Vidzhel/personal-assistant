# Agent Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a dedicated Agent Builder agent that scaffolds entire project domains from natural language descriptions — creating project directories, agent YAMLs, templates, schedules, and context files.

**Architecture:** The agent builder is a named agent with a detailed system prompt and access to scaffolding tools via a dedicated MCP or direct file system access. When triggered, it asks clarifying questions, designs a plan, displays it for approval, then creates all files. It uses the existing project registry, agent YAML store, and template system. A new scaffolding API provides structured operations (create project, create agent, create template, create schedule).

**Tech Stack:** TypeScript ESM, existing agent YAML store, project registry, js-yaml

---

## File Structure

### New files:

```
projects/agents/_agent-builder.yaml          # Agent definition with scaffolding instructions
packages/core/src/scaffolding/
├── scaffolding-api.ts                       # Functions for creating projects/agents/templates
└── scaffolding-routes.ts                    # REST API for scaffolding operations
```

### Files to modify:

```
packages/core/src/api/server.ts              # Register scaffolding routes
packages/core/src/index.ts                   # Wire scaffolding deps
```

---

### Task 1: Build Scaffolding API

**Files:**
- Create: `packages/core/src/scaffolding/scaffolding-api.ts`
- Test: `packages/core/src/__tests__/scaffolding-api.test.ts`

- [ ] **Step 1: Write failing test**

Tests for:
- `createProject(opts)` — creates directory + context.md
- `createAgent(opts)` — creates agent YAML in correct project scope
- `createTemplate(opts)` — creates template YAML in correct project scope
- `createSchedule(opts)` — creates schedule YAML
- Nested project creation (parent must exist)
- Reloads project registry after scaffolding

- [ ] **Step 2: Implement scaffolding-api.ts**

```typescript
export interface ScaffoldingDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  agentYamlStore: AgentYamlStore;
}

export interface ScaffoldProjectInput {
  path: string;             // relative to projectsDir, e.g. "uni/calculus"
  displayName?: string;
  description?: string;
  systemAccess?: 'none' | 'read' | 'read-write';
}

export interface ScaffoldAgentInput {
  projectPath: string;      // relative to projectsDir, e.g. "uni" or "" for global
  agent: AgentYaml;
}

export interface ScaffoldTemplateInput {
  projectPath: string;
  template: TaskTemplate;
}

export interface ScaffoldScheduleInput {
  projectPath: string;
  schedule: ScheduleYaml;
}

export function createScaffoldingApi(deps: ScaffoldingDeps) {
  return {
    async createProject(input: ScaffoldProjectInput): Promise<void>,
    async createAgent(input: ScaffoldAgentInput): Promise<void>,
    async createTemplate(input: ScaffoldTemplateInput): Promise<void>,
    async createSchedule(input: ScaffoldScheduleInput): Promise<void>,
    async scaffoldDomain(plan: ScaffoldPlan): Promise<ScaffoldResult>,
  }
}
```

`scaffoldDomain(plan)` is the high-level function that creates everything from a structured plan:

```typescript
interface ScaffoldPlan {
  projects: ScaffoldProjectInput[];
  agents: ScaffoldAgentInput[];
  templates: ScaffoldTemplateInput[];
  schedules: ScaffoldScheduleInput[];
}

interface ScaffoldResult {
  projectsCreated: string[];
  agentsCreated: string[];
  templatesCreated: string[];
  schedulesCreated: string[];
  errors: string[];
}
```

After scaffolding, reload the project registry.

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add scaffolding API for project domain creation"
```

---

### Task 2: Add Scaffolding REST Routes

**Files:**
- Create: `packages/core/src/scaffolding/scaffolding-routes.ts`
- Modify: `packages/core/src/api/server.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create scaffolding routes**

```
POST /api/scaffold/project          — create a project directory + context.md
POST /api/scaffold/agent            — create an agent YAML in a project
POST /api/scaffold/template         — create a template YAML in a project
POST /api/scaffold/schedule         — create a schedule YAML in a project
POST /api/scaffold/domain           — execute a full scaffold plan (creates everything)
```

The `/api/scaffold/domain` endpoint accepts a `ScaffoldPlan` JSON body and returns a `ScaffoldResult`.

- [ ] **Step 2: Wire into boot and server**

Pass scaffolding API to the server deps. Register routes.

- [ ] **Step 3: Build, test, commit**

```bash
git commit -m "feat(api): add scaffolding REST routes for project domain creation"
```

---

### Task 3: Create Agent Builder Agent Definition

**Files:**
- Create: `projects/agents/_agent-builder.yaml`

- [ ] **Step 1: Write the agent builder YAML**

```yaml
name: _agent-builder
displayName: Agent Builder
description: Scaffolds entire project domains — creates projects, agents, templates, and schedules from natural language descriptions
isDefault: false
skills: []
model: opus
maxTurns: 30
bash:
  access: none
instructions: |
  You are the Raven Agent Builder. Your job is to scaffold project domains from natural language descriptions.

  ## Your Workflow

  1. **UNDERSTAND** — Ask the user clarifying questions:
     - What domain is this for? (university, work, personal, etc.)
     - What tools/integrations are needed? (calendar, tasks, email, notes)
     - What recurring patterns exist? (daily classes, weekly reviews)
     - What agents would be useful? (per-subject, coordinator, etc.)
     - How autonomous should agents be?

  2. **DESIGN** — Produce a structured plan showing:
     - Project hierarchy (parent → sub-projects)
     - Agent definitions with skill assignments
     - Template definitions for recurring workflows
     - Schedule definitions for automated triggers
     Present this as a clear summary for the user.

  3. **APPROVE** — Ask the user to review and approve the plan.
     Do NOT proceed without explicit approval.

  4. **SCAFFOLD** — Use the Raven scaffolding API to create everything:
     - POST /api/scaffold/domain with the full plan
     OR create items individually:
     - POST /api/scaffold/project for each project
     - POST /api/scaffold/agent for each agent
     - POST /api/scaffold/template for each template
     - POST /api/scaffold/schedule for each schedule

  5. **VERIFY** — Confirm what was created. Report any errors.

  ## Available Skills (for agent assignments)

  When assigning skills to agents, choose from the capability library:
  - ticktick — Task management via TickTick
  - gmail — Email management via Gmail
  - pdf, docx, xlsx, pptx — Document processing
  - ffmpeg — Audio/video processing
  - transcription — Voice/audio transcription
  - telegram — Messaging via Telegram
  - calendar — Google Calendar access
  - daily-digest — Briefing compilation
  - transactions — Financial tracking

  ## Agent YAML Format

  Each agent needs: name (kebab-case), displayName, description, skills[], instructions, model (haiku/sonnet/opus).

  ## Template Format

  Each template needs: name, displayName, tasks[] (with id, type, title, prompt/script, blockedBy), trigger (manual/schedule/event).

  ## Important Rules

  - Agent names MUST be kebab-case: my-agent (not myAgent or My Agent)
  - Template names MUST be kebab-case
  - Project paths use / for hierarchy: uni/calculus
  - Every project gets a context.md with description
  - Ask ONE question at a time during the UNDERSTAND phase
  - Always get approval before scaffolding
```

- [ ] **Step 2: Validate and commit**

```bash
npm run validate:projects
git commit -m "feat: add agent builder agent definition for project domain scaffolding"
```

---

### Task 4: Integration Test

**Files:**
- Create: `packages/core/src/__tests__/scaffolding-integration.test.ts`

- [ ] **Step 1: Write integration test**

Tests using temp directories:
- Full domain scaffolding: creates projects, agents, templates, schedules
- Created files are valid (pass project validator)
- Project registry reloads correctly after scaffolding
- Agent YAML files are parseable
- Template YAML files are parseable
- Nested project creation works

- [ ] **Step 2: Run, fix, commit**

```bash
git commit -m "test: add scaffolding integration test"
```

---

### Task 5: Final Verification

- [ ] **Step 1**: `npm run build`
- [ ] **Step 2**: `npm test`
- [ ] **Step 3**: `npm run check`
- [ ] **Step 4**: `npm run validate:library && npm run validate:projects`
- [ ] **Step 5**: Commit

```bash
git commit -m "feat: complete Phase 6 — agent builder for project domain scaffolding"
```

---

## Summary

After completing all 5 tasks:

- **Scaffolding API**: create projects, agents, templates, schedules programmatically
- **REST endpoints**: POST /api/scaffold/* for all operations + domain bulk scaffolding
- **Agent builder agent**: detailed YAML with structured workflow (understand → design → approve → scaffold → verify)
- **Validation**: scaffolded files validated by project validator
- **Integration tested**: full domain scaffolding creates valid structures

The agent builder can be triggered via chat ("Set up my university project") — the orchestrator routes to it based on its description, and it walks through the design workflow, creating all files via the scaffolding API.

**Next plan**: Phase 7 — Dashboard Updates
