# Story 10.2: Agent Management & Skill Binding

Status: done

## Story

As the system operator,
I want named agents with dedicated skill sets, task history, and configurable instructions,
So that I can build specialized teammates and understand what each one does and has done.

## Acceptance Criteria

1. **Given** the agent registry is initialized
   **When** agents are configured in `config/agents.json`
   **Then** each agent has: `id`, `name`, `description`, `instructions` (system prompt additions), `suite_ids` (bound suites), `created_at`

2. **Given** an agent is bound to specific suites
   **When** it is spawned for a task
   **Then** only its bound suites' MCP servers and sub-agent definitions are available — no access to other agents' suites

3. **Given** an "exploration" agent is configured with knowledge-base suites
   **When** a research request comes in
   **Then** the orchestrator delegates to this agent, which uses knowledge retrieval, embedding search, and link suggestion tools

4. **Given** an "analytics" agent is configured with web research suites
   **When** an information-gathering request comes in
   **Then** it uses web fetch, YouTube transcript extraction, and general link parsing — separate from the exploration agent's suite set

5. **Given** the user opens the agents page in the dashboard
   **When** the page loads
   **Then** each agent shows: name, description, assigned suites, task counts (completed/in-progress), a link to full task history, and a **green dot** next to the name if the agent currently has running tasks

6. **Given** the user wants to create or adjust an agent
   **When** they use the dashboard UI
   **Then** a form modal allows setting the agent's name, description, instructions (textarea), and suite bindings (multi-select checkboxes) — changes are persisted to `config/agents.json` and git-committed

7. **Given** an agent completes a task
   **When** the task history is queried
   **Then** it shows chronological entries: task title, status transitions, duration, and artifacts produced

10. **Given** the user is creating or editing an agent
    **When** they need a suite that doesn't exist yet
    **Then** they can click "Create Suite" from the agent form to scaffold a new lightweight suite (name, display name, description, optional MCP server config) — the suite directory is generated, registered in `config/suites.json`, and available for binding immediately

11. **Given** multiple agents need the same suite
    **When** they are configured
    **Then** multiple named agents can independently bind to the same suite — each gets its own copy of that suite's MCP servers and sub-agent definitions when spawned

8. **Given** each agent is registered
   **When** the Telegram bot initializes
   **Then** a dedicated topic thread is created per agent in the Raven supergroup for that agent's task updates and formatted output

9. **Given** the user asks the orchestrator to adjust an agent's suites via chat
   **When** the request is processed
   **Then** the agent config is updated, the change is git-committed, and the agent is reloaded with the new suite set

## Tasks / Subtasks

- [x] Task 1: Database schema — `named_agents` table and migration (AC: 1)
  - [x] Create migration `016-named-agents.sql` in `migrations/`
  - [x] Schema: `id TEXT PK`, `name TEXT NOT NULL UNIQUE`, `description TEXT`, `instructions TEXT`, `suite_ids TEXT` (JSON array), `is_default INTEGER NOT NULL DEFAULT 0`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
  - [x] Indexes: `idx_named_agents_name` (unique, for lookup by name)
  - [x] Seed initial default agent (the "orchestrator" catch-all) via migration INSERT

- [x] Task 2: Shared types for named agents (AC: 1, 2)
  - [x] Add `NamedAgent` interface to `packages/shared/src/types/agents.ts`
  - [x] Add `NamedAgentCreateInput` and `NamedAgentUpdateInput` Zod schemas
  - [x] Add new event types: `agent:config:created`, `agent:config:updated`, `agent:config:deleted`
  - [x] Export from `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts`

