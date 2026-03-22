# Story 10.3: Meta-Project & System Access Control

Status: done

## Story

As the system operator,
I want a zero-project chat for system management and configurable access control per project,
So that I can manage Raven itself through conversation and control which projects can modify system files.

## Acceptance Criteria

1. **Given** no project is selected in the dashboard or Telegram
   **When** the user starts a chat
   **Then** it operates under a built-in "meta" project that has access to system-level operations (create projects, review agents, manage pipelines, adjust config)

2. **Given** the meta-project chat is active
   **When** the user says "Create a new project called X"
   **Then** a project is created in the database, a Telegram topic thread is created, and the user is notified

3. **Given** the meta-project chat is active
   **When** the user says "Show me all projects" or "Review project X"
   **Then** project details are displayed including task counts, recent activity, and linked pipelines

4. **Given** a project is configured
   **When** the `system_access` field is set
   **Then** it controls whether project agents can read/write Raven system files (`config/`, `packages/`, pipeline definitions) — values: `none` (default), `read`, `read-write`

5. **Given** a project has `system_access: "read-write"`
   **When** its agents propose changes to system files
   **Then** changes follow the existing permission tier system (Red tier by default for system file modifications)

6. **Given** a project has `system_access: "none"`
   **When** an agent in that project attempts to read or modify system files
   **Then** the operation is blocked and logged in the audit trail

7. **Given** an agent is spawned for any project
   **When** the orchestrator configures its context
   **Then** the agent receives an explicit instruction to use tools purposefully — no speculative codebase exploration unless the task requires file inspection

8. **Given** the meta-project has `system_access: "read-write"` by default
   **When** a meta-project agent needs to create a new pipeline or adjust a skill
   **Then** it can read and modify system files, subject to permission tier enforcement

## Tasks / Subtasks

- [x] Task 1: Database migration — add `system_access` column to `projects` and seed meta-project (AC: 1, 4)
  - [x]Create migration `017-meta-project.sql`
  - [x]`ALTER TABLE projects ADD COLUMN system_access TEXT NOT NULL DEFAULT 'none'` — values: `none`, `read`, `read-write`
  - [x]`ALTER TABLE projects ADD COLUMN is_meta INTEGER NOT NULL DEFAULT 0`
  - [x]INSERT a meta-project row: fixed well-known ID `'meta'`, `name` = `'Raven System'`, `description` = `'System management and administration'`, `system_access` = `'read-write'`, `is_meta` = `1`
  - [x]Add index: `idx_projects_is_meta` for quick lookup

- [x] Task 2: Shared types — extend `Project` interface and add Zod schemas (AC: 4)
  - [x]Add `systemAccess?: 'none' | 'read' | 'read-write'` and `isMeta?: boolean` to `Project` interface in `packages/shared/src/types/projects.ts`
  - [x]Create `SystemAccessLevel` Zod enum: `z.enum(['none', 'read', 'read-write'])`
  - [x]Create `ProjectCreateInput` and `ProjectUpdateInput` Zod schemas with `systemAccess` field
  - [x]Export from barrel files

- [x] Task 3: Meta-project store — lookup and protection functions (AC: 1, 2, 3)
  - [x]Create `packages/core/src/project-manager/meta-project.ts`
  - [x]`getMetaProject(): Project` — queries `projects` table where `is_meta = 1`, throws if not found (fatal on boot)
  - [x]`isMetaProject(projectId: string): boolean` — quick check
  - [x]`META_PROJECT_ID` constant — the well-known ID `'meta'` used during migration seed
  - [x]On boot: verify meta-project exists in DB (called from `index.ts`)

