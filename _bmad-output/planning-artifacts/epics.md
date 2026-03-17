---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/planning-artifacts/architecture.md'
---

# personal-assistant - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for personal-assistant, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**Trust & Autonomy (MVP)**
- FR1: User can assign a permission tier (Green/Yellow/Red) to any skill action
- FR2: System enforces permission tiers at the agent spawner level before any sub-agent execution
- FR3: Green-tier actions execute without any user notification or approval
- FR4: Yellow-tier actions execute and report results to the user after completion
- FR5: Red-tier actions queue for explicit user approval before execution
- FR6: System batches multiple pending Red-tier approvals into a single approval request
- FR7: User can review a complete audit trail of all gated actions with timestamps and outcomes
- FR8: Each skill declares its available actions with default permission tiers and reversibility flags
- FR9: User can promote or demote permission tiers for individual skills as trust is established
- FR10: System defaults all undeclared actions to Red tier

**Pipeline Automation (MVP–Vision)**
- FR11: User can define automation pipelines as YAML configuration files [MVP]
- FR12: System executes pipelines on cron schedules [MVP]
- FR13: System executes pipelines in response to events (new email, file change, task update) [MVP]
- FR14: Pipeline configurations are automatically git-committed on every change [MVP]
- FR15: User can view pipeline execution history and status [MVP]
- FR16: System retries failed pipeline steps with configurable retry policy [MVP]
- FR17: User can create pipelines through natural language conversation [Vision]
- FR18: System suggests new pipelines based on detected manual patterns [Vision]

**Telegram Interaction (MVP–Growth)**
- FR19: User can interact with Raven through a Telegram group with topic threads per domain/project [MVP]
- FR20: User can send voice messages that are transcribed via Gemini and processed as text intent [MVP]
- FR21: System presents inline keyboard buttons for quick actions and approvals [MVP]
- FR22: User can send photos, files, and screenshots for routed processing by appropriate skills [MVP]
- FR23: System delivers morning briefings as formatted Telegram messages [MVP]
- FR24: User can manage tasks (create, complete, snooze, drop) via inline keyboard taps [MVP]
- FR25: System respects urgency tiers for notification delivery timing [Growth]
- FR26: System detects unanswered notification categories and proposes snooze [Growth]

**Web Dashboard (Growth–Vision)**
- FR27: User can view an activity timeline of all autonomous Raven actions [Growth]
- FR28: User can view a Kanban-style board of active and completed agent tasks [Growth]
- FR29: User can monitor pipeline execution status and health in real-time [Growth]
- FR30: User can view streaming agent output as tasks execute [Growth]
- FR31: User can configure pipelines through a chat interface with YAML preview [Growth]
- FR32: User can view and selectively revert git-committed configuration changes [Vision]
- FR33: User can view a life dashboard homepage aggregating all system activity [Vision]

**Task Management (MVP)**
- FR34: System autonomously manages TickTick tasks based on permission tiers
- FR35: System creates TickTick tasks from email action items automatically
- FR36: System surfaces stale tasks (no activity for configurable period) with suggested next steps
- FR37: User can delegate task management decisions to Raven from mobile

**Email Processing (MVP)**
- FR38: System auto-triages Gmail by categorizing, archiving, and labeling based on configured rules
- FR39: System extracts action items from emails and creates corresponding tasks
- FR40: User can compose and send email replies via Raven from Telegram
- FR41: System flags urgent emails based on sender and content analysis

**Knowledge Management (Growth–Vision)**
- FR42: User can store information as knowledge bubbles (markdown + metadata) [Growth]
- FR43: System ingests text, audio, and documents into structured knowledge storage [Growth]
- FR44: System auto-clusters related knowledge bubbles and maintains tag indexes [Growth]
- FR45: Sub-agents can query the knowledge layer for context injection during task execution [Growth]
- FR46: System detects cross-domain connections between knowledge nodes [Vision]
- FR47: User can explore a visual knowledge graph showing relationships [Vision]
- FR48: System identifies knowledge gaps and suggests learning tracks [Vision]

**Proactive Intelligence (Growth)**
- FR49: System performs background pattern analysis across all connected services
- FR50: System queues proactive insights for delivery at contextually appropriate times
- FR51: System classifies all outbound notifications by urgency tier
- FR52: System throttles notifications based on user engagement patterns
- FR53: User can snooze entire notification categories

**Skill Extensibility (MVP–Vision)**
- FR54: User can enable or disable skills via configuration without code changes [MVP]
- FR55: New skills integrate through the RavenSkill interface without modifying core code [MVP]
- FR56: Skills declare MCP servers that are loaded only into their sub-agents, never the orchestrator [MVP]
- FR57: System can scaffold new skill boilerplate from a conversation description [Vision]
- FR58: User can configure per-skill permission tiers through a configuration file [MVP]

**Expanding Integrations (Growth–Vision)**
- FR59: System monitors Google Drive folders for new files and processes them automatically [Growth]
- FR60: System tracks financial transactions from bank APIs and categorizes spending [Vision]
- FR61: System detects financial anomalies and alerts the user [Vision]
- FR62: System manages calendar blocks to protect deep work time [Vision]
- FR63: System provides meeting prep briefings from knowledge and relationship context [Vision]

**System Observability (MVP–Growth)**
- FR64: System logs all agent task executions with status, duration, and outcomes [MVP]
- FR65: System self-monitors health and reports failures through Telegram [MVP]
- FR66: User can view system health status through the web dashboard [MVP]
- FR67: System provides execution metrics and usage statistics [Growth]

### NonFunctional Requirements

**Security**
- NFR1: All credentials and API tokens stored in environment variables or encrypted config, never in code or git history
- NFR2: Audit trail is append-only — no agent or process can modify or delete audit log entries
- NFR3: Permission gate enforcement is code-level middleware — cannot be bypassed through prompt injection or agent reasoning
- NFR4: MCP servers carry only the credentials needed for their specific skill — no shared credential pool across sub-agents
- NFR5: SQLite database file permissions restricted to the Raven process user only
- NFR6: Telegram bot token and webhook validated — reject messages not from the authenticated user
- NFR7: No sensitive data (credentials, tokens, email content) appears in log output at any log level

**Reliability**
- NFR8: Individual skill load failures must not crash the process — log warning and continue with remaining skills
- NFR9: Individual agent task errors are caught, logged, and reported — never bubble up to crash the event loop
- NFR10: Scheduled pipelines that fail are retried with exponential backoff (max 3 retries) before reporting failure
- NFR11: System auto-restarts on crash via Docker restart policy or process manager
- NFR12: SQLite database survives unclean shutdowns — WAL mode enabled for crash resistance
- NFR13: System health endpoint responds within 500ms and reports component status
- NFR14: Failed Telegram message delivery retries 3 times before queuing for next active period

**Performance**
- NFR15: API endpoints respond within 200ms for non-agent operations
- NFR16: Agent task spawning completes within 5 seconds
- NFR17: Morning briefing compilation completes within 10 minutes
- NFR18: Pipeline step execution does not block the event loop — all I/O is non-blocking
- NFR19: Maximum 3 concurrent agent tasks by default (configurable via RAVEN_MAX_CONCURRENT_AGENTS)
- NFR20: SQLite queries complete within 50ms for typical operations
- NFR21: Telegram inline keyboard responses acknowledged within 2 seconds

**Integration**
- NFR22: External API failures handled gracefully — skill degrades, system continues
- NFR23: MCP server startup failures logged and reported — sub-agent launches with zero tools rather than crashing
- NFR24: Telegram bot maintains connection through network interruptions — automatic reconnection with backoff
- NFR25: Git operations are non-blocking and failure-tolerant — config change applies even if git commit fails
- NFR26: Gemini voice transcription timeout set to 30 seconds — fallback to "please type" message on timeout

