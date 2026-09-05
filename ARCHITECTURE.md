# Raven Architecture

## Overview

Raven serves one owner: reduce coordination work, remember useful context and act
within enforced permission boundaries. It is an event-driven assistant powered
by `@anthropic-ai/claude-agent-sdk`; Claude and Codex share development guidance
without changing that runtime provider. The
capability library is its only capability system; background services compile in
core. `createRaven()` in `packages/core/src/raven.ts` composes the runtime, and
`index.ts` is the entry point. Chat resumes SDK sessions, while the execution bridge
owns task completion. Core can boot without Neo4j; graph-backed knowledge features
then remain unavailable.

The [completion record](_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
is the current delivery and verification record; the
[deferred ledger](_bmad-output/implementation-artifacts/deferred-work.md) gives
remaining limitations and their resolution plans. The
[project workspace proposal](docs/superpowers/specs/2026-09-05-project-workspaces-design.md)
is deferred: external repository attachments, project-owned memory and graph
replacement are not implemented. Keep the runtime small by extending existing
paths; remove a predecessor in the same change that replaces it.

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
                    │            │   │                   │
                    └─────┬──────┘   └───────────────────┘
                          │
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

Named agents live under `projects/**/agents/`, normally in `<name>/agent.yaml`;
legacy flat YAML also loads. Each declares a `skills:` list. At dispatch
time, `AgentResolver.resolveAgentCapabilities()` (`packages/core/src/agent-registry/agent-resolver.ts`)
turns that list into concrete `mcpServers` + sub-agent definitions via `CapabilityLibrary`.
An empty `skills: []` list resolves to no capability bindings. The default agent
enumerates its capabilities explicitly. SuiteRegistry and its legacy path were deleted.

Default chat and execution trees resolve each named agent's `model` tier and
`maxTurns` before queueing. The queued settings survive subsequent definition
edits, and budget admission sees the same effective model as the backend. YAML
and API turn limits are integers from 1 through 100; null API patches reset to
the YAML defaults (`sonnet`, 15 turns). Global configuration supplies dispatches
without named overrides. Heartbeat and memory consolidation retain their explicit
internal overrides. Missing configuration is an error.

Approved actions validate the stored session's current project and the requested
skill's MCP/vendor bindings before admission. Their run YAML and completion events
retain that project ownership. Approval records have no originating named-agent
identity, so these actions use global model/turn defaults. HTTP, audit logs and the
approval inbox expose execution failure even when the owner's approval was saved.

When the corresponding runtime dependencies are supplied, sessions also get
the in-process **Raven MCP**
(`packages/core/src/mcp-server/`), which bundles task-lifecycle, session, knowledge,
validation, escalation, and system tools. `createRavenMcp(deps, scope)` filters that
tool set down by `ScopeContext.role` (`task` / `chat` / `system` / `validation` /
`knowledge`, see `mcp-server/scope.ts`) — a task-scoped session can call `complete_task`
but not `create_task_tree`; a chat-scoped session can call `create_task_tree` but not
`complete_task`.

Tool registration also follows actual dependencies. Graph-disabled or failed
initialization exposes no unavailable knowledge tools or misleading instructions.
Named bindings validate skill, MCP and vendor definition references before turn
mutations. Validation does not authenticate an account or install an executable.

```
Named agent (projects/agents/<name>/agent.yaml, skills: [...])
  │
  ├── AgentResolver.resolveAgentCapabilities() → mcpServers + agentDefinitions
  │   (via CapabilityLibrary)
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

1. A named agent gets only the capabilities its explicit `skills:` list resolves to; an empty list means none. Resolution failure rejects the turn instead of granting the full library.
2. The Raven MCP's tool set is filtered by role before it reaches the model — `isToolAllowed()` denies out-of-scope tools outright.
3. SDK sub-agent definitions receive their scoped capabilities and runtime permission checks; delegation must preserve those boundaries.
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
   (agent: digest) runs with its configured capabilities
7. A final task of type 'notify' emits 'notification:deliver' and completes locally
```

The notify task's terminal state is evidence of local dispatch, not a receipt from
Telegram. Actual account delivery depends on enabled integrations and requires a
separate account canary.

## Event Bus

The in-process typed `EventEmitter` carries lifecycle and service events. `emit()`
invokes listeners synchronously; it does not await their asynchronous work. Each
component must track its own listeners and pending work. Direct request/response
calls and store operations also connect components; the bus is not a work queue.

### Event Types

`pipeline:*` events do not exist — the pipeline engine stratum was deleted. The task
tree lifecycle is driven by `execution:*` events (`packages/shared/src/types/events.ts`).
A representative subset:

| Event                                   | Source                                           | Description                                            |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `schedule:triggered`                    | Scheduler                                        | Cron/schedule fired                                    |
| `execution:tree:create` / `:created`    | Task Execution Engine                            | A task tree is requested / created from a template     |
| `execution:task:run-agent`              | Task Execution Engine                            | A tree task needs an agent to run it                   |
| `agent:task:request`                    | execution-bridge / Orchestrator                  | Request to spawn an agent session                      |
| `agent:task:complete`                   | Agent Manager                                    | Agent session finished                                 |
| `execution:task:completed` / `:blocked` | Task Execution Engine                            | Tree task advanced or blocked after the agent finished |
| `execution:tree:completed`              | Task Execution Engine                            | All tasks in a tree finished                           |
| `email:new`                             | Compiled email/Google Workspace watcher services | New email detected                                     |
| `agent:message`                         | Agent Manager                                    | Streaming agent output                                 |
| `user:chat:message`                     | Web/Telegram                                     | User sent a message                                    |
| `notification`                          | Service, skill, or runtime component             | Push notification to user                              |

### Flow: New Email

```
IMAP IDLE watcher (compiled core service) detects mail
  → emits 'email:new'
  → enabled email services apply their configured rules
  → actions use the existing agent-manager permission path when needed
  → applicable notification rules emit 'notification'
  → an enabled notification integration handles delivery
```

### Flow: User Chat

```
User types in web dashboard
  → WebSocket sends 'chat:send'
  → API handler emits 'user:chat:message'
  → ownership, capability and transcript checks accept or reject the correlated send
  → orchestrator creates an agent task for the global default named agent and
    injects the project's inherited context (project-local selection remains a gap)
  → agent manager spawns that agent's session: its skill-resolved mcpServers + the
    chat-scoped Raven MCP (classify_request / create_task_tree / send_message) + memory MCP
  → the agent either answers directly, delegates via the Agent tool, or calls
    create_task_tree for multi-step work
  → results stream back via 'agent:message' events
  → WebSocket pushes to browser in real-time
```

The dashboard scopes history, streams and drafts to the Raven project/session ID;
SDK session IDs are stored separately for resume. Acceptance follows transcript
persistence. Rejected or disconnected sends retain a recoverable draft, and
reconnect reloads history and active-task state to recover missed terminal events.

## Capability Library

A skill is a directory under `library/skills/<domain>/<sub>/<name>/` with two files:

```jsonc
// config.json
{
  "name": "ticktick",
  "displayName": "TickTick",
  "description": "Manages tasks, projects, and lists in TickTick",
  "mcps": ["ticktick"], // references library/mcps/ticktick.json
  "vendorSkills": [],
  "tools": ["Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 10,
  "actions": [
    {
      "name": "ticktick:create-task",
      "description": "Create a new task",
      "defaultTier": "yellow",
      "reversible": true,
    },
  ],
}
```

`skill.md` holds the prompt/instructions text injected for that skill.

`CapabilityLibrary.load()` (`packages/core/src/capability-library/`) walks `library/skills/`
at boot, parsing every `config.json` (+ optional `skill.md`) into a `LoadedSkill`, and
`library/mcps/*.json` into `McpDefinition`s. `AgentResolver` turns a named agent's
`skills:` list into the `mcpServers` + sub-agent definitions a `query()` session receives.
Validate the library on disk with `npm run validate:library`.

The primary extension path is chat tools such as `create_skill`, `create_agent`,
`create_template` and `create_schedule`. Their existing scaffold-and-activate path
validates definitions, writes files, reloads affected registries and commits the
specific paths. REST scaffolding uses the same path. Tool-created skill actions
are capped at yellow; granting a red action requires a deliberate file change.
An installed definition grants nothing until it is explicitly bound to an agent.

### Background services

Services live in `packages/core/src/services/`, registered by `registry.ts` and
started by `runner.ts` with environment eligibility checks. The suite layer,
SuiteRegistry, and `config/suites.json` were removed. Extend capabilities through
the library and existing scaffold-and-activate tools; do not recreate suites.
Service startup follows dependency construction and event listener registration;
cron starts after service jobs are registered. Autonomous management, TickTick
sync and pattern analysis retain per-start dependencies and cancellation, release
their jobs on stop, and suppress post-stop work through stale callbacks. TickTick
imports validate the fetched list before writes and deduplicate against complete
local history. Remote TickTick project IDs do not select Raven project ownership;
imports use system storage until an explicit mapping exists.

## Data Layer

- **SQLite** via `better-sqlite3` — single file at `data/raven.db`
- Operational tables include sessions, the project cache, events, schedule fires, preferences, permissions, notifications, integrations, intents, model-budget leases and Gemini upload cleanup. `migrations/001-initial-schema.sql` installs the current schema atomically. Retired SQL task/tree/run, pipeline, schedule-definition and pending-config tables are removed; task, tree and run persistence uses project YAML. Historical pre-use schema versions are unsupported and are never imported or rewritten automatically.
- Repositories in `packages/core/src/db/repositories/`

Board tasks are validated YAML documents under
`projects/<resolved-fsPath>/tasks/board/<id>.yaml`. Projectless tasks use the system
project physically. Queries read current files, including external edits; there
is no SQLite import or fallback. Atomic replacement flushes the file and directory
before task events. Cross-project moves use a durable intent and content hashes
to finish interrupted moves or report conflicting edits. Parent links stay within
one project. Task storage directories are reserved and never scanned as projects.
One Raven process owns a project storage root; record writes cannot race a project
archive or registry reload.

Execution trees use `tasks/trees/<treeId>.yaml` in the same resolved project. The
whole document includes nodes, exact agent attempt IDs, outcomes and artifact
metadata. Queries return detached snapshots. Engine-owned timers, code execution
and validation are drained during shutdown; restart marks interrupted trees for
explicit approval rather than replaying actions. The board opens plan details,
shows errors and retained outputs, and offers approval, resume and cancellation.
Runtime completion uses the exact tree/node/attempt; unrelated work by the same
agent cannot complete a board task. `save_artifact` was removed because it never
wrote a file. Browser file delivery is part of the authorized workspace work.
When task validation sets `requireArtifacts: true`, completion must include
registered artifact metadata through `complete_task`; a summary or paths in final
text do not satisfy that gate. System maintenance explicitly accepts a summary.
Metadata registration alone does not verify a physical file's contents.

AgentManager attempts use `tasks/runs/<agentTaskId>.yaml`. Current files supply
history, dashboard counts, heartbeat activity and retrospective summaries. Model
dispatch awaits the start record; terminal events await completion persistence.
Queued cancellation creates a terminal record without dispatch. External edits
are visible to reads and protected from stale writes. Unfinalized records become
failed/interrupted after restart with an explicitly unknown prior execution
outcome; they never replay work. A write failure reports an unresolved durable
outcome and preserves conflicting bytes. Shutdown keeps stores open until admitted
writes settle; it cannot impose a timeout and still promise safe disposal.
Direct heartbeat, session retrospective and memory/knowledge consolidation calls
bypass Manager history. Every Raven Claude query uses the shared budgeted backend:
SQLite `model_budget_leases` reserves integer micro-USD before dispatch, passes a
query cap to the SDK, and settles its estimated cost before returning. The local
calendar day is fixed at admission. Missing usage and interrupted reservations
consume their full reservation as unknown; startup never refunds them. Concurrent
queries retain headroom for nested evaluator calls and fail promptly on exhaustion.
`GET /api/budget` separates known estimates, reservations and unknown usage.

This admission budget measures SDK query estimates, including query-pipeline
subagents. It is not the subscription bill or a strict provider billing cap: the
SDK can exceed the query cap during a work step. Gemini and arbitrary external
commands are outside this Claude-query budget. Zero daily budget blocks queries.

Managed projects store UUID identity and settings in `context.md`'s `ravenProject`
metadata. The lifecycle writes current file metadata, preserves human context,
reloads the registry and synchronizes SQLite by `fs_path`. Empty projects archive
their definition and identity; system projects and known SQLite references prevent
deletion. Graph memberships also prevent deletion when Neo4j is available. Without
it, an otherwise empty project can archive with `knowledgeReferencesChecked: false`;
this does not prove that it has no graph memberships.
Handled filesystem/cache failures have compensation. Startup reconciliation after
process interruption remains deferred; cross-store power-loss atomicity is not
claimed. Plain definitions use their relative path as identity and intrinsic
defaults for settings; no fields fall back to old database values. Missing
definitions never reappear from SQLite. Referenced missing projects remain
inactive historical rows; unreferenced stale rows are removed. Invalid definitions
or identity conflicts stop startup instead of activating stale cache permissions.

Data-source rows hold labeled URIs. Their ownership-checked CRUD is available even
when graph knowledge is disabled, but a row does not attach a repository, grant
filesystem access or index its files. Graph views are currently global, and chat
still selects the global default agent rather than a project-local default.

Agent memory lives in `projects/agents/<name>/memory/`; interactive retrospectives
write candidate files with provenance, and consolidation applies validated note
operations and regenerates `MEMORY.md`. Only successful application and indexing
allow archival; rejected, failed or partial operations retain pending candidates.
This loop works without Neo4j. Memory currently has global agent ownership and
flat note paths, not separate project memory.

Knowledge bodies are Markdown under the configured `data/knowledge` root.
Neo4j owns durable relationships, project membership and additional graph metadata.
Direct reads take current file metadata and bodies; retained tags and domain
memberships keep their relationship annotations. Routine reindex never prunes
unmatched Bubble nodes. `/api/knowledge/reconciliation` reports file/graph conflicts,
malformed or duplicate identities, pending deletions and stale derived records.
Explicit reindex and existing system maintenance refresh source fields and retry
embeddings/chunks; the returned report distinguishes source and derived failures.

Source revisions cover title, body and tags. Each derived replacement checks the
source revision under a graph write lock and commits its revision marker with
its data. Chunk generation finishes before replacing one bubble's rows. Startup
hands stale IDs to the started processors as owned background work; slow model
loading leaves the API available. A failed refresh remains stale across restart.

Knowledge writes use flushed temporary files and rename; a renamed original stays
until the replacement and graph update succeed. A durable pending deletion YAML
record precedes graph deletion, prevents reindex resurrection and supports an
explicit retry of that delete. Source changes or duplicate files require review.
There is no atomic transaction across Markdown and Neo4j or automatic restoration
of deleted relationships. The owner waived legacy migration/restoration because
Raven has not been used. Graph replacement remains part of the workspace design.

Graph initialization publishes dependencies only after success and disposes
partially started processors on failure. Shutdown stops admission, aborts local
waits and drains tracked runtime work before disposing stores. Voice requests,
maintenance and direct retrospective/heartbeat/consolidation work own their
lifetimes too. Each `runAgentTask` shares one admission tracker between its Raven
and memory MCP servers. Abort or backend completion closes admission and suppresses
late SDK callbacks; admitted local handlers drain before terminal persistence and
store disposal. Trackers are per task, so a worker awaiting its validator does not
hold up that validator's own cleanup. Validator admission still has headroom when
the normal concurrency limit is one. Cancellation does not roll back a committed
local mutation or prove remote provider completion/cleanup; those external limits
remain recorded in the ledger.

File transcription persists upload attempts in operational SQLite `gemini_uploads`
before calling Google. Raven shares one cleanup coordinator across transcription,
maintenance and shutdown. It captures exact remote IDs before inference, observes
late upload responses while alive, and retains pending/unknown outcomes across
restart. Active files are excluded from cleanup. Deletion has an independent
bounded signal; startup and maintenance retry only known pending IDs. Successful
deletion or an exact provider 404 records completion. No remote ID is inferred
from a source filename, and cancellation cannot prove remote inference stopped.
`GET /api/provider-uploads` exposes bounded diagnostics; maintenance appends them
even when its analysis comes from a model. Coordinator stop persists outstanding
outcomes and drains local deletion waits before SQLite closes.

## API Layer

- **Fastify** HTTP server on port 4001
- **WebSocket** at `/ws` for real-time streaming
- REST endpoints under `/api/` for CRUD operations

### WebSocket Protocol

Client → Server:

- `subscribe` / `unsubscribe` to channels (`project:<id>`, `global`)
- `chat:send` to send messages to a project agent

Server → Client:

- `event` - an envelope `{ type: 'event', data: event }`; `data.type` identifies
  streaming `agent:message`, `notification`, and other system events
- `chat:error` - an invalid/refused WebSocket send, correlated by request ID when available

The event stream includes `user:chat:accepted` and `user:chat:rejected` for sends
that reached the orchestrator. Shared protocol definitions live in
`packages/shared/src/types/api.ts` and `events.ts`.

## Scheduler

Uses `croner` for timezone-aware cron. Schedules are YAML files under `projects/schedules/*.yaml` (filesystem is source of truth; the DB holds only per-schedule enable/disable overrides). `ScheduleEngine` (`scheduler/schedule-engine.ts`) supports three kinds:

- `job` — a named handler from the job registry (`core-jobs.ts`): task archival, memory consolidation, weekly system retrospective, nightly self-test.
- `template` — instantiates a task template (`projects/templates/*.yaml`) into a task tree; used by the morning digest and the weekly canary.
- `heartbeat` — an ambient check-in turn with a silence contract (`HEARTBEAT_OK` → swallowed), off by default.

Terminal fire outcomes are recorded in `schedule_fires` with the invocation's
activation ID. The nightly self-test checks current enabled definitions for
missing/stale fires, failure, absent registration and invocations stuck over an
hour. Croner computes expected windows in each schedule's timezone, with five
minutes of activation grace and one minute of completion grace. Healthy manual
runs satisfy the current window. A `fired` template row proves dispatch; the
weekly canary additionally checks task-tree completion.

Unchanged reloads preserve activation; new, changed or re-enabled definitions get
a fresh ID so old completions cannot mask a missed run. Cron and manual invocations
are tracked before handlers start, including self-test's own run. Stop closes
admission and drains them before store disposal. Disabled/removed schedules do
not contribute ordinary health failures. Scanner-rejected invalid files remain
outside accepted definitions; F9 will expose those registry diagnostics.

**Intents (prospective memory).** `intents/intent-matcher.ts` is a service that turns owner requests like "remind me when X arrives" into deterministic rows (`intents` table in the fresh schema): keyword/event-type matches with a fire budget, cooldown, and expiry — no LLM inference at match time. Created via the `create_intent` MCP tool, listed/cancelled from the Schedules page.

Time intents use the existing matcher's sweep, not a new schedule file. Heartbeat
uses a dedicated throwaway SDK session with a small turn cap; it does not resume
or pollute the owner's interactive conversation. Active hours, recent activity
and an in-progress heartbeat suppress redundant runs before model execution.

**Self-verification.** A nightly self-test job (`services/system/self-test.ts`)
checks stuck/failed task trees, loaded service count below environment eligibility,
current schedule freshness/failure, agent-task error rate, stale approvals, data
directory writability and DB integrity. It batches violations into one notification
for configured delivery and records results for `/api/health`; this is not a
Telegram receipt. The weekly canary uses a dedicated minimal template. Its check
allows a completion grace period and detects missing/stale runs when enabled.

## Docker Deployment

See [docs/deployment.md](docs/deployment.md) for current commands, authentication,
backups and optional integrations. Node.js 22.22.0 or newer is required.

- `raven-core` (port 4001) - orchestrator, agents, capability library, background services, scheduler
- `raven-web` (port 4000) - Next.js dashboard
- `neo4j` (ports 7474/7687) - opt-in knowledge profile; core has no mandatory dependency

Default Compose uses dedicated named volumes for data, projects, library, config
and Claude authentication/resume files. It seeds only empty definition roots with
minimal account-free definitions. Definition/memory Git history is persisted;
interrupted bootstrap uses a hash-checked journal and refuses conflicting edits.
The image excludes owner definitions, credentials, runtime data and vendor trees.
Install and bind optional integrations deliberately. Browser API/WS endpoints are
web build arguments and must be reachable by the user's browser.

R4 verified both images, offline container restart persistence, static assets and
real Git history. R5's checkpoint passed 1971 tests with 6 explicit skips, 11 browser
journeys, required checks, production builds and compiled restart verification.
These use temporary roots and fake model boundaries; they do not prove live model
quality, account delivery or attached-repository behavior. Exact evidence and
remaining work are maintained in the completion record and deferred ledger.