- [x] Task 4: System access gate — enforce `system_access` in orchestrator prompt (AC: 4, 5, 6, 7, 8)
  - [x]Create `packages/core/src/project-manager/system-access-gate.ts`
  - [x]`resolveSystemAccessInstructions(project: Project): string` — returns prompt instructions based on `system_access` level:
    - `none`: "You MUST NOT read or modify any system files (config/, packages/, migrations/, pipelines/). If asked to do so, explain that this project does not have system access and suggest using the Raven System project instead."
    - `read`: "You may READ system files (config/, packages/) for reference, but MUST NOT modify them. If modification is requested, explain the project only has read access."
    - `read-write`: "You may read and modify system files (config/, packages/, pipeline definitions). System file modifications are subject to permission tier enforcement — file changes default to Red tier and require approval."
  - [x]`resolveToolUseInstructions(): string` — returns instruction for purposeful tool use: "Use tools purposefully. Do not speculatively explore the codebase unless the task explicitly requires file inspection. Focus on the user's request."
  - [x]Both functions return prompt strings that the orchestrator prepends

- [x] Task 5: Orchestrator integration — meta-project routing and system access (AC: 1, 2, 3, 7)
  - [x]Modify `packages/core/src/orchestrator/orchestrator.ts` `handleUserChat()`:
    - Look up the project from DB to get `system_access` field
    - Call `resolveSystemAccessInstructions(project)` and prepend to prompt
    - Call `resolveToolUseInstructions()` and prepend to prompt
  - [x]When `projectId` matches meta-project: prepend additional meta-project system prompt instructions telling the agent it can manage projects, agents, pipelines, schedules, and config via the REST API (list endpoints and their purposes)
  - [x]Meta-project prompt should include API URL references for all management endpoints: `/api/projects`, `/api/agents`, `/api/pipelines`, `/api/schedules`, `/api/suites`, `/api/skills`

- [x] Task 6: Audit logging for system access violations (AC: 6)
  - [x]In the system access gate, when system access instructions are applied, log an audit entry: `action_name: 'system:access:configured'`, `details: { projectId, systemAccess, projectName }`
  - [x]Use existing `appendAuditEntry()` from `packages/core/src/permission-engine/audit-log.ts`
  - [x]Note: enforcement is prompt-based (instruction to the LLM), not filesystem-level. Agents run as Claude SDK subprocesses with full filesystem access. The existing Red-tier permission gate in `agent-session.ts` handles approval for dangerous operations.

- [x] Task 7: Update Projects API — expose `system_access` field (AC: 4)
  - [x]Modify `packages/core/src/api/routes/projects.ts`:
    - `GET /api/projects` — include `systemAccess` and `isMeta` in response
    - `POST /api/projects` — accept optional `systemAccess` field (default `'none'`), reject `isMeta: true` (only migration creates meta-project)
    - `PUT /api/projects/:id` — accept `systemAccess` updates, reject changes to `is_meta` field
    - `DELETE /api/projects/:id` — reject deletion of meta-project (400 error)
  - [x]Add Zod validation to all project input endpoints
  - [x]Update `parseProjectRow()` to include new fields

- [x] Task 8: Dashboard — meta-project selector and system access UI (AC: 1, 4)
  - [x]Modify `packages/web/src/components/layout/Sidebar.tsx` or project selector:
    - Pin "Raven System" meta-project at the top of the project list with a distinct icon/badge (e.g., gear icon or crown)
    - Meta-project always visible, cannot be hidden or deleted from UI
  - [x]Modify project creation/edit form (wherever projects are managed):
    - Add `system_access` dropdown: `none` (default) | `read` | `read-write`
    - Show helper text explaining each level
    - Hide `system_access` field for meta-project (always read-write, not editable)
  - [x]If no project is selected on dashboard load, default to meta-project

- [x] Task 9: Telegram integration — meta-project topic and routing (AC: 1, 2)
  - [x]Ensure meta-project has a dedicated Telegram topic thread (follow existing pattern from `telegram-bot.ts`)
  - [x]When a Telegram message comes in without a topic association, route to meta-project (system-level chat)
  - [x]When a project is created via meta-project chat (AC 2), create a Telegram topic thread for the new project