- [x] Task 3: Named agent store — CRUD operations (AC: 1, 6, 9)
  - [x] Create `packages/core/src/agent-registry/named-agent-store.ts`
  - [x] `createAgent(input: NamedAgentCreateInput): NamedAgent` — insert, emit event, sync to `config/agents.json`
  - [x] `updateAgent(id, input: NamedAgentUpdateInput): NamedAgent` — update, emit event, sync to `config/agents.json`
  - [x] `deleteAgent(id): void` — delete (prevent deleting default agent), emit event, sync to `config/agents.json`
  - [x] `getAgent(id): NamedAgent | undefined`
  - [x] `getAgentByName(name): NamedAgent | undefined`
  - [x] `getDefaultAgent(): NamedAgent` — returns the catch-all agent
  - [x] `listAgents(): NamedAgent[]`
  - [x] `syncToConfigFile(): void` — writes current DB state to `config/agents.json` for git-commit visibility
  - [x] `loadFromConfigFile(): void` — on boot, seeds DB from `config/agents.json` if DB is empty (config is source of truth for initial state)
  - [x] Inject `DatabaseInterface` and `EventBus` via factory function
  - [x] `suite_ids` stored as JSON string in DB, parsed to `string[]` on read

- [x] Task 4: Agent resolver — suite filtering for spawning (AC: 2, 3, 4)
  - [x] Create `packages/core/src/agent-registry/agent-resolver.ts`
  - [x] `resolveAgentCapabilities(namedAgent: NamedAgent): { mcpServers, agentDefinitions }` — filters suite registry to only include bound suites' MCPs and agent definitions
  - [x] If `suite_ids` is empty or agent is default → returns ALL suites' capabilities (backward-compatible)
  - [x] Validates that all `suite_ids` reference enabled suites — logs warning for missing ones
  - [x] Uses existing `suiteRegistry.collectMcpServers(suiteNames)` and `suiteRegistry.collectAgentDefinitions(suiteNames)` — these already accept optional suite name filters

- [x] Task 5: Orchestrator integration — route to named agents (AC: 2, 3, 4, 9)
  - [x] Modify `packages/core/src/orchestrator/orchestrator.ts` to look up named agents
  - [x] When handling `user:chat:message`: check if the project has an `assigned_agent_id` → resolve that named agent's capabilities instead of all suites
  - [x] When no specific agent is assigned → use default agent (all capabilities, backward-compatible)
  - [x] Pass named agent's `instructions` as additional system prompt context to the orchestrator prompt
  - [x] For chat-based agent config updates (AC 9): add a system prompt instruction telling the orchestrator it can modify agent configs via the agent CRUD API
  - [x] Ensure the agent:task:request event payload includes `namedAgentId` for tracking

- [x] Task 6: Git auto-commit for agent config changes (AC: 6, 9)
  - [x] Create `packages/core/src/agent-registry/config-committer.ts`
  - [x] Listen for `agent:config:created`, `agent:config:updated`, `agent:config:deleted` events
  - [x] On each event: run `git add config/agents.json && git commit -m "chore: update agent config — {agent_name}"` via `execFile` (use `child_process.execFile`, NOT `exec` — prevents shell injection)
  - [x] Non-blocking — fire and forget, log errors
  - [x] Skip if not a git repo or if git is not available