**Operational**
- NFR27: System deployable via single docker-compose up command
- NFR28: Configuration changes take effect without full restart where possible
- NFR29: Log output is structured JSON (Pino) — parseable by standard log tools
- NFR30: Database backup achievable by copying single SQLite file

### Additional Requirements

**From Architecture — Infrastructure & Schema:**
- Schema migration system: versioned SQL scripts (`migrations/001-*.sql`), transaction-wrapped, tracked in `_migrations` table
- Audit log table: append-only, INSERT-only at application level (no UPDATE/DELETE)
- Pipeline execution history table (`pipeline_runs`) with status tracking
- Pending approvals table (`pending_approvals`) for Red-tier queued actions
- Brownfield project — no starter template or initialization story needed

**From Architecture — New Subsystems:**
- Permission engine subsystem (`core/permission-engine/`): config loader, tier resolver, file watcher, audit writer
- Pipeline engine subsystem (`core/pipeline-engine/`): YAML parser, DAG resolver, node runner, execution store
- Config watcher subsystem (`core/config-watcher/`): `fs.watch` on `config/` directory, emits `config:reloaded` events
- SSE streaming handler (`core/api/sse/stream.ts`) for agent output at `/api/agent-tasks/:id/stream`
- Gemini MCP server as new skill (`skill-gemini/`) for voice transcription

**From Architecture — Patterns & Utilities:**
- Permission gate enforcement in `agent-session.ts` before `query()` — single choke point
- Git auto-commit utility using `execFile` wrapper (no shell, non-blocking, failure-tolerant)
- Pipeline concurrency via global semaphore in agent manager (default 3)
- Graph-based pipeline YAML schema: nodes map + connections edges, DAG validated at load time
- New event types with Zod-validated payloads: `permission:*`, `pipeline:*`, `config:reloaded`
- Frontend hooks: `usePolling` (Zustand + HTTP), `useSSE` (EventSource wrapper)
- New dashboard pages: `/pipelines`, `/permissions` (flat top-level)
- Red-tier approval flow: dashboard-first with Telegram notification
- Config hot-reload: file watcher + API trigger, Zod-validated before swap

**From Architecture — Skill Extensions:**
- All existing skills (TickTick, Gmail, Telegram, Digest) must implement `getActions()` declaring permission tiers
- Action naming pattern: `<skill-name>:<action-name>` (kebab-case, colon-separated)
- Permission config stored in `config/permissions.json` — tier overrides per action name
- Undeclared actions default to Red tier

**From Architecture — Implementation Sequence:**
1. Schema migration system
2. Audit log table + append-only enforcement
3. Permission gate middleware in agent session
4. Permission config loader (JSON file watcher)
5. Pipeline YAML loader + DB execution tables
6. Pipeline CRUD API + git auto-commit
7. SSE streaming endpoint
8. Gemini MCP server
9. New event types with Zod payloads
10. Frontend: polling hook, EventSource hook, new pages

### FR Coverage Map

| FR | Epic | Description |
|---|---|---|
| FR1-10 | Epic 1 | Permission tiers, gate enforcement, audit trail, trust management |
| FR11-16 | Epic 2 | Pipeline YAML, cron/event execution, git-tracking, retry, history |
| FR17-18 | Epic 10 | Conversational pipeline creation, pattern-based suggestions |
| FR19-24 | Epic 3 | Telegram topics, voice, inline keyboards, media, briefings, task mgmt |
| FR25-26 | Epic 7 | Urgency tier delivery, category snooze proposals |
| FR27-31 | Epic 5 | Activity timeline, Kanban, pipeline monitor, streaming output, chat config |
| FR32-33 | Epic 10 | Config revert, life dashboard homepage |
| FR34-36 | Epic 4 | Autonomous task management, auto-task from email, stale task nudges |
| FR37 | Epic 3 | Mobile task delegation |
| FR38-41 | Epic 4 | Email auto-triage, action extraction, reply composition, urgency flagging |
| FR42-45 | Epic 6 | Knowledge bubbles, ingestion, clustering, context injection |
| FR46-48 | Epic 9 | Cross-domain connections, visual graph, gap detection |
| FR49-53 | Epic 7 | Pattern analysis, proactive insights, notification throttling |
| FR54-56 | Epic 1 | Skill enable/disable, RavenSkill interface, MCP isolation |
| FR57 | Epic 10 | Skill scaffolding from conversation |
| FR58 | Epic 1 | Per-skill permission config |
| FR59-63 | Epic 8 | Google Drive, finance, calendar integrations |
| FR64-66 | Epic 1 | Agent execution logging, self-monitoring, health dashboard |
| FR67 | Epic 5 | Execution metrics and usage statistics |

## Epic List

### Epic 1: Trust Foundation & Permission Gates
Raven acts autonomously within configured trust boundaries. Every action is auditable. System health is visible. This is the foundational unlock — without permission gates, nothing runs autonomously.
**FRs covered:** FR1-10, FR54-56, FR58, FR64-66
**Phase:** MVP

### Epic 2: Pipeline Automation Engine
User defines YAML pipelines that execute on cron schedules or in response to events. Configs are git-tracked. Execution history is queryable. Failed steps retry automatically.
**FRs covered:** FR11-16
**Phase:** MVP

### Epic 3: Enhanced Telegram & Mobile Command
Full life management from the phone — topic threads per domain, inline keyboard actions, voice commands via Gemini, email replies, task management, media routing, morning briefings — all via Telegram.
**FRs covered:** FR19-24, FR37, FR40
**Phase:** MVP

### Epic 4: Intelligent Email & Task Automation
Email auto-triaged, action items extracted into tasks, stale tasks surfaced with suggestions, urgency flagging — daily operations handled without manual intervention.
**FRs covered:** FR34-36, FR38-39, FR41
**Phase:** MVP

### Epic 5: Rich Dashboard & Real-Time Monitoring
See everything Raven does — activity timeline, Kanban task board, pipeline status, live streaming agent output, execution metrics.
**FRs covered:** FR27-31, FR67
**Phase:** Growth

### Epic 6: Knowledge System
Store, ingest, organize, and retrieve knowledge. Raven remembers context from weeks ago and injects it into agent tasks automatically.
**FRs covered:** FR42-45
**Phase:** Growth

### Epic 7: Proactive Intelligence & Friend Protocol
Raven proactively surfaces insights, manages notification urgency tiers, throttles based on engagement patterns, and respects attention with category snooze and silence-aware delivery.
**FRs covered:** FR25-26, FR49-53
**Phase:** Growth

### Epic 8: Expanding Integrations
Google Drive file monitoring, financial transaction tracking, spending categorization, anomaly alerts, calendar defense, meeting prep — more of digital life automated.
**FRs covered:** FR59-63
**Phase:** Growth–Vision

### Epic 9: Deep Knowledge & Intelligence
Visual knowledge graph with relationship detection, cross-domain correlation engine, knowledge gap detection, and learning track suggestions.
**FRs covered:** FR46-48
**Phase:** Vision

### Epic 10: Self-Extending System
Raven builds its own skills from conversation descriptions, suggests pipelines from detected patterns, enables conversational pipeline creation, and provides full config version management with selective revert.
**FRs covered:** FR17-18, FR32-33, FR57
**Phase:** Vision

## Epic 1: Trust Foundation & Permission Gates

Raven acts autonomously within configured trust boundaries. Every action is auditable. System health is visible. This is the foundational unlock — without permission gates, nothing runs autonomously.