- [x] Task 10: Wire into boot sequence (AC: 1)
  - [x]In `packages/core/src/index.ts`: after DB initialization, verify meta-project exists (call `getMetaProject()`)
  - [x]If meta-project missing (fresh DB after migration), the migration INSERT should have created it — log error and exit if not found
  - [x]Pass meta-project reference to orchestrator deps

## Dev Notes

### Architecture: System Access Control Layer

This story adds **prompt-based access control** on top of the existing permission tier system. It does NOT add filesystem-level enforcement (agents run as separate Claude SDK subprocesses with full filesystem access). Instead, it works by:

1. **Prompt instructions**: The orchestrator prepends system access rules to every agent prompt based on the project's `system_access` level. Claude respects these instructions.
2. **Permission tier enforcement**: The existing Red-tier gate in `agent-session.ts` continues to enforce approval for dangerous operations. System file modifications default to Red tier regardless of `system_access` level.
3. **Audit trail**: System access configuration is logged for traceability.

This is a pragmatic approach for a single-user system. True filesystem sandboxing would require containerization or seccomp, which is overkill here.

### Existing Code to Reuse — DO NOT Rebuild

| What | Where | Reuse How |
|------|-------|-----------|
| Project CRUD | `packages/core/src/api/routes/projects.ts` | Extend with `system_access` and `is_meta` fields |
| Project type | `packages/shared/src/types/projects.ts` | Extend `Project` interface |
| Permission engine | `packages/core/src/permission-engine/permission-engine.ts` | Already handles tier resolution — no changes needed |
| Audit log writer | `packages/core/src/permission-engine/audit-log.ts` | Use `appendAuditEntry()` for system access logging |
| Orchestrator handleUserChat | `packages/core/src/orchestrator/orchestrator.ts` | Extend to prepend system access + tool use instructions |
| Named agent store | `packages/core/src/agent-registry/named-agent-store.ts` | Already resolves named agents — no changes needed |
| Telegram topic creation | `suites/notifications/services/telegram-bot.ts` | Follow existing topic creation pattern for meta-project |
| Migration runner | `packages/core/src/db/migrations.ts` | Automatically applies `017-meta-project.sql` |
| Git auto-commit | `packages/shared/src/utils/git-commit.ts` | Use `execFile` wrapper (not `exec`) for config changes |
| Sidebar project selector | `packages/web/src/components/layout/Sidebar.tsx` | Extend with meta-project pinning |

### File Structure

New files:
```
migrations/017-meta-project.sql                              — Schema migration + meta-project seed
packages/core/src/project-manager/meta-project.ts            — Meta-project lookup and constants
packages/core/src/project-manager/system-access-gate.ts      — System access prompt instructions
```

Modified files:
```
packages/shared/src/types/projects.ts                        — Add systemAccess, isMeta to Project
packages/shared/src/types/index.ts                           — Export new types
packages/shared/src/index.ts                                 — Re-export
packages/core/src/orchestrator/orchestrator.ts               — Prepend system access + tool use instructions
packages/core/src/api/routes/projects.ts                     — Expose system_access, protect meta-project
packages/core/src/index.ts                                   — Verify meta-project on boot
packages/web/src/components/layout/Sidebar.tsx               — Pin meta-project in project selector
packages/web/src/lib/api-client.ts                           — Update project types
suites/notifications/services/telegram-bot.ts                — Meta-project topic thread
```

### Database Conventions

- Column: `system_access TEXT NOT NULL DEFAULT 'none'` — string enum enforced at application level via Zod
- Column: `is_meta INTEGER NOT NULL DEFAULT 0` — boolean flag (SQLite has no native bool)
- Meta-project ID: use a fixed well-known string `'meta'` (not a random UUID) — makes lookups simple and deterministic
- Meta-project is seed data in the migration (INSERT ... ON CONFLICT DO NOTHING for idempotency)

### API Conventions