- [x] Task 7: REST API routes (AC: 5, 6, 7, 10, 11)
  - [x] Create `packages/core/src/api/routes/agents.ts`
  - [x] `GET /api/agents` — list all named agents with task count enrichment + `isActive: boolean` field (cross-reference with `agentManager.getActiveTasks()` to check if any running task's `namedAgentId` matches)
  - [x] `GET /api/agents/:id` — full agent detail with suite info, active status, and recent task history
  - [x] `POST /api/agents` — create named agent
  - [x] `PATCH /api/agents/:id` — update agent fields
  - [x] `DELETE /api/agents/:id` — delete agent (400 if default)
  - [x] `GET /api/agents/:id/tasks` — paginated task history for this agent (query `tasks` table by `assigned_agent_id`)
  - [x] Enrich responses with resolved suite info (display names, capabilities) and active status
  - [x] Register in `packages/core/src/api/server.ts`

- [x] Task 8: Telegram topic threads per agent (AC: 8)
  - [x] In the notifications boot sequence, after named agents are loaded: ensure a Telegram topic thread exists per named agent in the Raven supergroup
  - [x] Use existing `telegram-bot.ts` `createForumTopic()` pattern (same as Tasks topic)
  - [x] Store topic thread ID mapping: agent name → thread ID (in-memory map, recreate on boot if missing)
  - [x] Route agent task notifications to the agent's dedicated thread instead of the generic "Tasks" thread
  - [x] Handle agent creation events — create new topic thread dynamically

- [x] Task 9: Dashboard — Agents page (AC: 5, 6, 7, 10, 11)
  - [x] Create `packages/web/src/app/agents/page.tsx` — new top-level page
  - [x] **"+ Create Agent" button** prominently at top of page
  - [x] **Agent cards**: name with **green dot indicator** when `isActive` is true (pulsing animation), description, suite badges (colored chips), task counts (completed/in-progress), "View History" link
  - [x] **Create/Edit agent form modal** with fields:
    - Name (text input, required, kebab-case validated)
    - Description (text input)
    - Instructions (textarea, with placeholder: "Additional system prompt instructions for this agent...")
    - Suite bindings (multi-select checkboxes populated from `/api/suites`, showing suite display name + description)
    - **"+ Create New Suite" link** below suite checkboxes → opens inline suite creation form (see Task 12)
    - Save / Cancel buttons
  - [x] **Edit**: click pencil icon on card → opens same modal pre-filled
  - [x] **Delete**: trash icon (disabled for default agent, confirmation dialog for others)
  - [x] **Task history panel**: click "View History" → slide-out showing chronological task list (from `/api/agents/:id/tasks`)
  - [x] **Active status polling**: poll `/api/agents` every 5s to update green dot status live
  - [x] Add "Agents" link to sidebar navigation
  - [x] Zustand store or extend app-store for agents state + active status
  - [x] API client helpers: `getAgents()`, `getAgent(id)`, `createAgent(input)`, `updateAgent(id, input)`, `deleteAgent(id)`, `getAgentTasks(id)`, `createSuite(input)`

- [x] Task 10: Seed default agents in `config/agents.json` (AC: 1, 3, 4)
  - [x] Create `config/agents.json` with sensible defaults:
    - Default agent: `{ name: "raven", description: "General-purpose assistant", instructions: "", suite_ids: [], is_default: true }` (empty suite_ids = all suites)
    - Example specialized agent: `{ name: "researcher", description: "Knowledge exploration and web research", instructions: "Focus on thorough research...", suite_ids: ["proactive-intelligence", "google-workspace"] }`
  - [x] On boot, `loadFromConfigFile()` seeds DB from this file if no agents exist yet

- [x] Task 11: Wire into boot sequence (AC: 1, 2, 8)
  - [x] In `packages/core/src/index.ts`: init named-agent-store, load from config, init agent-resolver, init config-committer
  - [x] Pass named-agent-store to API server deps
  - [x] Pass agent-resolver to orchestrator
  - [x] Ensure initialization order: DB → suite registry → named-agent-store → agent-resolver → orchestrator

- [x] Task 12: Lightweight suite creation API (AC: 10)
  - [x] Create `packages/core/src/suite-registry/suite-scaffolder.ts`
  - [x] `scaffoldSuite(input: { name, displayName, description, mcpServers? }): void` — generates minimal suite directory:
    - `suites/<name>/suite.ts` — exports `defineSuite({ name, displayName, description, capabilities })`
    - `suites/<name>/mcp.json` — MCP server config (if provided), otherwise empty `{ "mcpServers": {} }`
    - `suites/<name>/agents/` — empty directory for future agent definitions
  - [x] Add entry to `config/suites.json` with `{ "enabled": true }`
  - [x] Reload suite registry after scaffolding (call `suiteRegistry.loadSuite(name)` or restart registry)
  - [x] `POST /api/suites` API endpoint — accepts `{ name, displayName, description, mcpServers? }`, calls scaffolder, returns created suite info
  - [x] Zod validation: name must be kebab-case, displayName required, mcpServers optional object
  - [x] Git auto-commit the new suite directory + config change
  - [x] **Scope limit**: This creates the suite directory and config entry. It does NOT generate TypeScript agent definitions or complex MCP configs — that's story 10.5's conversational skill creation

## Dev Notes

### Architecture: Named Agent Layer

This story adds a **user-configurable agent persona layer** that sits ABOVE the existing suite/agent-definition system. The existing `defineAgent()` sub-agent definitions in suites remain unchanged — they are the "tools" that named agents can access.

| Concern | Suite Agent Definitions (existing) | Named Agents (new — this story) |
|---------|-----------------------------------|--------------------------------|
| Purpose | Define sub-agent capabilities per suite | Define user-facing agent personas |
| Defined in | `suites/*/agents/*.ts` via `defineAgent()` | `config/agents.json` + `named_agents` DB table |
| Contains | prompt, tools, MCP refs, model | name, description, instructions, suite bindings |
| Lifecycle | Static — loaded at boot from code | Dynamic — CRUD via API/chat, persisted to DB + config file |
| Scope | One suite's tools | Multiple suites' capabilities |
| Who uses | SDK spawns these as sub-processes | Orchestrator uses to filter available capabilities per task |

**The link between layers**: A `NamedAgent` binds to N suites via `suite_ids`. When the orchestrator spawns a task for a named agent, it calls `agentResolver.resolveAgentCapabilities(namedAgent)` which returns only the bound suites' MCP servers and sub-agent definitions. The named agent's `instructions` are prepended to the orchestrator system prompt for that session.

### Existing Code to Reuse — DO NOT Rebuild

| What | Where | Reuse How |
|------|-------|-----------|
| Suite registry with filtering | `packages/core/src/suite-registry/suite-registry.ts` | `collectMcpServers(suiteNames)` and `collectAgentDefinitions(suiteNames)` already accept optional suite name filters — use these directly |
| Suite agent definitions | `suites/*/agents/*.ts` | Keep as-is. Named agents bind to suites, not individual sub-agents |
| Suite config | `config/suites.json` | Named agent `suite_ids` reference suite names from this config |
| Task store | `packages/core/src/task-manager/task-store.ts` | Query `tasks` by `assigned_agent_id` for agent task history (AC 7) |
| Execution logger | `packages/core/src/agent-manager/execution-logger.ts` | Query `agent_tasks` by skill/agent for execution history |
| Orchestrator event handling | `packages/core/src/orchestrator/orchestrator.ts` | Extend `handleUserChat()` to resolve named agent capabilities |
| Telegram topic creation | `suites/notifications/` | Follow existing topic thread creation pattern (used for "Tasks" thread) |
| Config watcher | `packages/core/src/config-watcher/` | Emits `config:reloaded` — can use to hot-reload agent config |
| Git commit pattern | Used in pipeline engine | Follow same `child_process.execFile` pattern for auto-commits (NOT `exec`) |
| API patterns | `packages/core/src/api/routes/tasks.ts` | Follow same Zod validation, factory function, deps injection pattern |
| Dashboard patterns | `packages/web/src/app/tasks/page.tsx` | Follow same tabbed page, Zustand store, API client pattern |
| Sidebar nav | `packages/web/src/components/Sidebar.tsx` | Add "Agents" nav item |
| Suites API | `packages/core/src/api/routes/suites.ts` | `/api/suites` endpoint already returns suite names + capabilities for the dashboard multi-select |

### File Structure

New files:
```
migrations/016-named-agents.sql                          — Schema + seed data
packages/core/src/agent-registry/named-agent-store.ts    — CRUD + config file sync
packages/core/src/agent-registry/agent-resolver.ts       — Suite filtering for spawning
packages/core/src/agent-registry/config-committer.ts     — Git auto-commit on config changes
packages/core/src/suite-registry/suite-scaffolder.ts     — Lightweight suite directory generation
packages/core/src/api/routes/agents.ts                   — REST API for named agents + suite creation
config/agents.json                                       — Default agent configurations
packages/web/src/app/agents/page.tsx                     — Agents dashboard page
packages/web/src/components/agents/AgentCard.tsx          — Agent card with green dot active indicator
packages/web/src/components/agents/AgentFormModal.tsx     — Create/edit modal with suite multi-select + inline suite creation
packages/web/src/components/agents/AgentTaskHistory.tsx   — Task history slide-out panel
packages/web/src/components/agents/CreateSuiteForm.tsx   — Inline suite creation form (within agent modal)
```

Modified files:
```
packages/shared/src/types/agents.ts                      — Add NamedAgent type, Zod schemas
packages/shared/src/types/events.ts                      — Add agent:config:* event types
packages/shared/src/types/index.ts                       — Export new types
packages/shared/src/index.ts                             — Re-export
packages/core/src/orchestrator/orchestrator.ts           — Resolve named agent capabilities before spawning
packages/core/src/api/server.ts                          — Register agent + suite creation routes, add deps
packages/core/src/api/routes/suites.ts                   — Add POST /api/suites for suite scaffolding
packages/core/src/index.ts                               — Init agent-registry subsystem on boot
config/suites.json                                       — New suite entries added dynamically via scaffolder
packages/web/src/components/Sidebar.tsx                  — Add "Agents" nav link
packages/web/src/lib/api-client.ts                       — Add agent + suite creation API methods
```

### Database Conventions

- Table: `named_agents` (snake_case, plural, prefixed to avoid collision with existing `agent_tasks`)
- Columns: `snake_case` — `suite_ids`, `is_default`, `created_at`, `updated_at`
- PK: `id TEXT` via `crypto.randomUUID()`
- Timestamps: ISO 8601 TEXT
- JSON columns: `suite_ids TEXT` stored as JSON string `["task-management", "email"]`, parsed on read
- `name` must be UNIQUE (used as human-readable identifier)
- `is_default` — exactly ONE agent should have this set to 1

### API Conventions

- Agent endpoints: `/api/agents`, `/api/agents/:id`, `/api/agents/:id/tasks`
- Suite creation: `POST /api/suites` — scaffolds new suite directory + config entry
- Response enrichment: each agent includes resolved suite display names, task counts, and `isActive: boolean`
- `isActive` derivation: cross-reference agent ID with `agentManager.getActiveTasks()` — if any running/queued task has a matching `namedAgentId`, the agent is active
- Direct responses — no envelope. Errors: `{ error: string, code?: string }`
- Validate all input with Zod `safeParse()` at route handler level
- Task history pagination: `?limit=50&offset=0`

### Event Conventions

New event types:
```typescript
type: 'agent:config:created'
type: 'agent:config:updated'
type: 'agent:config:deleted'
```

Payloads carry the full `NamedAgent` object. Follow existing pattern from `task:created` etc.

### Orchestrator Changes — Critical Design

The orchestrator currently collects ALL suite capabilities for every user chat:

```typescript
// Current (orchestrator.ts handleUserChat):
const mcpServers = this.suiteRegistry.collectMcpServers();
const agentDefs = this.suiteRegistry.collectAgentDefinitions();
```

After this story, the flow becomes:

```typescript
// New flow:
const namedAgent = this.namedAgentStore.getAgentForProject(projectId)
  ?? this.namedAgentStore.getDefaultAgent();

const { mcpServers, agentDefinitions } = this.agentResolver.resolveAgentCapabilities(namedAgent);
// + prepend namedAgent.instructions to system prompt
```

**Backward compatibility**: If no named agent is assigned to a project and the default agent has empty `suite_ids`, ALL suites are included — identical to current behavior. Zero breakage.

**Project-agent assignment**: This story introduces agent selection but doesn't need a project→agent mapping table yet. For now, the orchestrator always uses the default agent unless explicitly overridden by a `namedAgentId` in the task request. Future stories can add project-level agent assignment.

### Config File Sync Strategy

`config/agents.json` serves as:
1. **Bootstrap source**: On first boot with empty DB, agents are seeded from this file
2. **Git-visible state**: After every CRUD operation, the DB state is written back to this file so changes appear in git history
3. **NOT a live config file**: After first boot, DB is source of truth. Config file is a snapshot for git.

This follows the same pattern as `config/pipelines/` where YAML files are git-committed for visibility.

### Dashboard Design

**Agents Page (`/agents`):**
- Header with title + "**+ Create Agent**" button (prominent, primary color)
- Grid of agent cards (similar to skills page layout)
- Each card:
  - **Agent name** (bold) with a **green pulsing dot** to the left when `isActive` is true (CSS: `width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: pulse 2s infinite`)
  - Description text
  - Suite badges (colored chips with suite displayName)
  - Task stats: completed count + in-progress count
  - Action icons: pencil (edit), trash (delete, disabled for default), clock (view history)
- **Create/Edit Agent Modal:**
  - Name (text input, required — validated as kebab-case on blur)
  - Description (text input)
  - Instructions (textarea, 4 rows, placeholder: "Additional system prompt instructions for this agent...")
  - **Suite Bindings** section:
    - Checkboxes for each available suite (from `/api/suites`) showing `displayName` and short description
    - Empty `suite_ids` = all suites (explained with helper text: "No suites selected = access to all suites")
    - **"+ Create New Suite"** link below checkbox list → expands inline `CreateSuiteForm` (name, display name, description fields + save). On save: calls `POST /api/suites`, then refreshes suite list and auto-checks the new suite
  - Save / Cancel buttons
- **Active status**: poll `/api/agents` every 5s → green dot updates live without full page refresh
- **Task History**: slide-out panel on "View History" click — chronological list of tasks from `/api/agents/:id/tasks`

**Sidebar addition:** Add "Agents" between "Skills" and "Schedules" (or similar logical position)

### Telegram Integration

Follow the pattern used for the "Tasks" topic thread:
- On boot: iterate named agents, ensure each has a forum topic in the supergroup
- Store mapping in-memory (not DB — topics are cheap to recreate)
- When `task:created` or `task:completed` fires with `assigned_agent_id`, route the notification to that agent's topic thread instead of the generic "Tasks" thread
- On `agent:config:created` event: create new topic thread immediately

### Testing Strategy

- **Integration test** for named-agent-store: create, update, delete, list, get, default agent, config file sync. Use temp SQLite DB.
- **Unit test** for agent-resolver: mock suite registry, verify filtering by suite_ids, verify empty suite_ids returns all, verify warning for missing suites.
- **API test** for `/api/agents` routes: CRUD, validation, prevent default deletion, task history query.
- **No real Claude SDK calls** — mock in all tests.
- Test files: `packages/core/src/__tests__/named-agent-store.test.ts`, `agent-resolver.test.ts`, `agents-api.test.ts`

### Anti-Patterns to Avoid

- **Do NOT modify existing `defineAgent()` definitions in suites** — named agents are a layer above, not a replacement
- **Do NOT merge named agents with suite agent definitions** — they serve different purposes
- **Do NOT import `better-sqlite3` directly** — use `context.db` / `DatabaseInterface`
- **Do NOT add MCPs to the orchestrator** — the MCP isolation rule still holds. Named agents just filter which suites' MCPs are passed to sub-agents
- **Do NOT create a complex project→agent mapping table** — keep it simple with direct agent ID on task requests for now
- **Do NOT modify the agent-manager or agent-session** — the named agent layer is resolved BEFORE the task reaches the agent manager
- **Do NOT break backward compatibility** — when no named agent is specified, behavior must be identical to current system
- **Do NOT use `child_process.exec()`** — use `execFile` to prevent shell injection (enforced by project hook)

### Previous Story (10.1) Learnings

- **Two-layer pattern works**: Story 10.1 added `tasks` table above `agent_tasks` — this story adds `named_agents` above suite agent definitions. Same layering principle.
- **Config file sync matters**: TickTick sync was non-functional because `globalThis.__raven_agent_manager__` wasn't set. Ensure all dependencies are wired in boot sequence.
- **Boot order is critical**: DB → suite registry → named-agent-store → agent-resolver → orchestrator. Don't initialize orchestrator before its deps.
- **Code review caught enrichment gaps**: Story 10.1 needed `projectName` added to active tasks API response. Here, ensure agent responses include resolved suite display names from the start.
- **Debounce patterns in React**: Use `useRef` for timer IDs, not closure variables (fixed in 10.1).
- **Factory functions only**: No classes, no singletons. Inject deps via function params.

### Git Intelligence

Recent commits show the codebase at epic 10, story 10.1 completion. Key patterns:
- Commit style: `feat: <description> (story X.Y)` for features
- Code review fixes committed separately
- Files follow kebab-case naming, one concern per file
- All new tables use TEXT primary keys with `crypto.randomUUID()`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10 — Story 10.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Agent Manager, Skill Registry]
- [Source: _bmad-output/planning-artifacts/prd.md#FR54-58 Skill Extensibility]
- [Source: packages/shared/src/types/agents.ts — existing AgentTask, AgentSession interfaces]
- [Source: packages/core/src/suite-registry/suite-registry.ts — collectMcpServers/collectAgentDefinitions with suite filtering]
- [Source: packages/core/src/orchestrator/orchestrator.ts — event handling, capability collection]
- [Source: packages/core/src/api/routes/suites.ts — existing suites API for dashboard multi-select]
- [Source: packages/core/src/task-manager/task-store.ts — queryTasks with assigned_agent_id filter]
- [Source: config/suites.json — enabled suite names for suite_ids validation]
- [Source: suites/notifications/ — Telegram topic thread creation pattern]
- [Source: _bmad-output/implementation-artifacts/10-1-advanced-task-management-system.md — previous story learnings]
- [Source: _bmad-output/project-context.md — coding conventions and rules]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- All 12 tasks implemented and tested (36 new tests, all passing)
- Named agent layer adds user-configurable agent personas above existing suite system
- Backward compatible — default agent with empty suite_ids returns all capabilities
- Orchestrator resolves named agent capabilities before spawning tasks
- Full CRUD API with Zod validation, task history, active status detection
- Dashboard page with cards, form modal, suite binding checkboxes, inline suite creation
- Telegram bot extended with dynamic forum topic creation per agent
- Git auto-commit via config-committer listening to agent:config:* events
- Suite scaffolder creates minimal suite directories with suite.ts + mcp.json
- No regressions in existing test suite (135 passing, pre-existing failures unchanged)

### Change Log

- 2026-03-22: Implemented all 12 tasks for story 10.2 — agent management & skill binding
- 2026-03-22: Code review #1 fixes — 5 issues resolved:
  - C1: Added `namedAgentId` to `AgentTaskRequestEvent` payload and orchestrator emission (isActive detection)
  - C2: Fixed task count queries — removed `limit: 1` that capped counts at 0 or 1
  - H1: Wired `ensureAllAgentTopics()` call on Telegram bot boot + `agent:config:created` listener
  - H2: Task notifications now route to agent-specific Telegram topics when `assignedAgentId` is set
  - M1: Added system prompt instruction for chat-based agent config management (AC 9)
- 2026-03-22: Code review #2 fixes — 15 issues resolved:
  - C1: Fixed template injection in suite-scaffolder — use JSON.stringify() for generated source
  - C2: Propagated `namedAgentId` through AgentTask → ActiveTaskInfo — isActive detection now works
  - C3: Wrapped getDefaultAgent() in try/catch in orchestrator — falls back to all suites on error
  - H1: Fixed gitAutoCommit error swallowing in suite-scaffolder — now logs warnings
  - H2: PATCH /api/agents/:id now returns 404 only for "not found", 400 for other errors
  - H3: Added Zod validation to loadFromConfigFile — rejects invalid agents.json entries
  - H4: Guarded JSON.parse(suite_ids) with safe fallback to [] on corrupted data
  - H5: Added error state to agent store — API failures now surface in form modal
  - H6: Reset selectedAgentTasks before fetch in showHistory — prevents stale data display
  - H7: Clear agentTopicMap on Telegram bot stop() — prevents stale state across restarts
  - M1: Green dot uses animate-pulse Tailwind class instead of inline animation
  - M3: Default agent name protected from rename via PATCH
  - M4: Raw SQLite UNIQUE error normalized to "Agent name already exists"
  - M5: Renamed getAgentTasks2 → getNamedAgentTasks
  - Fix: useRef<> type errors in agents page and TaskFilters (React 19 compat)
- 2026-03-22: Code review #3 fixes — 4 issues resolved:
  - H1: Refactored loadFromConfigFile — extracted parseConfigFile() and seedAgentsFromConfig() to fix complexity/line-count violations
  - H2: Replaced magic number 201 in suites.ts with HTTP_STATUS.OK_CREATED constant
  - M1: Removed unused eslint-disable directive for complexity in agents.ts route registration
  - M2: ConfigEntrySchema now accepts is_default as boolean or number (z.union) for robustness

### File List

New files:
- migrations/016-named-agents.sql
- packages/core/src/agent-registry/named-agent-store.ts
- packages/core/src/agent-registry/agent-resolver.ts
- packages/core/src/agent-registry/config-committer.ts
- packages/core/src/api/routes/agents.ts
- packages/core/src/suite-registry/suite-scaffolder.ts
- packages/core/src/__tests__/named-agent-store.test.ts
- packages/core/src/__tests__/agent-resolver.test.ts
- packages/core/src/__tests__/agents-api.test.ts
- config/agents.json
- packages/web/src/app/agents/page.tsx
- packages/web/src/components/agents/AgentCard.tsx
- packages/web/src/components/agents/AgentFormModal.tsx
- packages/web/src/components/agents/AgentTaskHistory.tsx
- packages/web/src/components/agents/CreateSuiteForm.tsx
- packages/web/src/stores/agent-store.ts

Modified files:
- packages/shared/src/types/agents.ts — added namedAgentId to AgentTask
- packages/shared/src/types/events.ts — added `namedAgentId` to `AgentTaskRequestEvent` payload
- packages/core/src/orchestrator/orchestrator.ts — namedAgentId tracking, agent config system prompt, try/catch for getDefaultAgent
- packages/core/src/agent-manager/agent-manager.ts — propagate namedAgentId through enqueue/getActiveTasks
- packages/core/src/api/server.ts
- packages/core/src/api/routes/agents.ts — fixed isActive detection, error handling normalization
- packages/core/src/api/routes/suites.ts
- packages/core/src/api/routes/agent-tasks.ts — formatting only
- packages/core/src/index.ts — agent topic routing for task notifications
- packages/core/src/task-manager/task-lifecycle.ts — formatting only
- packages/core/src/__tests__/session-enqueue.test.ts — formatting only
- packages/web/src/app/agents/page.tsx — useRef type fix
- packages/web/src/components/layout/Sidebar.tsx
- packages/web/src/components/agents/AgentCard.tsx — animate-pulse class
- packages/web/src/components/agents/AgentFormModal.tsx — error display
- packages/web/src/components/tasks/TaskFilters.tsx — useRef type fix
- packages/web/src/lib/api-client.ts — renamed getAgentTasks2 → getNamedAgentTasks, added namedAgentId to ActiveTaskInfo
- packages/web/src/stores/agent-store.ts — error state, stale data fix
- suites/notifications/services/telegram-bot.ts — agent topic bootstrap, agentTopicMap.clear on stop
- _bmad-output/implementation-artifacts/sprint-status.yaml
- _bmad-output/implementation-artifacts/10-2-agent-management-and-skill-binding.md
