# Raven Architecture

## Overview

Raven is an event-driven personal assistant powered by the Claude Agent SDK. It runs as
three Docker containers (core, web dashboard, Neo4j for the knowledge engine) and resolves
capabilities per agent: a capability library of skills (primary) plus a deprecated set of
background-service suites (Phase 2 removal — see `docs/assessments/2026-08-06-architecture-assessment.md`).

## System Diagram

```
                    ┌─────────────┐
                    │  Web UI     │ (Next.js, port 4000)
                    └──────┬──────┘
                           │ WebSocket + REST
                           ▼
                    ┌──────┴──────┐
                    │  API Server │ (Fastify, port 4001)
                    └──────┬──────┘
                           │
          ┌────────────────┼──────────────────┐
          ▼                ▼                  ▼
    ┌───────────┐   ┌───────────┐    ┌────────────────┐
    │ Session   │   │ Scheduler │    │   Event Bus    │ ◄── central nervous system
    │ Manager   │   │ (croner)  │    │  (EventEmitter)│
    └───────────┘   └─────┬─────┘    └───────┬────────┘
                          │                  │
                          ▼                  ▼
                    ┌─────┴──────┐   ┌────────┴─────────┐
                    │Orchestrator│◄─►│  Task Execution   │
                    │            │   │  Engine + bridge  │
                    └─────┬──────┘   └────────┬─────────┘
                          │                  │
                          ▼                  ▼
                    ┌─────┴──────┐   ┌────────┴─────────┐
                    │  Agent     │   │ Agent Resolver:   │
                    │  Manager   │◄─►│ Capability Library│
                    │            │   │ / Suite Registry  │
                    └─────┬──────┘   │    (legacy)       │
                          │          └───────────────────┘
                          ▼
              ┌───────────┴────────────────┐
              │  Claude Agent SDK query()  │
              │  + in-process Raven MCP    │
              │  (role-scoped)             │
              └────────────────────────────┘
```

## Per-Agent Capability Resolution + Raven MCP

This is the most important architectural decision in Raven.

### Problem
Loading every capability into a single agent context causes:
- Bloated context windows (each MCP/tool adds tool descriptions)
- Higher costs per query
- Tool name collisions between skills
- Slow agent startup

### Solution: skill-list resolution + role-scoped in-process MCP

Every named agent (`projects/**/agents/*.yaml`) declares a `skills:` list. At dispatch
time, `AgentResolver.resolveAgentCapabilities()` (`packages/core/src/agent-registry/agent-resolver.ts`)
turns that list into concrete `mcpServers` + sub-agent definitions via `CapabilityLibrary`
(agents still bound to legacy `suiteIds` fall back to `SuiteRegistry`). An agent with no
skills bound — including the default agent — gets every skill the library exposes.

Independently of that, every agent session also gets the in-process **Raven MCP**
(`packages/core/src/mcp-server/`), which bundles task-lifecycle, session, knowledge,
validation, escalation, and system tools. `createRavenMcp(deps, scope)` filters that
tool set down by `ScopeContext.role` (`task` / `chat` / `system` / `validation` /
`knowledge`, see `mcp-server/scope.ts`) — a task-scoped session can call `complete_task`
but not `create_task_tree`; a chat-scoped session can call `create_task_tree` but not
`complete_task`.

```
Named agent (projects/agents/<name>/agent.yaml, skills: [...])
  │
  ├── AgentResolver.resolveAgentCapabilities() → mcpServers + agentDefinitions
  │   (via CapabilityLibrary, or SuiteRegistry for legacy suiteIds)
  │
  ├── Agent Manager spawns a Claude Agent SDK query() session with:
  │   - those resolved mcpServers
  │   - the in-process Raven MCP, scoped by role (task/chat/system/validation/knowledge)
  │   - a per-agent memory MCP
  │
  └── if agentDefinitions are non-empty, the session may use the `Agent` tool to
      delegate to a sub-agent — sub-agents can declare their own mcpServers subset
      (SubAgentDefinition.mcpServers) rather than inheriting everything
```

**Rules:**
1. A named agent only gets the MCP servers its `skills:` list resolves to — never the whole library, unless it deliberately has no bindings.
2. The Raven MCP's tool set is filtered by role before it reaches the model — `isToolAllowed()` denies out-of-scope tools outright.
3. Sub-agent definitions can restrict themselves to a subset of the parent's MCP servers.
4. MCP server subprocesses are only started when a `query()` session actually needs them.
5. Carried over from v1: don't overload any one context with capability it doesn't need — the mechanism is per-agent resolution + role scoping, not "orchestrator has zero MCPs, only sub-agents do."

### Example: Morning Digest Flow

The `morning-digest` template (`projects/templates/morning-digest.yaml`) drives this:

```
1. Scheduler fires the morning-digest schedule → Task Execution Engine creates a tree
   from the template
2. For the 'fetch-tasks' task (agent: ticktick), the engine emits 'execution:task:run-agent'
3. execution-bridge (packages/core/src/task-execution/execution-bridge.ts) looks up the
   'ticktick' named agent, resolves its capabilities, and emits 'agent:task:request'
4. Agent Manager spawns a query() session with the TickTick MCP + role-scoped Raven MCP
   → returns structured task data
5. Agent Manager emits 'agent:task:complete'; execution-bridge calls
   TaskExecutionEngine.onTaskCompleted(), advancing the tree
6. Same pattern for 'fetch-emails' (agent: gmail); once both finish, 'compile-digest'
   (agent: digest) runs, compiles the briefing, and sends it via Telegram
7. The final 'send-digest' task (type: notify) confirms delivery
```