- `GET /api/projects` — includes `systemAccess` and `isMeta` in each project response
- `POST /api/projects` — accepts optional `systemAccess` (default `'none'`), rejects `isMeta: true`
- `PUT /api/projects/:id` — accepts `systemAccess` updates, rejects `isMeta` changes
- `DELETE /api/projects/:id` — returns 400 if `is_meta = 1` with `{ error: 'Cannot delete the system meta-project' }`
- Validate all input with Zod `safeParse()` at route handler level
- Direct responses — no envelope. Errors: `{ error: string, code?: string }`

### Orchestrator Changes — Critical Design

Current `handleUserChat()` flow:
```
event -> ensureProject -> getSession -> knowledgeContext -> resolveNamedAgent -> buildPrompt -> emit task
```

After this story:
```
event -> ensureProject -> getSession -> knowledgeContext -> resolveNamedAgent -> lookupProjectSystemAccess -> resolveSystemAccessInstructions -> resolveToolUseInstructions -> [if meta: prependMetaInstructions] -> buildPrompt -> emit task
```

The system access instructions are prepended BEFORE named agent instructions and BEFORE the user message. This ensures Claude sees the access rules first.

**Prompt layering order** (top to bottom):
1. System access instructions (from `system-access-gate.ts`)
2. Tool use instructions (purposeful tool use)
3. Meta-project management instructions (only for meta-project)
4. Named agent instructions (from `namedAgent.instructions`)
5. Agent config management note (existing)
6. Topic context (existing)
7. User message (existing)

### Meta-Project Prompt Content

When the project is the meta-project, prepend management API instructions listing all available endpoints at `http://localhost:{port}`:
- GET/POST `/api/projects` — List and create projects
- PUT/DELETE `/api/projects/:id` — Update and delete projects
- GET/POST/PATCH/DELETE `/api/agents` — Named agent management
- GET `/api/pipelines` — List pipelines
- POST `/api/pipelines/:name/trigger` — Trigger a pipeline
- GET/POST `/api/schedules` — Schedule management
- GET `/api/suites` — List available suites
- GET `/api/skills` — List registered skills
- GET `/api/audit-logs` — View audit trail

### Dashboard Design

**Project Selector (Sidebar):**
- Meta-project pinned at top, separated by a divider line
- Displayed as: gear icon + "Raven System" (distinctive styling)
- Always visible, cannot be removed
- Clicking it opens the system management chat

**Project Edit (System Access):**
- Dropdown/select for `system_access` with three options:
  - `none` — "No system file access (default)"
  - `read` — "Can read system files (config, code)"
  - `read-write` — "Can read and modify system files (requires approval)"
- Disabled for meta-project (locked to `read-write`)
- Helper text below: "Controls whether agents in this project can access Raven's system files"

### Telegram Integration

- On boot: ensure meta-project has a topic thread named "Raven System" (follow existing pattern)
- Messages received in the Raven System topic -> routed to meta-project
- When a new project is created via meta-project chat -> use existing `createForumTopic()` to create a topic
- The meta-project topic is where system management conversations happen

### Testing Strategy

- **Integration test** for meta-project store: verify meta-project exists after migration, `getMetaProject()` returns correct data, `isMetaProject()` works. Use temp SQLite DB.
- **Unit test** for system-access-gate: verify prompt instructions for each access level (`none`, `read`, `read-write`), verify tool use instructions.
- **API test** for projects routes: verify `systemAccess` field in responses, verify meta-project cannot be deleted, verify `isMeta` cannot be set via API.
- **Integration test** for orchestrator: verify system access instructions are prepended to prompts based on project config.
- **No real Claude SDK calls** — mock in all tests.
- Test files: `packages/core/src/__tests__/meta-project.test.ts`, `system-access-gate.test.ts`, `projects-api.test.ts`

### Anti-Patterns to Avoid