### Story 1.1: Permission Types & Skill Action Declarations

As the system operator,
I want each skill to declare its available actions with default permission tiers,
So that the system knows what actions exist and their trust defaults.

**Acceptance Criteria:**

**Given** a skill implements RavenSkill
**When** `getActions()` is called
**Then** it returns an array of `SkillAction` objects with name, description, defaultTier, and reversible flag

**Given** the TickTick skill
**When** its actions are declared
**Then** read operations default to `green`, task creation defaults to `yellow`, task deletion defaults to `red`

**Given** any skill action name
**When** it is validated
**Then** it follows the pattern `<skill-name>:<action-name>` in kebab-case

### Story 1.2: Schema Migration System & Permission Tables

As the system operator,
I want database schema changes applied safely through versioned migrations,
So that the database evolves reliably without manual intervention.

**Acceptance Criteria:**

**Given** the system starts with a fresh database
**When** migrations run
**Then** all migration scripts execute in order, wrapped in transactions, and versions are tracked

**Given** a migration has already been applied
**When** the system restarts
**Then** it skips already-applied migrations

**Given** a migration script fails
**When** the transaction rolls back
**Then** the database remains in its pre-migration state and the error is logged

**Given** the audit_log table exists
**When** any SQL operation is attempted
**Then** only INSERT statements succeed at the application layer (no UPDATE/DELETE exposed)

### Story 1.3: Permission Config Loader & Tier Resolver

As the system operator,
I want to configure permission tier overrides in a JSON file,
So that I can promote or demote trust levels for specific skill actions without code changes.

**Acceptance Criteria:**