## Event Bus

In-process typed `EventEmitter`. All component communication goes through the bus.

### Event Types

`pipeline:*` events do not exist — the pipeline engine stratum was deleted. The task
tree lifecycle is driven by `execution:*` events (`packages/shared/src/types/events.ts`).
A representative subset:

| Event | Source | Description |
|-------|--------|-------------|
| `schedule:triggered` | Scheduler | Cron/schedule fired |
| `execution:tree:create` / `:created` | Task Execution Engine | A task tree is requested / created from a template |
| `execution:task:run-agent` | Task Execution Engine | A tree task needs an agent to run it |
| `agent:task:request` | execution-bridge / Orchestrator | Request to spawn an agent session |
| `agent:task:complete` | Agent Manager | Agent session finished |
| `execution:task:completed` / `:blocked` | Task Execution Engine | Tree task advanced or blocked after the agent finished |
| `execution:tree:completed` | Task Execution Engine | All tasks in a tree finished |
| `email:new` | `suites/email` or `suites/google-workspace` IMAP watcher | New email detected |
| `agent:message` | Agent Manager | Streaming agent output |
| `user:chat:message` | Web/Telegram | User sent a message |
| `notification` | Any suite/skill | Push notification to user |

### Flow: New Email

```
IMAP IDLE watcher (a suite service — email:new is still suite-sourced today) detects mail
  → emits 'email:new'
  → orchestrator receives, creates an agent task for the 'gmail' named agent
  → agent manager spawns a session with the gmail skill's MCP + role-scoped Raven MCP
  → agent reads + summarizes email
  → agent manager emits 'agent:task:complete'
  → orchestrator evaluates: actionable?
  → if yes: emits 'notification'
  → telegram-capable flow delivers it
```

### Flow: User Chat

```
User types in web dashboard
  → WebSocket sends 'chat:send'
  → API handler emits 'user:chat:message'
  → orchestrator creates an agent task for the resolved named agent (default agent,
    or whichever agent the project assigns)
  → agent manager spawns that agent's session: its skill-resolved mcpServers + the
    chat-scoped Raven MCP (classify_request / create_task_tree / send_message) + memory MCP
  → the agent either answers directly, delegates via the Agent tool, or calls
    create_task_tree for multi-step work
  → results stream back via 'agent:message' events
  → WebSocket pushes to browser in real-time
```

## Capability Library

A skill is a directory under `library/skills/<domain>/<sub>/<name>/` with two files:

```jsonc
// config.json
{
  "name": "ticktick",
  "displayName": "TickTick",
  "description": "Manages tasks, projects, and lists in TickTick",
  "mcps": ["ticktick"],       // references library/mcps/ticktick.json
  "vendorSkills": [],
  "tools": ["Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 10,
  "actions": [
    { "name": "ticktick:create-task", "description": "Create a new task", "defaultTier": "yellow", "reversible": true }
  ]
}
```
`skill.md` holds the prompt/instructions text injected for that skill.

`CapabilityLibrary.load()` (`packages/core/src/capability-library/`) walks `library/skills/`
at boot, parsing every `config.json` (+ optional `skill.md`) into a `LoadedSkill`, and
`library/mcps/*.json` into `McpDefinition`s. `AgentResolver` turns a named agent's
`skills:` list into the `mcpServers` + sub-agent definitions a `query()` session receives.
Validate the library on disk with `npm run validate:library`.

### Suites (deprecated)

A suite is `suites/<name>/suite.ts` plus a `services/` directory of long-running
background processes (IMAP watchers, schedulers, etc.) — the pre-capability-library
extension mechanism. Enable/disable suites in `config/suites.json` (read by
`loadSuitesConfig`, `packages/core/src/config.ts`). Suites currently running:
`task-management`, `email`, `notifications`, `daily-briefing`, `gemini-transcription`,
`google-workspace`, `financial-tracking`, `file-processing`, `proactive-intelligence`,
plus the internal `_orchestrator` suite (config apply/approval services).

**Suites are on death row.** They are scheduled for removal in Phase 2 of
`docs/assessments/2026-08-06-architecture-assessment.md`. New capability goes into the
capability library (above), not a new suite.

## Data Layer

- **SQLite** via `better-sqlite3` — single file at `data/raven.db`
- Tables include `events`, `sessions`, `projects`, `schedules`, `preferences`, `tasks`, `task_trees`, `execution_tasks`, `agent_tasks`, `audit_log`, `pending_approvals` (see `migrations/`)
- Repositories in `packages/core/src/db/repositories/`

## API Layer

- **Fastify** HTTP server on port 4001
- **WebSocket** at `/ws` for real-time streaming
- REST endpoints under `/api/` for CRUD operations

### WebSocket Protocol

Client → Server:
- `subscribe` / `unsubscribe` to channels (`project:<id>`, `global`)
- `chat:send` to send messages to a project agent

Server → Client:
- `agent:message` - streaming agent output
- `event` - system events
- `notification` - push notifications

## Scheduler

Uses `croner` for timezone-aware cron. Schedules stored in DB, configurable via API.
Default: morning digest at 8am local time.

## Docker Deployment

Three containers (`docker-compose.yml`):
- `raven-core` (port 4001) - orchestrator, agents, capability library, suites, scheduler
- `raven-web` (port 4000) - Next.js dashboard
- `neo4j` (ports 7474/7687) - backs the knowledge engine

Volumes:
- `./data` → SQLite DB + session files
- `./config` → suite/schedule/permissions configuration