- **Do NOT attempt filesystem-level sandboxing** — agents run as Claude SDK subprocesses with full access. Enforcement is prompt-based.
- **Do NOT modify the permission engine** — it already handles tier resolution correctly. System access is an orthogonal layer.
- **Do NOT create a separate "meta-project" code path in the orchestrator** — use the same `handleUserChat()` flow with additional prompt instructions.
- **Do NOT hardcode the meta-project ID in multiple places** — use the `META_PROJECT_ID` constant from `meta-project.ts`.
- **Do NOT modify `agent-session.ts`** — the permission gate already works. System access is enforced at the prompt level, not at the agent session level.
- **Do NOT import `better-sqlite3` directly** — use `getDb()` from `database.ts`.
- **Do NOT use `child_process.exec()`** — use `execFile` to prevent shell injection.
- **Do NOT break backward compatibility** — existing projects without `system_access` default to `'none'` via the migration DEFAULT clause.

### Previous Story (10.2) Learnings

- **Named agent layer works well**: The pattern of resolving capabilities before spawning was clean. System access follows the same pattern — resolve access level, generate prompt instructions, prepend to prompt.
- **Boot order matters**: Story 10.2 required DB -> suite registry -> named-agent-store -> agent-resolver -> orchestrator. This story adds: DB -> migration (seeds meta-project) -> meta-project verification -> pass to orchestrator. Keep it in sequence.
- **Config file sync + git auto-commit pattern**: Story 10.2 used config-committer for agent config changes. This story doesn't need a new config file — `system_access` lives in the DB as part of the project row.
- **Factory functions only**: No classes, no singletons. `meta-project.ts` and `system-access-gate.ts` export pure functions.
- **Zod validation at boundaries**: All new API inputs must use Zod `safeParse()`. Story 10.2 caught issues with missing validation.
- **Enrich from the start**: Story 10.2 review caught missing enrichment. Include `systemAccess` and `isMeta` in project responses from day one.
- **Protect defaults**: Story 10.2 prevented deleting the default agent. Same pattern here — prevent deleting/modifying the meta-project's `is_meta` flag.

### Git Intelligence

Recent commits show:
- `8189f65` — story 10.2: named agent management with suite filtering, CRUD, dashboard, Telegram topics
- `e091adb` — story 10.1: two-layer task model, templates, TickTick sync
- Commit style: `feat: <description> (story X.Y)` for features
- Code review fixes committed separately
- kebab-case files, one concern per file, factory functions

### Project Structure Notes