**Given** `config/permissions.json` contains `{ "gmail:archive-email": "green" }`
**When** the permission engine resolves the tier for `gmail:archive-email`
**Then** it returns `green` (overriding the skill's default)

**Given** an action has no override in permissions.json
**When** the tier is resolved
**Then** the skill's declared default tier is used

**Given** an action is not declared by any skill
**When** the tier is resolved
**Then** it defaults to `red`

**Given** `config/permissions.json` is modified on disk
**When** the file watcher detects the change
**Then** the config is re-parsed, Zod-validated, and swapped in memory
**And** a `config:reloaded` event is emitted

**Given** an invalid permissions.json is saved
**When** validation fails
**Then** the previous valid config is retained and an error is logged

### Story 1.4: Audit Log Writer & Query API

As the system operator,
I want a complete, queryable audit trail of all gated actions,
So that I can review what Raven did, when, and why.

**Acceptance Criteria:**

**Given** an audit entry is written
**When** queried via `/api/audit-logs`
**Then** it returns entries with id, timestamp, skill_name, action_name, permission_tier, outcome, details

**Given** query params `?skillName=gmail&tier=green&limit=50`
**When** the API is called
**Then** only matching entries are returned, limited to 50, sorted by timestamp descending

**Given** an attempt to UPDATE or DELETE an audit entry
**When** executed through the audit-log module
**Then** no such method exists — only `insert()` and `query()` are exposed

### Story 1.5: Permission Gate Enforcement in Agent Session

As the system operator,
I want permission tiers enforced as code-level middleware before any sub-agent executes,
So that trust boundaries cannot be bypassed regardless of prompt content.

**Acceptance Criteria:**

**Given** a Green-tier action is requested
**When** the agent session processes it
**Then** the sub-agent executes without notification and an audit entry records `outcome: executed`

**Given** a Yellow-tier action is requested
**When** the agent session processes it
**Then** the sub-agent executes, an audit entry records `outcome: executed`, and a `permission:approved` event is emitted

**Given** a Red-tier action is requested
**When** the agent session processes it
**Then** execution is blocked, an audit entry records `outcome: queued`, and the action is inserted into `pending_approvals`

**Given** any permission check occurs
**When** the tier is evaluated
**Then** it happens at the code level in agent-session.ts — not as a prompt instruction to the LLM

### Story 1.6: Red-Tier Approval Queue & Batching

As the system operator,
I want pending Red-tier actions batched into approval requests that I can approve or deny,
So that high-risk actions only execute with my explicit consent.

**Acceptance Criteria:**

**Given** 3 Red-tier actions are queued
**When** the user queries `/api/permissions/pending`
**Then** all 3 are returned with action details, skill name, and requested timestamp

**Given** a pending approval is approved
**When** the resolution is processed
**Then** the sub-agent executes, pending_approvals.resolution is set to `approved`, and an audit entry records `outcome: approved`

**Given** a pending approval is denied
**When** the resolution is processed
**Then** no execution occurs, pending_approvals.resolution is set to `denied`, and an audit entry records `outcome: denied`

**Given** multiple pending approvals
**When** batch approve/deny is requested
**Then** each is resolved individually and all audit entries are written

### Story 1.7: Agent Execution Logging & System Health Monitoring

As the system operator,
I want all agent task executions logged and system health self-monitored,
So that I can see what Raven is doing and failures surface automatically.

**Acceptance Criteria:**

**Given** an agent task executes
**When** it completes (success or failure)
**Then** an execution record is written with task ID, skill, status, duration, and timestamp

**Given** the system is running
**When** `/api/health` is called
**Then** it responds within 500ms with status of each subsystem (db, eventBus, skills, scheduler)

**Given** a skill fails to load or an agent task errors
**When** the failure is detected
**Then** a health alert event is emitted and routed to Telegram

## Epic 2: Pipeline Automation Engine

User defines YAML pipelines that execute on cron schedules or in response to events. Configs are git-tracked. Execution history is queryable. Failed steps retry automatically.

### Story 2.1: Pipeline YAML Loader & Validation

As the system operator,
I want to define automation pipelines as YAML files that are validated on load,
So that pipeline configurations are reliable and errors are caught before execution.

**Acceptance Criteria:**

**Given** a valid pipeline YAML file in `config/pipelines/`
**When** the pipeline loader starts
**Then** it parses and validates the file, making it available for execution

**Given** a pipeline YAML with a cycle in its connections
**When** DAG validation runs
**Then** the pipeline is rejected with a clear error message identifying the cycle

**Given** an invalid YAML file (missing required fields, bad types)
**When** Zod validation fails
**Then** the file is rejected, error logged, and other valid pipelines continue loading

**Given** a new YAML file is added to `config/pipelines/`
**When** the file watcher detects it
**Then** the pipeline is loaded and validated without restart

### Story 2.2: Pipeline Execution Engine & DAG Runner

As the system operator,
I want pipelines to execute their nodes in dependency order with parallel execution where possible,
So that automation workflows run efficiently and correctly.

**Acceptance Criteria:**

**Given** a pipeline with nodes A→B→C (sequential)
**When** the pipeline executes
**Then** A completes before B starts, B completes before C starts

**Given** a pipeline with nodes A and B (no dependencies) both feeding into C
**When** the pipeline executes
**Then** A and B execute in parallel, C executes after both complete

**Given** a node of type `condition` with expression `{{ fetch-emails.output.urgentCount > 0 }}`
**When** the condition evaluates
**Then** downstream connections follow the matching branch (true/false)

**Given** a skill-action node executes
**When** the agent manager spawns the sub-agent
**Then** the permission gate is checked and the node output is captured for downstream use

### Story 2.3: Pipeline Scheduling & Event Triggers

As the system operator,
I want pipelines to trigger on cron schedules and in response to system events,
So that automation runs at the right time without manual intervention.

**Acceptance Criteria:**

**Given** a pipeline with `trigger.type: cron` and `schedule: "0 6 * * *"`
**When** the scheduler ticks at 06:00
**Then** the pipeline execution starts automatically

**Given** a pipeline with `trigger.type: event` and `event: "email:new"`
**When** an `email:new` event is emitted on the bus
**Then** the pipeline execution starts automatically

**Given** a pipeline execution completes
**When** the result is stored
**Then** a `pipeline_runs` record is written with pipeline_name, trigger_type, status, started_at, completed_at, node_results

**Given** a pipeline is disabled (`enabled: false`)
**When** its cron time arrives or matching event fires
**Then** no execution occurs

### Story 2.4: Pipeline Retry & Error Handling

As the system operator,
I want failed pipeline steps to retry with configurable backoff and clear error reporting,
So that transient failures resolve automatically and persistent failures surface clearly.

**Acceptance Criteria:**

**Given** a pipeline step fails and `settings.retry.maxAttempts` is 3
**When** the step is retried
**Then** it retries up to 3 times with exponential backoff before marking as failed

**Given** a pipeline with `onError: stop`
**When** a step fails after all retries
**Then** the pipeline halts, status is set to `failed`, and a `pipeline:failed` event is emitted

**Given** a pipeline with `onError: continue`
**When** a step fails after all retries
**Then** remaining independent nodes continue executing and the pipeline completes with partial results

**Given** any pipeline step completes or fails
**When** the event is emitted
**Then** `pipeline:step:complete` or `pipeline:step:failed` fires with node ID, output/error, and duration

### Story 2.5: Pipeline CRUD API & Git Auto-Commit

As the system operator,
I want to manage pipelines through an API with automatic git versioning,
So that pipeline changes are accessible programmatically and reversible through git history.

**Acceptance Criteria:**

**Given** a valid pipeline YAML is PUT to `/api/pipelines/morning-briefing`
**When** the file is written
**Then** the YAML is saved to `config/pipelines/morning-briefing.yaml`, validated, and auto-committed to git

**Given** a `POST /api/pipelines/morning-briefing/trigger` request
**When** the pipeline exists and is enabled
**Then** the pipeline executes immediately as a manual trigger

**Given** a `GET /api/pipelines/morning-briefing/runs?limit=10` request
**When** execution history exists
**Then** the 10 most recent runs are returned with status, timing, and node results

**Given** the git auto-commit fails (git not available, conflict)
**When** the pipeline YAML was already written to disk
**Then** the config change applies successfully — git failure is logged but not blocking

## Epic 3: Enhanced Telegram & Mobile Command

Full life management from the phone — topic threads per domain, inline keyboard actions, voice commands via Gemini, email replies, task management, media routing, morning briefings — all via Telegram.

### Story 3.1: Telegram Group with Topic Threads

As the mobile user,
I want Raven to operate in a Telegram group with topic threads per domain,
So that conversations are organized by context instead of one noisy stream.

**Acceptance Criteria:**

**Given** Raven is configured with a Telegram group ID and topic IDs
**When** a message arrives in the "General" topic
**Then** it is routed to the orchestrator as a general query with topic context attached

**Given** a message arrives in a project-specific topic
**When** the orchestrator processes it
**Then** the project context is injected into the sub-agent prompt

**Given** Raven needs to send a system alert
**When** the alert is dispatched
**Then** it is sent to the "System" topic, not the General topic

**Given** the bot lacks admin permissions in the group
**When** topic operations fail
**Then** the error is logged and the bot falls back to non-topic messaging

### Story 3.2: Inline Keyboard Actions & Approvals

As the mobile user,
I want inline keyboard buttons for quick actions and approvals,
So that I can manage tasks and approve actions with a single tap.

**Acceptance Criteria:**

**Given** a morning briefing with overdue tasks
**When** each task is displayed
**Then** inline buttons appear: `[Complete] [Snooze 1d] [Snooze 1w] [Drop]`

**Given** the user taps "Complete" on a task
**When** the callback is processed
**Then** the task is marked complete in TickTick, the keyboard updates to show "Done ✓", and response arrives within 2 seconds

**Given** a Red-tier approval notification
**When** delivered to Telegram
**Then** inline buttons appear: `[Approve] [Deny] [View Details]`

**Given** the user taps "Approve"
**When** the callback is processed
**Then** the pending approval is resolved, the action executes, and confirmation is shown

### Story 3.3: Gemini Voice Transcription Skill

As the mobile user,
I want to send voice messages that Raven transcribes and processes as commands,
So that I can give instructions hands-free while on the go.

**Acceptance Criteria:**

**Given** a voice message is sent to Raven in Telegram
**When** the Telegram skill receives it
**Then** the audio is forwarded to a Gemini sub-agent for transcription

**Given** Gemini returns a transcription
**When** the text is received
**Then** it is processed through the orchestrator as if the user typed it

**Given** Gemini transcription takes longer than 30 seconds
**When** the timeout fires
**Then** the user receives "Couldn't transcribe that — please type your message" and no error crashes the system

**Given** the Gemini API is unavailable
**When** a voice message arrives
**Then** the skill degrades gracefully with a friendly error message to the user

### Story 3.4: Media & File Routing

As the mobile user,
I want to send photos, files, and screenshots that Raven routes to the right skill for processing,
So that I can share context without switching apps.

**Acceptance Criteria:**

**Given** a photo is sent in a project topic
**When** the Telegram skill processes it
**Then** the image is downloaded and routed to the orchestrator with topic context for skill routing

**Given** a PDF document is sent
**When** the file is received
**Then** it is downloaded, stored temporarily, and forwarded to the appropriate skill sub-agent

**Given** a file type has no matching skill handler
**When** routing fails
**Then** the user receives "I can't process this file type yet" rather than a silent failure

### Story 3.5: Morning Briefing Delivery

As the mobile user,
I want a formatted morning briefing delivered to Telegram,
So that I see my day's priorities without opening any other app.

**Acceptance Criteria:**

**Given** a morning briefing pipeline completes
**When** the compiled briefing is sent to Telegram
**Then** it arrives as a well-formatted message in the General topic with sections for tasks, emails, and system status

**Given** the briefing contains overdue tasks
**When** each task is displayed
**Then** inline action buttons are attached for quick management

**Given** the briefing contains emails needing attention
**When** each email summary is shown
**Then** it includes sender, subject, and action buttons (reply, archive, flag)

**Given** Telegram delivery fails
**When** the retry logic activates
**Then** it retries 3 times before queuing for next active period

### Story 3.6: Email Reply Composition from Telegram

As the mobile user,
I want to compose and send email replies through Raven from Telegram,
So that I can handle email without opening Gmail.

**Acceptance Criteria:**

**Given** the user sends "Reply to the client email, tell them I'll have it ready by Thursday"
**When** Raven processes the intent
**Then** a draft reply is composed and presented in Telegram with `[Send] [Edit] [Cancel]` buttons

**Given** the user taps "Send"
**When** the Gmail skill sends the email
**Then** the permission gate is checked, the email is sent, and confirmation is shown in Telegram

**Given** the user taps "Edit"
**When** the edit flow starts
**Then** the user can provide corrections and a new draft is presented

**Given** email sending is Red-tier
**When** the user taps "Send"
**Then** the action queues for approval and the user is notified it's pending

## Epic 4: Intelligent Email & Task Automation

Email auto-triaged, action items extracted into tasks, stale tasks surfaced with suggestions, urgency flagging — daily operations handled without manual intervention.

### Story 4.1: Email Auto-Triage Rules

As the system operator,
I want Gmail auto-triaged by rules that categorize, archive, and label emails,
So that only emails requiring my attention remain in my inbox.

**Acceptance Criteria:**

**Given** a newsletter email arrives
**When** the triage rules match it as a newsletter
**Then** it is archived automatically, and any action items are extracted before archiving

**Given** an email from a known important sender arrives
**When** the triage rules match the sender
**Then** it is labeled "urgent" and flagged for user review

**Given** the triage rules are configured in the Gmail skill config
**When** a new rule is added
**Then** it takes effect on the next email processing cycle without restart

**Given** the Gmail API is unavailable
**When** triage attempts to run
**Then** the skill degrades gracefully, logs the error, and retries on the next cycle

### Story 4.2: Email Action Item Extraction & Task Creation

As the system operator,
I want action items extracted from emails and turned into TickTick tasks automatically,
So that nothing falls through the cracks.

**Acceptance Criteria:**

**Given** an email contains "Please send the report by Friday"
**When** the action item extraction sub-agent processes it
**Then** a TickTick task is created: "Send the report" with due date Friday and reference to the source email

**Given** an email contains multiple action items
**When** extraction completes
**Then** each action item becomes a separate TickTick task

**Given** task creation from email is Yellow-tier
**When** tasks are created
**Then** the user is notified via Telegram: "Created 2 tasks from email: [sender] — [subject]"

**Given** the TickTick API is unavailable
**When** task creation fails
**Then** the action item is queued and retried, and the email is flagged for manual review

### Story 4.3: Autonomous Task Management

As the system operator,
I want Raven to autonomously manage TickTick tasks based on permission tiers,
So that routine task operations happen without my involvement.

**Acceptance Criteria:**

**Given** a task's priority should be updated based on context
**When** the autonomous management runs
**Then** the permission gate checks the tier for `ticktick:update-task` before executing

**Given** a Green-tier task read operation
**When** executed
**Then** task data is fetched silently with no user notification

**Given** a Yellow-tier task update
**When** executed
**Then** the update is applied and the user is notified of what changed

**Given** a Red-tier task deletion is requested
**When** the permission gate checks
**Then** the action is queued for approval and does not execute until approved

### Story 4.4: Stale Task Detection & Nudging

As the system operator,
I want Raven to surface stale tasks with AI-suggested next steps,
So that tasks don't silently rot in my backlog.

**Acceptance Criteria:**

**Given** a TickTick task has had no activity for 7 days (configurable)
**When** the stale task detection runs
**Then** the task is identified as stale and queued for nudging

**Given** a stale task is detected
**When** the nudge is generated
**Then** it includes the task title, age, and AI-suggested next steps (complete, snooze, break down, drop)

**Given** the stale task nudge is delivered to Telegram
**When** the user views it
**Then** inline buttons offer `[Do Today] [Snooze 1w] [Break Down] [Drop]`

**Given** stale task detection is configured as a pipeline step
**When** the stale-task-nudge pipeline runs on schedule
**Then** all stale tasks are processed in a single batch notification

## Epic 5: Rich Dashboard & Real-Time Monitoring

See everything Raven does — activity timeline, Kanban task board, pipeline status, live streaming agent output, execution metrics.

### Story 5.1: Polling & SSE Infrastructure Hooks

As the dashboard user,
I want real-time data refresh without page reloads,
So that the dashboard stays current as Raven works.

**Acceptance Criteria:**

**Given** a component uses `usePolling('/api/pipelines', 5000)`
**When** 5 seconds elapse
**Then** fresh data is fetched and the Zustand store updates, triggering a re-render

**Given** a component uses `useSSE('/api/agent-tasks/123/stream')`
**When** the agent produces output
**Then** `agent-output` events stream to the client with chunk data in real-time

**Given** the SSE connection drops
**When** `EventSource` detects the disconnection
**Then** it automatically reconnects and resumes streaming

**Given** the agent task completes
**When** `agent-complete` fires
**Then** the SSE connection closes cleanly and the hook notifies the component

### Story 5.2: Activity Timeline

As the dashboard user,
I want to see a chronological timeline of all autonomous Raven actions,
So that I know exactly what happened while I wasn't watching.

**Acceptance Criteria:**

**Given** Raven has processed 12 emails, updated 5 tasks, and run 2 pipelines today
**When** the user opens the activity page
**Then** all 19 events appear in reverse chronological order with timestamps, skill icons, and descriptions

**Given** the user filters by `skillName=gmail`
**When** the filter is applied
**Then** only Gmail-related activity entries are shown

**Given** new activity occurs while the page is open
**When** the polling interval triggers
**Then** new entries appear at the top without page reload

### Story 5.3: Pipeline Monitor

As the dashboard user,
I want to see pipeline execution status and health in real-time,
So that I can verify automations are running correctly.

**Acceptance Criteria:**

**Given** 3 pipelines are configured
**When** the user opens the pipelines page
**Then** all 3 are listed with name, trigger type, status, last run time, and next run time

**Given** a pipeline is currently running
**When** the page polls
**Then** the status shows an animated "running" indicator

**Given** the user clicks a pipeline
**When** the detail view opens
**Then** the last 10 executions are shown with status, duration, and per-node results

**Given** a pipeline execution failed
**When** the error details are viewed
**Then** the specific failed node, error message, and retry history are displayed

### Story 5.4: Kanban Agent Task Board

As the dashboard user,
I want a Kanban-style board showing active and completed agent tasks,
So that I can see what Raven is working on right now.

**Acceptance Criteria:**

**Given** 2 agent tasks are running and 5 completed today
**When** the user views the task board
**Then** 2 cards are in "Running" column and 5 in "Completed" column

**Given** a running task card is clicked
**When** the detail panel opens
**Then** the agent's output streams in real-time via SSE

**Given** a new task starts
**When** the board polls
**Then** a new card appears in the "Running" column

**Given** a task fails
**When** it moves to "Failed"
**Then** the card shows the error summary and the full error is viewable on click

### Story 5.5: Pipeline Chat Configuration & Execution Metrics

As the dashboard user,
I want to configure pipelines via chat with YAML preview and view execution metrics,
So that I can create automations conversationally and track system performance.

**Acceptance Criteria:**

**Given** the user describes a pipeline in the chat panel
**When** Raven generates the YAML
**Then** a formatted YAML preview is shown with `[Save] [Edit] [Cancel]` actions

**Given** the user clicks "Save" on a pipeline preview
**When** the pipeline is PUT to the API
**Then** it is validated, saved to disk, and git-committed

**Given** the user navigates to execution metrics
**When** the metrics load
**Then** they show total tasks run, success rate, average duration, and per-skill breakdown for the selected time period

## Epic 6: Knowledge System

Store, ingest, organize, and retrieve knowledge. Raven remembers context from weeks ago and injects it into agent tasks automatically.

### Story 6.1: Knowledge Bubble Storage & CRUD

As the system operator,
I want to store information as knowledge bubbles with searchable metadata,
So that Raven has persistent, structured memory beyond conversation context.

**Acceptance Criteria:**

**Given** the user stores a knowledge bubble with title "SQLite Backup Strategies" and tags ["database", "ops"]
**When** the bubble is created
**Then** a markdown file is written to `data/knowledge/`, metadata is stored in SQLite, and the bubble is queryable

**Given** a search query for tag "database"
**When** `/api/knowledge?tag=database` is called
**Then** all bubbles tagged "database" are returned with metadata and content preview

**Given** a knowledge bubble is updated
**When** the content changes
**Then** the markdown file is overwritten, `updated_at` is refreshed, and the old version is not preserved (simple overwrite)

**Given** a full-text search for "WAL mode"
**When** `/api/knowledge?q=WAL+mode` is called
**Then** bubbles containing that text in title or content are returned, ranked by relevance

### Story 6.2: Knowledge Ingestion Pipeline

As the system operator,
I want Raven to ingest text, audio, and documents into structured knowledge,
So that information is captured automatically without manual note-taking.

**Acceptance Criteria:**

**Given** a PDF document is submitted for ingestion
**When** the ingestion sub-agent processes it
**Then** key information is extracted, a knowledge bubble is created with source reference, and appropriate tags are generated

**Given** a voice memo is transcribed via Gemini
**When** the transcription is passed to ingestion
**Then** a knowledge bubble is created with the transcribed content, source "voice-memo", and AI-generated tags

**Given** plain text is submitted with a title
**When** ingestion runs
**Then** a bubble is created immediately with the provided text and auto-generated tags

**Given** ingestion is configured as a pipeline step
**When** the pipeline triggers (e.g., new file in Google Drive)
**Then** the file is processed through the ingestion sub-agent automatically

### Story 6.3: Knowledge Intelligence Engine

As the system operator,
I want knowledge bubbles to have local embeddings, hierarchical tags, knowledge domains, inter-bubble links with clear distinction from tags, permanence levels, hub bubble splitting, and embedding-based similarity operations,
So that my knowledge base self-organizes at scale with proper structure, hierarchy, and knowledge quality signals.

**Acceptance Criteria:**

**Given** a new knowledge bubble is created or updated
**When** the embedding pipeline runs
**Then** a local vector embedding is generated (via @huggingface/transformers, bge-small-en-v1.5) and stored in the database

**Given** knowledge domains are configured (e.g., "health", "finances", "work") with classification rules
**When** a new bubble is ingested
**Then** it is automatically assigned to the appropriate domain(s) — a bubble can belong to multiple domains

**Given** tags are organized in a hierarchy (domain → category → specific)
**When** a new tag is created during ingestion or suggestion
**Then** it is placed in the correct position in the tag tree, with parent-child relationships maintained

**Given** a tag subtree has many sparse tags (few bubbles each, weak content connections)
**When** tag rebalancing runs
**Then** sparse tags are merged or restructured based on content similarity of their bubbles

**Given** two related knowledge bubbles exist
**When** similarity analysis detects a strong connection (cosine similarity > threshold)
**Then** a bidirectional link is suggested — links are for specific semantic relationships between exactly two bubbles ("extends", "contradicts", "related"), while tags are for reusable categorical metadata

**Given** a knowledge bubble has 10+ direct links
**When** hub detection runs
**Then** the linked bubbles are clustered into groups, a synthesis bubble is created for each group summarizing its content, and the synthesis bubbles are linked back to the hub — creating a navigable hierarchy

**Given** a new knowledge bubble is created
**When** permanence classification runs
**Then** the bubble is assigned a permanence level: `temporary` (flagged for review), `normal` (standard), or `robust` (high-value, prioritized in retrieval) — defaulting to `normal`, adjustable by user

**Given** 2+ knowledge bubbles have high embedding similarity
**When** clustering runs (triggered via API)
**Then** they are grouped into a cluster — embeddings for grouping, LLM only for label generation

**Given** two bubbles have cosine similarity > 0.9
**When** merge detection runs
**Then** they are flagged for user review — never auto-merged

**Given** a new knowledge bubble is created
**When** auto-tagging runs
**Then** relevant tags are suggested from the hierarchical tag tree based on embedding similarity to existing bubbles — no LLM needed

### Story 6.4: Knowledge Retrieval Engine & Full-Content Indexing

As the system operator,
I want all knowledge bubble content chunked, embedded, and searchable through a multi-tier retrieval pipeline supporting precise, timeline, and generic query types across multiple dimensions, with concurrent query support,
So that querying my second brain returns deeply relevant, contextually enriched results at any scale.

**Acceptance Criteria:**

**Given** a knowledge bubble has content longer than ~300 tokens
**When** the chunking engine processes it
**Then** the content is split into overlapping chunks (~300 tokens, 50 token overlap), each embedded with metadata prefix and stored in the database

**Given** the application starts
**When** the indexing check runs
**Then** any knowledge bubbles without chunk embeddings are automatically indexed (backfill), and already-indexed bubbles are skipped

**Given** a knowledge bubble is created or updated
**When** the incremental indexer runs
**Then** old chunks are removed and new chunks are generated and embedded

**Given** the user triggers `POST /api/knowledge/reindex-embeddings`
**When** the full re-index runs
**Then** all chunk embeddings are rebuilt from scratch (useful after model change), with progress tracking

**Given** a precise query like "What happened on March 5th?"
**When** the retrieval engine processes it
**Then** results are filtered by date dimension, returning specific bubbles and their references

**Given** a timeline query
**When** the user navigates forward/backward
**Then** they can traverse knowledge along dimensions: date/time, domain, source type, permanence, cluster, connection degree, recency of access, confidence

**Given** a generic query like "What do I like eating?"
**When** the multi-tier retrieval runs
**Then** results combine: (1) top-K matching chunks by vector similarity, (2) expanded to full parent bubbles, (3) linked bubbles via graph traversal, (4) cluster siblings, (5) tag hierarchy co-occurrence, (6) optional source file enrichment — all deduplicated, ranked, and summarized with references for further exploration

**Given** multiple concurrent search requests
**When** the embedding pipeline processes them
**Then** queries are handled concurrently via a shared pipeline instance with proper serialization, without blocking each other

**Given** a retrieval query with a token budget
**When** results are assembled
**Then** content is ranked to fit within budget, with provenance trail showing which tier and dimension contributed each result, and bubble references for drill-down

**Given** retrieval results reference source files
**When** source enrichment is enabled
**Then** original source content (PDFs, documents from data/media/) is available for deep-dive context

### Story 6.5: Knowledge Management Agent & Context Injection

As the system operator,
I want a dedicated knowledge management agent that can retrieve, update, organize, and inject relevant knowledge into any sub-agent's context,
So that Raven acts as my second brain — searchable, conversational, and always providing relevant context.

**Acceptance Criteria:**

**Given** the user asks Raven about a topic in their knowledge base
**When** the orchestrator routes to the knowledge agent
**Then** the agent uses the multi-tier retrieval engine to find relevant bubbles, presents organized results with references, and can update/link/tag bubbles conversationally

**Given** a sub-agent task about "SQLite backup strategies"
**When** the prompt builder prepares the prompt
**Then** relevant knowledge is retrieved by the retrieval engine and injected as context

**Given** the knowledge retrieval finds 10 relevant bubbles
**When** the token budget is 2000 tokens
**Then** only the top-ranked bubbles (by embedding similarity + recency + permanence weight) fitting within the budget are injected

**Given** no relevant knowledge exists for a task
**When** retrieval returns empty results
**Then** no knowledge section is added to the prompt (no empty placeholder)

**Given** a knowledge bubble was updated recently
**When** relevance scoring runs
**Then** recency is factored in — newer relevant bubbles rank higher; `robust` permanence bubbles get a retrieval boost

**Given** the user asks the knowledge agent to organize or link bubbles
**When** the agent processes the request
**Then** it can create/remove links, reassign domains, adjust permanence, merge bubbles, and update tags through the knowledge store API

### Story 6.6: Knowledge Lifecycle & Retrospective

As the system operator,
I want a weekly knowledge retrospective that summarizes brain changes, surfaces stale knowledge, and lets me decide what to keep, prioritize, remove, or snooze,
So that my second brain stays lean, relevant, and doesn't accumulate noise over time.

**Acceptance Criteria:**

**Given** a week has passed since the last retrospective
**When** the retrospective pipeline triggers (scheduled)
**Then** a summary is generated: new bubbles added, bubbles updated, links created, domains changed, tags reorganized — delivered via Telegram or dashboard

**Given** knowledge bubbles exist with `temporary` permanence
**When** the retrospective runs
**Then** each temporary bubble is presented for review: keep (upgrade to normal/robust), snooze (defer review for N days), or remove (delete bubble + source files from data/media/)

**Given** knowledge bubbles have not been accessed or referenced for a configurable period (e.g., 30 days)
**When** stale detection runs
**Then** stale bubbles are surfaced with options: update with fresh content, snooze (stop asking for N days), shrink (merge with related bubbles), or remove completely

**Given** the user chooses to shrink/merge stale knowledge
**When** the merge is executed
**Then** related stale bubbles are combined into a single summary bubble, old bubbles are removed, and links are re-pointed to the merged bubble

**Given** the user sets a bubble's permanence to `robust`
**When** retrieval scoring runs
**Then** robust bubbles receive a priority boost in all retrieval results and are never flagged as stale

**Given** knowledge has different permanence levels
**When** ingestion creates a new bubble
**Then** the default permanence is `normal`; the user can override via API or conversational agent; homework/transient content can be marked `temporary` immediately

### Story 6.7: Knowledge Graph Visualization

As the system operator,
I want an interactive knowledge graph visualization similar to Obsidian, where I can explore, query, filter, and modify my knowledge visually,
So that I can understand the structure of my second brain and interact with it spatially.

**Acceptance Criteria:**

**Given** the knowledge graph page loads
**When** the visualization renders
**Then** knowledge bubbles appear as interactive nodes with connections (links) as edges, supporting pan, zoom, and click for detail

**Given** the user clicks a node
**When** the detail panel opens
**Then** it shows the full bubble content, tags, domain, permanence, links, cluster membership, and source file (with file opening capability)

**Given** multiple view dimensions exist
**When** the user switches view mode
**Then** the graph re-renders for: direct link connections, tag hierarchy connections, timeline (chronological layout), cluster grouping, or domain grouping

**Given** nodes have varying properties
**When** color coding is applied
**Then** nodes are colored by selectable dimension: domain, connection degree (hub vs leaf), permanence level, relevance to current query, recency, or cluster membership

**Given** the user enters a search query
**When** the multi-tier retrieval engine returns results
**Then** matched nodes are highlighted in the graph, non-matches are dimmed, and the graph centers on the result cluster

**Given** the user applies tag or dimension filters
**When** the filter is active
**Then** only matching nodes and their connections are visible; the rest are hidden

**Given** the user opens the chat panel alongside the graph
**When** they discuss knowledge ("shrink this node and surroundings", "link these two", "what connects these clusters?")
**Then** the knowledge agent executes the request and the graph updates in real-time

**Given** the user selects multiple nodes
**When** they choose a bulk action (merge, re-tag, change permanence, delete)
**Then** the action is applied and the graph re-renders with updated structure

## Epic 7: Proactive Intelligence & Friend Protocol

Raven proactively surfaces insights, manages notification urgency tiers, throttles based on engagement patterns, and respects attention with category snooze and silence-aware delivery.

### Story 7.1: Background Pattern Analysis Engine

As the system operator,
I want Raven to analyze patterns across all connected services in the background,
So that insights surface without me having to ask.

**Acceptance Criteria:**

**Given** the pattern analysis runs on schedule
**When** it detects that 4 meetings this week have zero deep work blocks
**Then** an insight is generated: "Heavy meeting week with no deep work — consider blocking Thursday morning"

**Given** a pattern is detected with low confidence
**When** the confidence score is below threshold
**Then** the insight is stored but not queued for delivery

**Given** the analysis runs across Gmail, TickTick, and calendar data
**When** a cross-service pattern is found (e.g., emails about a topic correlate with overdue tasks)
**Then** the insight references both services with specific data points

**Given** the same pattern was already surfaced this week
**When** duplicate detection runs
**Then** the duplicate is suppressed to avoid nagging

### Story 7.2: Urgency Tier Classification & Delivery Timing

As the system operator,
I want all outbound notifications classified by urgency and delivered at the right time,
So that important things reach me fast and routine things wait for the right moment.

**Acceptance Criteria:**

**Given** a Red-tier action requires approval
**When** the notification is classified
**Then** it is `tell-now` and delivered immediately regardless of time

**Given** a Yellow-tier action completion report
**When** the notification is classified
**Then** it is `tell-when-active` and held until the user's next interaction or active hours

**Given** routine status updates (pipeline completions, email triage summaries)
**When** classified
**Then** they are `save-for-later` and batched into the next morning briefing

**Given** it is 2am and a `tell-when-active` notification is queued
**When** delivery timing checks user activity
**Then** the notification is held until morning (configurable active hours)

### Story 7.3: Engagement-Based Throttling

As the system operator,
I want Raven to throttle notifications based on my engagement patterns,
So that I'm not overwhelmed when I'm busy or disengaged.

**Acceptance Criteria:**

**Given** the user has not responded to the last 5 notifications
**When** the engagement tracker detects low engagement
**Then** notification frequency is reduced — only `tell-now` items are delivered, others batch

**Given** a throttled notification is high-priority and unacknowledged for 4 hours
**When** the escalation timer fires
**Then** it is re-delivered with a brief "Reminder:" prefix

**Given** a proactive insight was delivered and the user didn't respond
**When** the next analysis cycle runs
**Then** the insight is marked as "seen/dismissed" — no follow-up is sent

**Given** the user resumes active engagement (responds to 3+ messages)
**When** the engagement tracker updates
**Then** normal notification frequency resumes

### Story 7.4: Category Snooze & Notification Preferences

As the system operator,
I want to snooze entire notification categories and have Raven suggest snoozes for noisy categories,
So that I control what reaches me without per-notification management.

**Acceptance Criteria:**

**Given** the user snoozes "pipeline-status" for 1 day
**When** pipeline completion notifications are generated
**Then** they are silently batched and not delivered until the snooze expires

**Given** the user has ignored 10 consecutive "task-updates" notifications
**When** the system detects the pattern
**Then** it proposes via Telegram: "You've been ignoring task updates — snooze for a week?" with `[Snooze 1w] [Keep] [Mute]`

**Given** an "approvals" category notification arrives while that category is snoozed
**When** delivery is attempted
**Then** approvals are NEVER snoozable — they always deliver (safety override)

**Given** the user queries active snoozes
**When** `/api/notifications/snooze` GET is called
**Then** all active snoozes are returned with category, expiry time, and notification count held

## Epic 8: Expanding Integrations

Google Drive file monitoring, financial transaction tracking, spending categorization, anomaly alerts, calendar defense, meeting prep — more of digital life automated.

### Story 8.1: Google Drive File Monitoring & Processing

As the system operator,
I want Raven to monitor Google Drive folders and process new files automatically,
So that documents are ingested without manual uploads.

**Acceptance Criteria:**

**Given** a new PDF is uploaded to a monitored Google Drive folder
**When** the folder watcher detects it
**Then** a `gdrive:new-file` event is emitted with file metadata

**Given** a `gdrive:new-file` event fires
**When** a pipeline is configured to trigger on this event
**Then** the file is downloaded and processed through the configured pipeline steps

**Given** the Google Drive API is unavailable
**When** the watcher attempts to poll
**Then** the skill degrades gracefully, logs the error, and retries on the next interval

**Given** the monitored folder config is updated
**When** the config reloads
**Then** the watcher adjusts to monitor the new folder set without restart

### Story 8.2: Financial Transaction Tracking & Categorization

As the system operator,
I want Raven to track bank transactions and categorize spending automatically,
So that I have financial visibility without manual bookkeeping.

**Acceptance Criteria:**

**Given** new transactions appear in the bank account
**When** the transaction sync runs
**Then** each transaction is fetched, stored, and categorized by the AI sub-agent

**Given** a transaction for "Silpo 142.50 UAH"
**When** categorization runs
**Then** it is categorized as "Groceries" with the original description preserved

**Given** a week of transactions is complete
**When** the weekly summary generates
**Then** a spending breakdown by category is created and available via API and knowledge system

**Given** the bank API returns an error
**When** the sync fails
**Then** the skill logs the error, retries on next cycle, and does not lose previously synced data

### Story 8.3: Financial Anomaly Detection, Calendar Defense & Meeting Prep

As the system operator,
I want Raven to alert on spending anomalies, protect deep work time, and prepare meeting briefings,
So that finances, focus, and meetings are all managed proactively.

**Acceptance Criteria:**

**Given** a transaction of 5000 UAH at an unknown merchant
**When** anomaly detection runs
**Then** an alert is delivered to Telegram: "Unusual transaction: 5000 UAH at [merchant] — [Review] [Dismiss]"

**Given** the user's week has 6 meetings and zero deep work blocks
**When** the calendar defense agent analyzes
**Then** it suggests: "Block Thursday 9-12 for deep work?" with `[Block it] [Skip]`

**Given** the user approves a deep work block
**When** the calendar skill creates it
**Then** the permission gate checks `calendar:create-event` tier and the block is created

**Given** a meeting is scheduled for tomorrow
**When** the meeting prep sub-agent runs
**Then** a briefing is compiled from knowledge bubbles, recent communications with attendees, and the meeting agenda

## Epic 9: Deep Knowledge & Intelligence

Visual knowledge graph with relationship detection, cross-domain correlation engine, knowledge gap detection, and learning track suggestions. Uses Obsidian-style file index — relationships stored in markdown frontmatter, in-memory graph index cached to JSON. No SQL tables for graph relationships.

### Story 9.1: Cross-Domain Connection Detection

As the system operator,
I want Raven to detect connections between knowledge nodes across different domains,
So that non-obvious relationships surface insights I wouldn't find myself.

**Storage approach:** Obsidian-style file index. Relationships are stored as frontmatter `connections:` arrays and `[[wikilinks]]` within knowledge bubble markdown files. An in-memory graph index is built on startup by scanning files and cached to `data/knowledge/graph-index.json` for fast reload. No SQL tables for relationships — the markdown files are the source of truth.

**Acceptance Criteria:**

**Given** a knowledge bubble about "saga pattern in event-driven architecture" and another about "Raven pipeline cross-skill coordination"
**When** the connection detection sub-agent runs
**Then** a relationship is written to both bubbles' frontmatter `connections:` array with type, target, confidence, and description

**Given** a new knowledge bubble is ingested
**When** the post-ingestion analysis runs
**Then** it is compared against existing bubbles, new connections are written to frontmatter, and the in-memory graph index is updated

**Given** a high-confidence cross-domain connection is found
**When** it is novel (not previously surfaced)
**Then** it is queued as a proactive insight for delivery

**Given** a low-confidence connection is detected
**When** confidence is below threshold
**Then** the connection is stored in frontmatter but not surfaced as an insight

### Story 9.2: Visual Knowledge Graph Explorer

As the dashboard user,
I want to explore a visual graph showing knowledge relationships,
So that I can navigate my knowledge base spatially and discover connections.

**Acceptance Criteria:**

**Given** the knowledge system contains 50 bubbles with 30 relationships
**When** the user opens the knowledge explorer
**Then** a graph renders with nodes colored by cluster and edges showing relationship types

**Given** the user clicks a knowledge node
**When** the detail panel opens
**Then** the bubble's content, tags, connections, and source are displayed

**Given** the user filters by tag "architecture"
**When** the filter is applied
**Then** only architecture-tagged nodes and their direct connections are shown

**Given** the user searches for "SQLite"
**When** a matching node is found
**Then** the graph centers on that node and highlights its neighborhood

### Story 9.3: Knowledge Gap Detection & Learning Tracks

As the system operator,
I want Raven to identify gaps in my knowledge and suggest learning tracks,
So that I can systematically grow in areas I care about.

**Acceptance Criteria:**

**Given** the knowledge graph has many bubbles about "event-driven architecture" but none about "saga pattern" despite references
**When** gap detection runs
**Then** "saga pattern" is identified as a knowledge gap linked to the user's active interest area

**Given** a knowledge gap is identified
**When** a learning track is generated
**Then** it suggests 3-5 specific resources or topics to explore, ordered by relevance

**Given** a learning track suggestion is delivered to Telegram
**When** the user views it
**Then** inline buttons offer `[Start Learning] [Save for Later] [Not Interested]`

**Given** the user marks a gap as "Not Interested"
**When** future gap detection runs
**Then** that gap is suppressed from future suggestions

## Epic 10: Self-Extending System

Raven builds its own skills from conversation descriptions, suggests pipelines from detected patterns, enables conversational pipeline creation, and provides full config version management with selective revert.

### Story 10.1: Conversational Pipeline Creation & Pattern-Based Suggestions

As the system operator,
I want to create pipelines through natural language and have Raven suggest pipelines from detected patterns,
So that automation grows organically from how I actually work.

**Acceptance Criteria:**

**Given** the user says "Create a pipeline that checks my email every hour and creates tasks from urgent ones"
**When** the pipeline creation sub-agent processes it
**Then** a valid YAML pipeline is generated with cron trigger, Gmail + TickTick nodes, and presented for review

**Given** the user has manually triaged emails and created tasks 5 times this week
**When** the pattern detection engine analyzes
**Then** it suggests: "I noticed you're manually triaging emails → tasks. Want me to automate this?" with a draft pipeline

**Given** the user approves a suggested pipeline
**When** "Create" is tapped
**Then** the YAML is saved to `config/pipelines/`, validated, and git-committed

**Given** the user says "Tweak" on a suggestion
**When** the edit flow starts
**Then** the user can describe modifications and a revised YAML is generated

### Story 10.2: Skill Scaffolding from Conversation

As the system operator,
I want Raven to scaffold new skill boilerplate from a conversation description,
So that adding new integrations is a conversation, not a coding session.

**Acceptance Criteria:**

**Given** the user says "Add a monobank skill that tracks transactions"
**When** the scaffolding sub-agent processes it
**Then** a complete skill package is generated at `packages/skills/skill-monobank/` following all project conventions

**Given** the generated skill
**When** the code is reviewed
**Then** it extends `BaseSkill`, declares MCP servers, defines action permissions, and follows kebab-case file naming

**Given** the user approves the generated code
**When** it is committed
**Then** the workspace is added to root `package.json`, the skill compiles with `npm run build`, and it loads in the skill registry

**Given** the user requests changes to the generated skill
**When** modifications are described
**Then** the sub-agent updates the code accordingly and re-presents for review

### Story 10.3: Config Version Management & Life Dashboard

As the system operator,
I want to view and revert git-committed config changes and see a unified life dashboard,
So that I have full control over system configuration and complete visibility into all activity.

**Acceptance Criteria:**

**Given** 5 config changes have been git-committed
**When** the user views config history
**Then** each change shows timestamp, description, and diff preview

**Given** the user wants to revert a specific permissions.json change
**When** they select revert on that commit
**Then** a git revert is executed for that file, the config reloads, and the change is confirmed

**Given** the user opens the life dashboard homepage
**When** the page loads
**Then** it shows: today's autonomous actions count, active pipelines status, pending approvals count, latest insights, system health, and upcoming events

**Given** any dashboard section has actionable items
**When** the user clicks through
**Then** they navigate to the relevant detailed page (activity, pipelines, permissions, etc.)
