---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-03-03'
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/project-context.md'
  - 'docs/GOOGLE_OAUTH_SETUP.md'
workflowType: 'architecture'
project_name: 'personal-assistant'
user_name: 'User'
date: '2026-03-03'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**

67 requirements across 11 domains, phased from MVP through Vision:

| Category | Count | Phase | Architectural Impact |
|---|---|---|---|
| Trust & Autonomy (FR1-10) | 10 | MVP | New middleware layer in agent spawner, permission config system, audit log subsystem |
| Pipeline Automation (FR11-18) | 8 | MVP-Vision | New pipeline engine, YAML parser, cron+event triggers, execution tracker, git auto-commit |
| Telegram Interaction (FR19-26) | 8 | MVP-Growth | Extend existing Telegram skill: topic threads, inline keyboards, voice via Gemini, media routing |
| Web Dashboard (FR27-33) | 7 | Growth-Vision | New dashboard views: activity timeline, Kanban board, pipeline monitor, knowledge explorer |
| Task Management (FR34-37) | 4 | MVP | Extend TickTick skill with autonomous management, stale task detection |
| Email Processing (FR38-41) | 4 | MVP | Extend Gmail skill with auto-triage rules, action item extraction, reply composition |
| Knowledge Management (FR42-48) | 7 | Growth-Vision | Entirely new subsystem: bubble storage, ingestion pipeline, clustering, knowledge graph |
| Proactive Intelligence (FR49-53) | 5 | Growth | New proactive engine: pattern analysis, urgency classification, throttling (Friend Protocol) |
| Skill Extensibility (FR54-58) | 5 | MVP-Vision | Extend existing skill registry with permission declarations, scaffolding |
| Expanding Integrations (FR59-63) | 5 | Growth-Vision | New skills: Google Drive, finance, calendar |
| System Observability (FR64-67) | 4 | MVP-Growth | Extend existing health/logging with execution metrics, self-monitoring |

**Non-Functional Requirements:**

30 NFRs that constrain architectural choices:

- **Security (NFR1-7):** Credential isolation per MCP, append-only audit trail, code-level permission enforcement, no sensitive data in logs
- **Reliability (NFR8-14):** Fault isolation (skill/agent failures don't crash process), retry with backoff, WAL-mode SQLite, Docker restart policy
- **Performance (NFR15-21):** 200ms API response, 5s agent spawn, 3 concurrent agent cap, non-blocking I/O, 50ms SQLite queries
- **Integration (NFR22-26):** Graceful degradation for all external APIs, MCP startup failure tolerance, Telegram auto-reconnect, non-blocking git ops
- **Operational (NFR27-30):** Single docker-compose deployment, hot-reload config, structured JSON logging, single-file DB backup

**Scale & Complexity:**

- Primary domain: Full-stack AI-orchestrated platform (API + Bot + Dashboard + Plugin system)
- Complexity level: Medium-High
- Estimated architectural components: ~12 major subsystems (orchestrator, agent spawner, event bus, skill registry, permission engine, pipeline engine, scheduler, API server, WebSocket server, Telegram bot, web dashboard, database layer)

### Technical Constraints & Dependencies

- **Claude Code SDK** — sole execution substrate; all intelligence delegated, no fallback reasoning engine
- **SQLite (single file)** — sufficient for single-user but constrains concurrent write throughput; WAL mode mitigates
- **MCP isolation** — hard architectural boundary; every new capability must be expressed as skill sub-agents
- **Node.js 22 ESM** — runtime locked; TypeScript strict mode with `.ts` import extensions
- **Existing codebase** — brownfield; architecture must extend, not replace, working core
- **Single-user assumption** — baked into every layer; no auth, no tenancy, no role-based access

### Cross-Cutting Concerns Identified

- **Permission Enforcement** — touches every skill action, every agent spawn, every pipeline step; must be middleware, not per-component logic
- **Audit Logging** — every gated action across all skills must be recorded with timestamps, outcomes, and tier; append-only
- **Event-Driven Coordination** — the event bus is the central nervous system connecting skills, pipelines, notifications, and dashboard updates
- **Error Handling & Graceful Degradation** — every external integration (TickTick, Gmail, Gemini, MCP servers) must fail independently without system impact
- **Context Injection** — orchestrator must assemble and inject relevant context (knowledge, project state, conversation history) into every sub-agent spawn

## Starter Template Evaluation

### Primary Technology Domain

Full-stack AI-orchestrated platform (API + Bot + Dashboard + Plugin system) — brownfield project with established, operational codebase.

### Starter Options Considered

Not applicable. This is a brownfield project with a fully operational technology stack. All foundational technology decisions have been made and validated through implementation.

### Selected Foundation: Existing Codebase

**Rationale:** The working codebase already establishes all architectural foundations. Evaluating new starters would be counterproductive — the goal is to extend what exists, not replace it.

**Established Technology Stack:**

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js (ESM strict) | 22+ |
| Language | TypeScript (strict mode) | ^5.7 |
| AI Engine | @anthropic-ai/claude-code | ^1.0 |
| HTTP Server | Fastify + @fastify/websocket | ^5.2 / ^11.0 |
| Database | better-sqlite3 (WAL mode) | ^11.7 |
| Validation | Zod | ^3.23 |
| Logging | Pino + pino-pretty | ^9.6 / ^13.0 |
| Scheduling | Croner | ^9.0 |
| Frontend | Next.js / React / Zustand | ^15.1 / ^19.0 / ^5.0 |
| Styling | Tailwind CSS | ^4.0 |
| Testing | Vitest | ^4.0 |
| Linting | ESLint 9 (flat config) + Prettier | — |
| Monorepo | npm workspaces | — |
| Deployment | Docker Compose | — |

**Architectural Patterns Established:**

- **MCP Isolation:** Orchestrator delegates all tool use to skill sub-agents; zero MCPs on the main agent
- **Skill Plugin System:** `RavenSkill` interface with `BaseSkill` abstract class; independent npm workspaces
- **Event-Driven:** Async fire-and-forget event bus for cross-component coordination
- **Sub-Agent Spawning:** `query()` from Claude SDK with scoped prompts, tools, and MCP bindings
- **Code Organization:** kebab-case files, one concern per file, max 300 lines, no classes (except skills)
- **Build Order:** @raven/shared → @raven/core → skills → @raven/web

**Note:** No project initialization story needed. Architecture decisions in this document focus on extending the existing foundation for MVP features.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Permission gate enforcement point (agent session level)
- Audit log storage (SQLite, append-only)
- Pipeline config storage (YAML files + DB execution state)
- Schema migration strategy (versioned SQL scripts, transaction-wrapped)

**Important Decisions (Shape Architecture):**
- Red-tier approval flow (dashboard-first)
- Agent output streaming (SSE)
- Event type system (Zod-validated payloads)
- Pipeline concurrency (global semaphore)
- Gemini integration (MCP server)

**Deferred Decisions (Post-MVP):**
- Per-pipeline concurrency limits (Growth)
- Nested page layout reorganization (Growth)
- Knowledge bubble schema design (Growth)
- Knowledge graph storage engine (Vision)

### Data Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Permission config storage | JSON file only (`config/permissions.json`) | Simple, git-tracked, human-editable. Reloaded on change. No DB involvement. Aligns with PRD specification. |
| Audit log storage | SQLite table, append-only | Queryable for dashboard, single-file backup. Append-only enforced at application level (no UPDATE/DELETE on audit table). Single-user threat model doesn't require filesystem-level immutability. |
| Pipeline config storage | YAML files on disk + DB execution metadata | YAML files are the source of truth for pipeline definitions (git-tracked, declarative). DB stores execution history, last run status, and next scheduled run. Clean separation of config from runtime state. |
| Schema migrations | Versioned SQL scripts, transaction-wrapped | `migrations/001-*.sql`, `migrations/002-*.sql` etc. Each migration runs in its own transaction — failed migration rolls back cleanly. Applied versions tracked in `_migrations` table. Predictable, reviewable, git-tracked. |

### Authentication & Security

| Decision | Choice | Rationale |
|---|---|---|
| Permission gate enforcement | In `agent-session.ts` before `query()` | Single narrowest choke point. Every sub-agent invocation passes through this gate. Impossible to bypass regardless of orchestrator routing. One place to audit. Orchestrator routes intent; gate enforces trust. |
| Red-tier approval flow | Dashboard-first with Telegram notification | Pending approvals shown on web dashboard with rich review UI. Telegram receives a notification alerting the user. Keeps approval experience reviewable and detailed. |
| MCP credential isolation | Environment variables | Each MCP server reads its own env vars. Skills declare which env vars their MCPs need. Standard, simple, no custom injection mechanism. |

### API & Communication Patterns

| Decision | Choice | Rationale |
|---|---|---|
| Agent output streaming | Server-Sent Events (SSE) | Dedicated `/api/agent-tasks/:id/stream` endpoint. Native `EventSource` on client. Clean separation: WebSocket for bidirectional chat, SSE for server-push streams. Auto-reconnect built in. |
| New event types | Zod-validated typed payloads | Extends existing `RavenEvent` / `RavenEventType` in `@raven/shared`. Each event type gets a Zod schema for its payload. Type-safe emit and subscribe. Compile-time mismatch detection. |
| Pipeline CRUD API | File-passthrough | API reads/writes YAML files directly. `GET /api/pipelines` lists files, `PUT /api/pipelines/:name` writes YAML, `POST /api/pipelines/:name/trigger` executes. Git auto-commits on write. DB stores execution state only. |

### Frontend Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Data refresh strategy | Zustand + custom `usePolling` hook | Shared `usePolling(url, interval)` hook writes to Zustand stores. DRY without adding a data-fetching dependency. Sufficient for single-user dashboard with a handful of endpoints. |
| SSE consumption | Native `EventSource` API | Browser-native, auto-reconnect, zero dependencies. Custom React hook wraps `EventSource` for agent task streaming. |
| Page architecture | Flat page structure | Each view is top-level: `/pipelines`, `/permissions`, `/activity`. Simple routing, self-contained pages. Reorganize into nested layouts in Growth phase when view count justifies it. |

### Infrastructure & Deployment

| Decision | Choice | Rationale |
|---|---|---|
| Git auto-commit | `execFile` wrapper (no shell) | Async utility using `execFile` (not `exec`) for `git add` + `git commit`. Fire-and-forget, failure logged but doesn't block config changes (NFR25). No shell injection risk, no git library dependency. |
| Pipeline concurrency | Global semaphore in agent manager | Concurrency counter at the agent manager level. Pipeline steps that exceed the max (default 3) queue until a slot opens. Single enforcement point since all agent spawns flow through agent manager. |
| Gemini voice integration | Dedicated MCP server | Gemini transcription exposed as an MCP server. Sub-agents use it through the standard MCP tool interface. Consistent with the project's MCP-native integration philosophy — all external services expressed as MCPs. |
| Config hot-reload | File watcher + API trigger | `fs.watch` on `config/` directory for manual file edits. API endpoint triggers reload after programmatic changes. Both mechanisms ensure config changes take effect without restart. |

### Decision Impact Analysis

**Implementation Sequence:**
1. Schema migration system (foundation for all new tables)
2. Audit log table + append-only enforcement
3. Permission gate middleware in agent session
4. Permission config loader (JSON file watcher)
5. Pipeline YAML loader + DB execution tables
6. Pipeline CRUD API + git auto-commit
7. SSE streaming endpoint
8. Gemini MCP server
9. New event types with Zod payloads
10. Frontend: polling hook, EventSource hook, new pages

**Cross-Component Dependencies:**
- Permission gates depend on: migration system (audit table), config loader (permissions.json), event types (permission events)
- Pipeline engine depends on: migration system (execution tables), config loader (YAML watcher), git auto-commit, concurrency semaphore, event types (pipeline events)
- Telegram enhancements depend on: Gemini MCP server, permission gates (for approval notifications), pipeline engine (for triggers)
- Dashboard depends on: SSE endpoint, polling hook, all new API endpoints

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

12 areas where AI agents could make different implementation choices. Patterns below lock these down.

### Naming Patterns

**Database Naming:**
- Tables: `snake_case`, plural — `audit_log`, `pipeline_runs`, `_migrations`
- Columns: `snake_case` — `created_at`, `skill_name`, `permission_tier`
- Primary keys: `id TEXT` (crypto.randomUUID())
- Foreign keys: `<table_singular>_id` — `session_id`, `pipeline_id`
- Indexes: `idx_<table>_<column>` — `idx_audit_log_timestamp`

**API Naming:**
- Endpoints: plural nouns, kebab-case — `/api/pipelines`, `/api/audit-logs`, `/api/agent-tasks`
- Route params: `:name` or `:id` — `/api/pipelines/:name/trigger`
- Query params: `camelCase` — `?skillName=gmail&limit=50`
- Direct responses, no envelope — success returns data, errors return `{error: string, code?: string}`

**Date/Time:**
- ISO 8601 strings everywhere — API, DB, events, logs: `"2026-03-03T14:30:00.000Z"`
- SQLite stores as TEXT, sorts correctly, human-debuggable

### Structure Patterns

**Permission Action Declaration:**
```typescript
// Every skill's getActions() returns this shape
{
  name: 'ticktick:create-task',      // skill:action (kebab-case, colon-separated)
  description: 'Create a new task in TickTick',
  defaultTier: 'green',              // green | yellow | red
  reversible: true,
}
```
- Action names: `<skill-name>:<action-name>` — matches event naming convention
- Undeclared actions default to `red` tier (FR10)
- `config/permissions.json` stores tier overrides keyed by action name

**Pipeline YAML Schema (Graph-Based):**
```yaml
name: morning-briefing
description: Compile and send daily morning briefing
version: 1                          # schema version for future migrations

trigger:
  type: cron                        # cron | event | manual | webhook
  schedule: "0 6 * * *"
  # event: "email:new"
  # filter: { sender: "@important.com" }

settings:
  retry:
    maxAttempts: 3
    backoffMs: 5000
  timeout: 600000
  onError: stop                     # stop | continue | goto:<node-id>

nodes:
  fetch-emails:                     # unique node ID (kebab-case)
    skill: gmail
    action: get-unread-summary
    params: {}

  fetch-tasks:
    skill: ticktick
    action: get-overdue-tasks
    params: {}

  check-urgency:
    type: condition                 # condition | switch | merge | delay | code
    expression: "{{ fetch-emails.output.urgentCount > 0 }}"

  compile-briefing:
    skill: digest
    action: compile-briefing
    params:
      include: [email-summary, overdue-tasks]

  send-message:
    skill: telegram
    action: send-message
    params:
      topic: general

connections:
  - from: fetch-emails
    to: check-urgency
  - from: check-urgency
    to: compile-briefing
    condition: "false"
  - from: compile-briefing
    to: send-message

enabled: true
```

**Pipeline schema conventions:**
- Nodes are a map keyed by unique kebab-case ID — order-independent
- Connections are explicit directed edges with optional metadata (`condition`, `errorPath`, `label`)
- Parallel execution is implicit — nodes with no dependency execute concurrently
- Data passing via `{{ node-id.output.field }}` template expressions
- Special node types: `condition`, `switch`, `merge`, `delay`, `code`
- Nodes without inbound connections are entry points (post-trigger)
- Engine validates DAG at load time — cycles are rejected
- Validated with Zod schema at load time

**Audit Log Schema:**
```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  permission_tier TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT,
  session_id TEXT,
  pipeline_name TEXT
);
```
- Insert-only — no UPDATE or DELETE exposed at the application layer
- `outcome` values: `executed`, `approved`, `denied`, `queued`
- `details` is a JSON string blob for action-specific context
- `permission_tier` records the tier at time of execution (not current config)

### Format Patterns

**API Error Responses:**
```json
{ "error": "Pipeline not found", "code": "NOT_FOUND" }
```
- `error`: human-readable message
- `code`: optional machine-readable code (UPPER_SNAKE_CASE)
- HTTP status codes used conventionally: 200, 201, 400, 404, 409, 500

**Event Payloads (Zod-validated):**
```typescript
// New event types follow this pattern in @raven/shared
{
  type: 'permission:denied',        // colon-separated, lowercase
  payload: {                         // Zod schema per event type
    actionName: 'gmail:send-email',
    tier: 'red',
    reason: 'Requires explicit approval',
    sessionId: '...',
  },
  timestamp: '2026-03-03T14:30:00.000Z',
}
```

**New event types for MVP:**
- `permission:check`, `permission:approved`, `permission:denied`, `permission:queued`
- `pipeline:started`, `pipeline:step:complete`, `pipeline:step:failed`, `pipeline:complete`, `pipeline:failed`
- `config:reloaded`

### Process Patterns

**Error Handling:**
- External API failures: catch, log with Pino, emit failure event, degrade gracefully — never crash
- Permission denials: return structured denial to orchestrator, audit log entry, no retry
- Pipeline step failures: follow pipeline's `onError` setting (stop/continue/goto), log, emit `pipeline:step:failed`
- DB errors: log, return error to caller — never swallow

**Config Reload Flow:**
1. File watcher detects change OR API endpoint triggers reload
2. Affected config re-parsed and Zod-validated
3. If valid: swap in-memory config, emit `config:reloaded` event
4. If invalid: log error, keep previous config, do not emit event

**SSE Stream Format:**
```
event: agent-output
data: {"chunk": "text content", "taskId": "..."}

event: agent-complete
data: {"taskId": "...", "status": "success"}

event: agent-error
data: {"taskId": "...", "error": "..."}
```
- Standard SSE format: `event:` + `data:` lines
- JSON payloads on data lines
- Three event types: `agent-output`, `agent-complete`, `agent-error`

### Enforcement Guidelines

**All AI Agents MUST:**
- Follow snake_case for all database identifiers
- Use the `skill:action` naming pattern for all permission action names
- Return direct responses (no envelope) from API endpoints
- Use ISO 8601 for all timestamps in all layers
- Validate pipeline YAML with Zod schema before accepting
- Write audit log entries as INSERT only — never UPDATE or DELETE
- Emit typed events with Zod-validated payloads

**Pattern Verification:**
- ESLint rules enforce code-level conventions (already configured)
- Zod schemas enforce data-level conventions at runtime
- Pipeline YAML validated on load — invalid configs rejected with clear error message
- `npm run check` catches type mismatches from event payload schemas

## Project Structure & Boundaries

### Complete Project Directory Structure

```
personal-assistant/
├── package.json                          # workspaces root
├── package-lock.json
├── tsconfig.base.json                    # shared TS config
├── vitest.config.ts                      # root test config (test.projects)
├── eslint.config.ts                      # ESLint 9 flat config
├── .prettierrc
├── .env                                  # credentials (gitignored)
├── .env.example
├── docker-compose.yml
├── Dockerfile.core
├── Dockerfile.web
├── CLAUDE.md
├── ARCHITECTURE.md
│
├── config/
│   ├── skills.json                       # skill enable/disable
│   ├── schedules.json                    # cron schedule definitions
│   ├── permissions.json                  # NEW: permission tier overrides
│   └── pipelines/                        # NEW: pipeline YAML definitions
│       ├── morning-briefing.yaml
│       └── stale-task-nudge.yaml
│
├── migrations/                           # NEW: versioned SQL scripts
│   ├── 001-initial-schema.sql            # existing tables codified
│   ├── 002-audit-log.sql
│   └── 003-pipeline-runs.sql
│
├── data/
│   ├── raven.db                          # SQLite database
│   └── sessions/                         # agent session transcripts
│
├── scripts/
│   ├── google-oauth.mjs
│   └── ticktick-auth.mjs
│
├── packages/
│   ├── shared/                           # @raven/shared
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # barrel export
│   │       ├── types/
│   │       │   ├── index.ts
│   │       │   ├── agents.ts
│   │       │   ├── api.ts
│   │       │   ├── events.ts             # EXTEND: new event types + Zod payloads
│   │       │   ├── projects.ts
│   │       │   ├── skills.ts             # EXTEND: SkillAction type, permission tiers
│   │       │   ├── permissions.ts        # NEW: PermissionTier, PermissionConfig, AuditEntry
│   │       │   └── pipelines.ts          # NEW: PipelineConfig, PipelineNode, PipelineRun
│   │       ├── utils/
│   │       │   ├── id.ts
│   │       │   ├── logger.ts
│   │       │   └── git-commit.ts         # NEW: async execFile git wrapper
│   │       └── __tests__/
│   │           └── utils.test.ts
│   │
│   ├── core/                             # @raven/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts                  # boot sequence
│   │       ├── config.ts
│   │       ├── agent-manager/
│   │       │   ├── agent-manager.ts      # EXTEND: concurrency semaphore
│   │       │   ├── agent-session.ts      # EXTEND: permission gate middleware
│   │       │   └── prompt-builder.ts
│   │       ├── api/
│   │       │   ├── server.ts
│   │       │   ├── ws/
│   │       │   │   └── handler.ts
│   │       │   ├── sse/
│   │       │   │   └── stream.ts         # NEW: SSE streaming handler
│   │       │   └── routes/
│   │       │       ├── health.ts
│   │       │       ├── chat.ts
│   │       │       ├── events.ts
│   │       │       ├── projects.ts
│   │       │       ├── sessions.ts
│   │       │       ├── skills.ts
│   │       │       ├── schedules.ts
│   │       │       ├── pipelines.ts      # NEW: pipeline CRUD + trigger
│   │       │       ├── permissions.ts    # NEW: permission config + audit log
│   │       │       └── config-reload.ts  # NEW: reload trigger endpoint
│   │       ├── db/
│   │       │   ├── database.ts           # EXTEND: migration runner
│   │       │   └── migrations.ts         # NEW: migration loader + executor
│   │       ├── event-bus/
│   │       │   └── event-bus.ts
│   │       ├── mcp-manager/
│   │       │   └── mcp-manager.ts
│   │       ├── orchestrator/
│   │       │   ├── orchestrator.ts
│   │       │   └── task-queue.ts
│   │       ├── permission-engine/        # NEW: entire subsystem
│   │       │   ├── permission-engine.ts  # config loader, tier resolver, file watcher
│   │       │   └── audit-log.ts          # append-only audit writer + query
│   │       ├── pipeline-engine/          # NEW: entire subsystem
│   │       │   ├── pipeline-loader.ts    # YAML parser, Zod validation, file watcher
│   │       │   ├── pipeline-executor.ts  # DAG resolver, node runner, concurrency
│   │       │   └── pipeline-store.ts     # DB execution history read/write
│   │       ├── config-watcher/           # NEW: fs.watch on config/
│   │       │   └── config-watcher.ts
│   │       ├── scheduler/
│   │       │   └── scheduler.ts          # EXTEND: pipeline cron triggers
│   │       ├── session-manager/
│   │       │   └── session-manager.ts
│   │       ├── skill-registry/
│   │       │   ├── base-skill.ts         # EXTEND: getActions() default
│   │       │   └── skill-registry.ts     # EXTEND: action registration
│   │       └── __tests__/
│   │           ├── agent-manager.test.ts
│   │           ├── api.test.ts
│   │           ├── config.test.ts
│   │           ├── database.test.ts
│   │           ├── e2e.test.ts
│   │           ├── event-bus.test.ts
│   │           ├── orchestrator.test.ts
│   │           ├── prompt-builder.test.ts
│   │           ├── scheduler.test.ts
│   │           ├── skill-registry.test.ts
│   │           ├── permission-engine.test.ts  # NEW
│   │           ├── pipeline-engine.test.ts    # NEW
│   │           └── migrations.test.ts         # NEW
│   │
│   ├── skills/
│   │   ├── skill-ticktick/               # EXTEND: getActions(), autonomous management
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── src/
│   │   │       └── index.ts
│   │   ├── skill-gmail/                  # EXTEND: getActions(), auto-triage rules
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── src/
│   │   │       ├── index.ts
│   │   │       └── imap-watcher.ts
│   │   ├── skill-telegram/               # EXTEND: getActions(), topics, inline keyboards
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── src/
│   │   │       ├── index.ts
│   │   │       └── bot.ts
│   │   ├── skill-digest/                 # EXTEND: getActions()
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── src/
│   │   │       └── index.ts
│   │   └── skill-gemini/                 # NEW: Gemini MCP for voice transcription
│   │       ├── package.json
│   │       ├── tsconfig.json
│   │       └── src/
│   │           └── index.ts
│   │
│   └── web/                              # @raven/web
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.ts
│       └── src/
│           ├── app/
│           │   ├── globals.css
│           │   ├── layout.tsx
│           │   ├── page.tsx              # home / chat
│           │   ├── activity/page.tsx
│           │   ├── projects/page.tsx
│           │   ├── projects/[id]/page.tsx
│           │   ├── schedules/page.tsx
│           │   ├── settings/page.tsx
│           │   ├── skills/page.tsx
│           │   ├── pipelines/page.tsx    # NEW: pipeline management
│           │   └── permissions/page.tsx  # NEW: permission config + audit
│           ├── components/
│           │   ├── chat/
│           │   │   └── ChatPanel.tsx
│           │   ├── dashboard/
│           │   │   ├── ActivityFeed.tsx
│           │   │   └── StatusCards.tsx
│           │   ├── layout/
│           │   │   └── Sidebar.tsx
│           │   ├── pipelines/            # NEW
│           │   │   ├── PipelineList.tsx
│           │   │   └── PipelineStatus.tsx
│           │   └── permissions/          # NEW
│           │       ├── PermissionTable.tsx
│           │       └── AuditLog.tsx
│           ├── hooks/
│           │   ├── useChat.ts
│           │   ├── useWebSocket.ts
│           │   ├── usePolling.ts         # NEW: custom polling hook
│           │   └── useSSE.ts             # NEW: EventSource hook
│           ├── lib/
│           │   ├── api-client.ts
│           │   └── ws-client.ts
│           └── stores/
│               └── app-store.ts
```

### Architectural Boundaries

**API Boundaries:**
- All external access through Fastify REST (`/api/*`) or WebSocket (`/ws`)
- SSE streaming at `/api/agent-tasks/:id/stream` — read-only, server-push
- Pipeline CRUD: `/api/pipelines/*` — reads/writes YAML files on disk
- Permission config: `/api/permissions/*` — reads/writes `config/permissions.json`
- Audit log: `/api/audit-logs` — read-only query interface
- Config reload: `/api/config/reload` — triggers in-memory refresh

**Component Boundaries (Core):**
- `permission-engine/` — owns permission resolution, audit log writes. Consumed by `agent-session.ts` as middleware.
- `pipeline-engine/` — owns YAML loading, DAG execution, execution history. Triggered by `scheduler/` (cron) and `event-bus/` (events).
- `config-watcher/` — owns `fs.watch` on `config/` directory. Emits `config:reloaded` events. Consumed by permission engine, pipeline loader, skill registry.
- `agent-manager/` — owns concurrency semaphore and sub-agent lifecycle. Permission gate lives here.
- `orchestrator/` — routes intent to skills. Has zero knowledge of permission tiers or pipeline execution.

**Skill Boundaries:**
- Each skill is an isolated npm workspace — no cross-skill imports
- Skills communicate only through event bus or orchestrator-composed sub-agent chains
- New `skill-gemini/` follows exact same pattern as existing skills
- All skills extend with `getActions()` for permission declarations

**Data Boundaries:**
- `config/` directory — human-editable, git-tracked configuration files (JSON, YAML)
- `data/raven.db` — runtime state (sessions, audit log, pipeline execution history)
- `migrations/` — SQL scripts applied to DB on startup
- `data/sessions/` — agent session transcript storage

### Requirements to Structure Mapping

| FR Category | Primary Location | Files Affected |
|---|---|---|
| Trust & Autonomy (FR1-10) | `core/permission-engine/`, `core/agent-manager/` | permission-engine.ts, audit-log.ts, agent-session.ts, permissions.ts (types) |
| Pipeline Automation (FR11-18) | `core/pipeline-engine/`, `config/pipelines/` | pipeline-loader.ts, pipeline-executor.ts, pipeline-store.ts, pipelines.ts (types) |
| Telegram Interaction (FR19-26) | `skills/skill-telegram/`, `skills/skill-gemini/` | bot.ts, index.ts (telegram), index.ts (gemini) |
| Web Dashboard (FR27-33) | `web/src/app/`, `web/src/components/` | pipelines/page.tsx, permissions/page.tsx, new components |
| Task Management (FR34-37) | `skills/skill-ticktick/` | index.ts (extend with getActions, autonomous logic) |
| Email Processing (FR38-41) | `skills/skill-gmail/` | index.ts (extend with getActions, triage rules) |
| Skill Extensibility (FR54-58) | `core/skill-registry/`, `shared/types/skills.ts` | base-skill.ts, skill-registry.ts, skills.ts |
| System Observability (FR64-67) | `core/api/routes/`, `core/db/` | health.ts (extend), migrations.ts |

**Cross-Cutting Concerns Mapping:**
- Permission enforcement: `core/permission-engine/` + `core/agent-manager/agent-session.ts`
- Audit logging: `core/permission-engine/audit-log.ts` + `core/api/routes/permissions.ts`
- Config hot-reload: `core/config-watcher/` + event bus `config:reloaded`
- Event types: `shared/src/types/events.ts` (single source of truth for all event Zod schemas)

### Integration Points

**Internal Communication:**
- Orchestrator → Agent Manager: task dispatch via function call
- Agent Manager → Permission Engine: tier check before `query()`
- Scheduler → Pipeline Engine: cron-triggered pipeline execution
- Event Bus → Pipeline Engine: event-triggered pipeline execution
- Config Watcher → Permission Engine / Pipeline Loader / Skill Registry: `config:reloaded` event
- Pipeline Executor → Agent Manager: sub-agent spawning for each skill node

**External Integrations:**
- TickTick API → via MCP server (declared by skill-ticktick)
- Gmail API → via MCP server (declared by skill-gmail)
- Gmail IMAP → direct connection in imap-watcher.ts
- Telegram Bot API → via grammy in skill-telegram
- Google Gemini API → via MCP server (declared by skill-gemini)
- Git → via execFile wrapper for auto-commits

**Data Flow (Pipeline Execution):**
```
Cron/Event trigger
  → Pipeline Engine loads YAML, resolves DAG
  → For each ready node: Agent Manager spawns sub-agent (permission gate check)
  → Sub-agent executes with skill's MCPs
  → Node output stored, downstream nodes unblocked
  → Execution history written to DB
  → Pipeline completion event emitted
```

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility:** All decisions verified compatible. No contradictions found across data architecture, security, API, frontend, and infrastructure decisions. Single-process Node.js model makes file watching, semaphore, and in-memory config swap reliable without distributed coordination concerns.

**Pattern Consistency:** All naming conventions consistent across layers (snake_case DB, kebab-case API/files, colon-separated events, camelCase code). ISO 8601 timestamps universal. Direct API responses throughout.

**Structure Alignment:** New subsystems follow existing one-concern-per-directory pattern. New types extend shared/types/. New routes extend api/routes/. New pages follow flat top-level convention.

### Requirements Coverage

**Functional Requirements:** All 67 FRs mapped to architectural components. MVP FRs (FR1-16, FR19-24, FR34-41, FR54-56, FR58, FR64-66) have explicit structural support through permission-engine, pipeline-engine, skill extensions, and new API routes. Growth and Vision FRs have deferred decisions noted.

**Non-Functional Requirements:** All 30 NFRs architecturally supported. Critical NFRs (code-level permission gates, append-only audit, fault isolation, non-blocking I/O, concurrent agent cap) have specific implementation points identified.

### Gap Analysis — Resolved

**Gap 1: Pipeline execution history table**
```sql
CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  node_results TEXT,
  error TEXT
);
-- status: running | completed | failed | cancelled
-- node_results: JSON blob mapping node IDs to outputs/status
-- Indexes: idx_pipeline_runs_pipeline_name, idx_pipeline_runs_started_at
```

**Gap 2: Pending approvals table**
```sql
CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  details TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  session_id TEXT,
  pipeline_name TEXT
);
-- resolution: approved | denied | NULL (pending)
-- Dashboard queries: resolution IS NULL for pending items
-- Index: idx_pending_approvals_resolution
```

**Gap 3: Audit log query endpoint** — Added `/api/audit-logs` with query params: `?skillName=...&tier=...&from=...&to=...&limit=...&offset=...`

**Migration files updated:**
- `migrations/003-pipeline-runs.sql` includes both `pipeline_runs` and `pending_approvals` tables

### Architecture Completeness Checklist

**Requirements Analysis**
- [x] Project context thoroughly analyzed (67 FRs, 30 NFRs)
- [x] Scale and complexity assessed (Medium-High)
- [x] Technical constraints identified (Claude SDK, SQLite, MCP isolation, ESM, brownfield)
- [x] Cross-cutting concerns mapped (permissions, audit, events, error handling, context injection)

**Architectural Decisions**
- [x] Critical decisions documented (permission gates, audit log, pipeline storage, migrations)
- [x] Technology stack fully specified (brownfield — all versions confirmed)
- [x] Integration patterns defined (SSE, event bus, file-passthrough API, MCP)
- [x] Performance considerations addressed (semaphore, non-blocking I/O, 200ms API target)

**Implementation Patterns**
- [x] Naming conventions established (DB, API, code, events, actions)
- [x] Structure patterns defined (permission actions, pipeline YAML, audit schema)
- [x] Communication patterns specified (event payloads, SSE format, config reload flow)
- [x] Process patterns documented (error handling, retry, graceful degradation)

**Project Structure**
- [x] Complete directory structure defined (every new and extended file named)
- [x] Component boundaries established (permission-engine, pipeline-engine, config-watcher, skills)
- [x] Integration points mapped (internal communication, external integrations, data flow)
- [x] Requirements to structure mapping complete (FR categories → files)

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High — brownfield project with established patterns, all MVP decisions made, no critical gaps remaining.

**Key Strengths:**
- Single enforcement point for permissions (agent-session) — impossible to bypass
- Graph-based pipeline schema — flexible enough for N8N-level complexity without future schema changes
- Clean separation: YAML for pipeline definitions, DB for runtime state, JSON for permission config
- All new subsystems follow existing project patterns — low learning curve for AI agents
- Transaction-wrapped migrations prevent partial schema corruption

**Areas for Future Enhancement (Growth/Vision phases):**
- Knowledge bubble schema and storage engine
- Knowledge graph relationships and visual explorer
- Per-pipeline concurrency limits
- Nested dashboard page layout
- Visual pipeline editor
- Webhook trigger implementation details

### Implementation Handoff

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented
- Use implementation patterns consistently across all components
- Respect project structure and boundaries
- Refer to this document for all architectural questions
- When in doubt, check the Enforcement Guidelines section

**First Implementation Priority:**
1. Schema migration system (`core/db/migrations.ts`)
2. Migration scripts (`migrations/001-*.sql` through `003-*.sql`)
3. Permission engine (`core/permission-engine/`)
4. Permission gate in agent session (`core/agent-manager/agent-session.ts`)