- New `project-manager/` directory parallels existing subsystem directories (`agent-registry/`, `permission-engine/`, etc.)
- `meta-project.ts` is a small utility module (< 50 lines) — just lookup functions and constants
- `system-access-gate.ts` is pure functions returning prompt strings (< 80 lines)
- No new npm dependencies required

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10 — Story 10.3]
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security]
- [Source: _bmad-output/planning-artifacts/architecture.md#Structure Patterns — Permission Action Declaration]
- [Source: packages/shared/src/types/projects.ts — current Project interface]
- [Source: packages/core/src/api/routes/projects.ts — current project CRUD routes]
- [Source: packages/core/src/orchestrator/orchestrator.ts — handleUserChat() flow, lines 205-305]
- [Source: packages/core/src/permission-engine/permission-engine.ts — existing tier resolver]
- [Source: packages/core/src/permission-engine/audit-log.ts — appendAuditEntry()]
- [Source: packages/core/src/agent-registry/named-agent-store.ts — named agent pattern from 10.2]
- [Source: packages/core/src/index.ts — boot sequence]
- [Source: suites/notifications/services/telegram-bot.ts — topic creation pattern]
- [Source: _bmad-output/implementation-artifacts/10-2-agent-management-and-skill-binding.md — previous story learnings]
- [Source: _bmad-output/project-context.md — coding conventions and rules]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Task 1: Created migration `017-meta-project.sql` — adds `system_access` (TEXT, default 'none') and `is_meta` (INTEGER, default 0) columns to projects table, creates `idx_projects_is_meta` index, seeds meta-project row with ID 'meta'
- Task 2: Extended `Project` interface with `systemAccess` and `isMeta` fields. Added `SystemAccessLevel` Zod enum, `ProjectCreateInput` and `ProjectUpdateInput` Zod schemas
- Task 3: Created `packages/core/src/project-manager/meta-project.ts` with `getMetaProject()`, `isMetaProject()`, and `META_PROJECT_ID` constant
- Task 4: Created `packages/core/src/project-manager/system-access-gate.ts` with `resolveSystemAccessInstructions()` and `resolveToolUseInstructions()` — returns prompt strings per access level
- Task 5: Modified orchestrator `handleUserChat()` to look up project system_access, prepend access control instructions, tool use instructions, and meta-project management API instructions (listing all REST endpoints)
- Task 6: Added audit logging for system access configuration — `system:access:configured` entry written on every chat via `createAuditLog(db).insert()`
- Task 7: Updated projects API with Zod validation, `systemAccess`/`isMeta` in responses, meta-project deletion protection (400), `isMeta` field protection, and `systemAccess` field in create/update
- Task 8: Sidebar: pinned "Raven System" meta-project at top with `$` icon. Projects page: meta-project card with accent border, system access dropdown in create form, access level badges
- Task 9: Updated Telegram `resolveProjectId()` to route System/unknown topics to meta-project instead of `telegram-default`. Added `ensureProjectTopic()` function and `project:created` event listener
- Task 10: Added `getMetaProject()` verification to boot sequence in `packages/core/src/index.ts` after DB init — fatal exit if missing

### Change Log

- 2026-03-22: Story 10.3 implementation complete — all 10 tasks implemented and tested
- 2026-03-22: Code review fixes applied:
  - [H1] Fixed `api.createProject()` in api-client.ts to include `systemAccess` param; projects page now passes it
  - [H2] Added `ProjectCreatedEvent` type and `project:created` event emission from `POST /api/projects` via eventBus; route now receives deps
  - [M1] Moved `META_PROJECT_ID` to `@raven/shared` constants; removed duplicate from telegram-bot.ts
  - [M2] Reduced audit log noise — only writes `system:access:configured` for non-default access levels
  - [L1] Added `systemAccess` to `updateProject` type in api-client.ts
  - Fixed pre-existing `database.test.ts` failure (expected count 2→3 due to meta-project seed)
  - Updated `telegram-bot.test.ts` mock to include `META_PROJECT_ID` export

### File List

New files:
- `migrations/017-meta-project.sql`
- `packages/core/src/project-manager/meta-project.ts`
- `packages/core/src/project-manager/system-access-gate.ts`
- `packages/core/src/__tests__/meta-project.test.ts`
- `packages/core/src/__tests__/system-access-gate.test.ts`
- `packages/core/src/__tests__/projects-api.test.ts`

Modified files:
- `packages/shared/src/types/projects.ts`
- `packages/shared/src/types/events.ts` — added `ProjectCreatedEvent`
- `packages/shared/src/suites/constants.ts` — added `META_PROJECT_ID`
- `packages/shared/src/suites/index.ts` — re-export `META_PROJECT_ID`
- `packages/core/src/orchestrator/orchestrator.ts`
- `packages/core/src/api/routes/projects.ts` — accepts deps, emits `project:created`
- `packages/core/src/api/server.ts` — passes eventBus to project routes
- `packages/core/src/index.ts`
- `packages/core/src/project-manager/meta-project.ts` — imports `META_PROJECT_ID` from shared
- `packages/core/src/__tests__/orchestrator.test.ts`
- `packages/core/src/__tests__/api.test.ts` — passes eventBus to registerProjectRoutes
- `packages/core/src/__tests__/database.test.ts` — fixed project count assertion
- `packages/web/src/components/layout/Sidebar.tsx`
- `packages/web/src/app/projects/page.tsx` — passes systemAccess to createProject
- `packages/web/src/lib/api-client.ts` — added systemAccess to create/update types
- `suites/notifications/services/telegram-bot.ts` — imports META_PROJECT_ID from shared
- `suites/notifications/__tests__/telegram-bot.test.ts` — added META_PROJECT_ID to mock
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
