---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
inputDocuments:
  - '_bmad-output/project-context.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-03-03-session.md'
  - 'docs/GOOGLE_OAUTH_SETUP.md'
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 1
  projectDocs: 2
classification:
  projectType: 'Platform (Web App + API + Bot hybrid)'
  domain: 'Personal Productivity / AI Automation'
  complexity: 'Medium-High'
  projectContext: 'brownfield'
workflowType: 'prd'
---

# Product Requirements Document — Raven

**Author:** User
**Date:** 2026-03-03

## Executive Summary

Raven is a proactive, context-aware Life Operating System built for a single power user. It connects every facet of digital life — tasks, email, calendar, knowledge, finances, health, development projects, and personal relationships — through one intelligent orchestration layer that acts autonomously on the user's behalf.

The core problem Raven solves is digital fragmentation: information and actions are scattered across dozens of tools and services with no unified brain connecting them. Rather than requiring manual input or file uploads, Raven accesses systems directly through MCP integrations and API connections, maintaining always-current context without user effort. It uses Claude Code as its agentic execution engine — inheriting world-class reasoning, tool use, and multi-step execution — while the Raven orchestrator handles routing, context injection, trust enforcement, and memory.

The system shifts from reactive (wait for commands) to proactive (surface insights, nudge on stale tasks, detect patterns, suggest automation). It operates with maximum autonomy within a system-enforced permission model (Green/Yellow/Red trust tiers), minimizing interruptions while maintaining safety for irreversible actions.

Raven is a brownfield evolution. The working core exists today: orchestrator, event bus, agent spawner, skill plugin system (TickTick, Gmail, Telegram, digest), web dashboard, and Docker deployment. This PRD defines the full evolution roadmap — from Permission Gates and pipeline automation through knowledge systems, proactive intelligence, rich visualization, and self-extending automation.

### What Makes This Special

- **Context without friction** — MCP-based integrations give agents direct access to the user's systems. No file uploads, no copy-paste, no manual context-building.
- **Claude Code as leverage** — All intelligence delegated to Claude Code subprocesses. The orchestrator routes intent, injects context, and enforces trust. No custom agentic framework to build or maintain.
- **Proactive intelligence** — Raven surfaces insights, stale tasks, and patterns without being asked. The shift from reactive to proactive is what makes this a life operating system, not a chatbot.
- **Single-user depth** — Built for one person's entire life, not a market. Maximum depth, zero multi-tenant compromises.
- **System-enforced trust** — Permission tiers are code-level gates, not LLM judgment calls. Reversibility determines autonomy level.

## Project Classification

| Attribute | Value |
|---|---|
| **Project Type** | Platform (Web App + API + Bot hybrid) |
| **Domain** | Personal Productivity / AI Automation |
| **Complexity** | Medium-High |
| **Project Context** | Brownfield — working core exists, evolving toward full vision |
| **Target Users** | Single power user (the builder) |
| **Primary Channels** | Telegram (mobile), Web Dashboard (desktop), Scheduled Pipelines (autonomous) |
| **AI Engine** | Claude Code via @anthropic-ai/claude-code SDK |
| **Persistence** | SQLite + filesystem, git-backed configuration |

## Success Criteria

### User Success

- **Laptop-free task management** — Manage tasks, review progress, and give instructions entirely from Telegram on mobile. The laptop becomes optional for routine management.
- **Passive involvement** — Raven executes multi-step workflows from high-level instructions. The user provides intent and playbook, not step-by-step directions.
- **No more orchestration tax** — The user stops being the person who pastes documents between tools, asks follow-up questions, and coordinates outputs. Raven does that.
- **Time reclamation** — Measurable reduction in time spent on digital coordination. More hours available for non-technology life.
- **Results, not questions** — Raven delivers outcomes, feedback, and suggestions. When it does need input, it batches requests and asks only what it truly can't resolve alone.

### Business Success

This is a personal project, not a commercial product. Success is measured in personal utility:

- **3-month milestone:** Daily active use from mobile. TickTick tasks managed autonomously. Morning briefings arrive. Gmail processed without manual triage. User intervenes less than once per day on routine operations.
- **6-month milestone:** Knowledge system compounds — Raven remembers past decisions and context. Pipeline automations handle recurring workflows. Proactive suggestions surface genuinely useful insights weekly.
- **12-month milestone:** Digital twin operational — high-level instructions produce complete results across multiple domains (tasks, email, finances, research, development). The user spends meaningfully less time on digital coordination than before Raven.

### Technical Success

- **Autonomous execution** — Permission gates enable Green/Yellow tier actions without interruption. Red tier batched into minimal approval requests.
- **Context injection quality** — Sub-agents receive the right context for their task without bloating. Knowledge layer provides relevant history on demand.
- **Reliability** — Scheduled pipelines execute consistently. Failed tasks surface clearly, don't fail silently. System self-monitors and degrades gracefully.
- **Extensibility** — New skills plug in without modifying core. New integrations follow the established pattern. Adding a new service takes hours, not days.

### Measurable Outcomes

| Metric | Baseline (Today) | Target |
|---|---|---|
| Daily manual orchestration time | High (user is the coordinator) | Minimal (Raven coordinates) |
| Permission interruptions per day | N/A (no gates yet) | < 2 for routine operations |
| Mobile-only management capability | None | Full task + briefing + instruction flow |
| Autonomous task completions per week | 0 | 20+ (across all skills) |
| Proactive useful insights per week | 0 | 3-5 |
| Time from instruction to result (routine tasks) | Manual multi-step | Single message → result |

## Product Scope & Phased Development

### MVP Strategy

**MVP Approach:** Platform MVP — establish the trust and automation foundation that makes all future features safe and useful. Without permission gates, Raven can't act autonomously. Without pipelines, Raven can't be proactive. Without enhanced Telegram, you can't control it from your phone. These three capabilities together flip Raven from "chatbot you talk to at your desk" to "assistant that works for you all day."

**Resource Requirements:** Solo developer (the user), Claude Code as development accelerator. No team scaling needed — the architecture is designed for incremental solo development.

### MVP Feature Set (Phase 1-2: Trust + Daily Value)

**Core Journeys Supported:**
- Journey 1 (Mobile Commander) — morning briefings, inline keyboards, voice-to-intent, task management from phone
- Journey 3 (Autopilot) — scheduled pipelines, email auto-triage, automatic task creation, overnight execution
- Journey 4 (Builder) — permission configuration, skill enablement, pipeline setup

**Must-Have Capabilities:**

| Capability | Rationale |
|---|---|
| Permission Gate System | Trust unlock — without this, nothing runs autonomously |
| Retrofit existing skills with `getActions()` | TickTick, Gmail, Telegram, digest must all declare permission tiers |
| Action allowlist config (`config/permissions.json`) | User-controllable tier overrides per skill action |
| Gate enforcement in agent spawner | Code-level middleware, not prompt-based |
| Audit logging | Every gated action logged — trust through transparency |
| Pipeline engine (YAML configs) | Automation backbone — cron + event triggers |
| Git-tracked pipeline configs | Reversibility and history for all automation changes |
| Telegram group with topics | Per-domain/project conversation threads |
| Telegram inline keyboards | One-tap approvals, task actions, pipeline triggers |
| Voice messages via Gemini | Voice-to-text-to-intent from mobile |
| Morning briefing pipeline | The flagship daily-value automation |
| Stale task nudge pipeline | Proactive task management |

**Explicitly NOT in MVP:**
- Knowledge layer (Phase 3)
- Proactive intelligence / Friend Protocol (Phase 4)
- Rich dashboard views beyond current (Phase 5)
- Knowledge graph (Phase 6)
- New integrations beyond existing 4 skills (Phase 7)
- Self-scaffolding / overnight builder (Phase 8)
- Calendar, Google Drive, and finance integrations

**Success gate:** User manages daily tasks from phone, morning briefing arrives automatically, TickTick and Gmail operate with minimal manual intervention.

### Growth Features (Phase 3-5: Knowledge + Intelligence + Visualization)

- Knowledge bubble storage (markdown + SQLite metadata) and retrieval
- Ingestion pipeline (text, audio, documents → process → store)
- Auto-clustering, tagging, and retrieval sub-agent for context injection
- Friend Protocol (urgency tiers, category snooze, silence-aware throttling)
- Proactive pattern analysis across services
- Kanban agent task board, activity timeline, pipeline monitor
- Life dashboard homepage and knowledge explorer
- Google Drive file monitoring and auto-processing

**Success gate:** Raven remembers context from weeks ago, proactively surfaces useful insights, and the web dashboard provides full system visibility.

### Vision Features (Phase 6-8: Deep Intelligence + Self-Extension)

- Full knowledge graph with relationship detection and visual explorer
- Cross-domain correlation engine (health ↔ productivity ↔ habits)
- Knowledge gap detection and learning track suggestions
- Finance (bank APIs, spending tracking, anomaly alerts), calendar (time blocking, defense agent), scientific writing integrations
- Conversational pipeline creation and proactive pipeline suggestion
- Self-scaffolding skill integrations (Raven builds its own new skills)
- Overnight Builder pattern (describe a project → wake up to results)

**Success gate:** Raven is a genuine digital twin — handles any domain from high-level instruction, discovers insights autonomously, and extends its own capabilities.

### Risk Mitigation Strategy

**Technical Risks:**

| Risk | Mitigation |
|---|---|
| Permission gate retrofit breaks existing skills | Each skill retrofitted independently with tests. Green tier for all current read operations — behavior unchanged. Roll out one skill at a time. |
| Pipeline engine complexity creep | Start with simple YAML + cron only. Event triggers added after cron is stable. No visual builder until Phase 8. |
| Gemini API reliability for voice | Graceful degradation — if transcription fails, user sees "couldn't transcribe, please type." Not a blocker for any other functionality. |
| Telegram topics require group migration | Test with a fresh group first. Document migration path for existing bot users. |

**Resource Risks:**

| Risk | Mitigation |
|---|---|
| Solo developer bandwidth | Each phase delivers standalone value. If Phase 2 takes longer, Phase 1 (permission gates) is already useful on its own. No phase depends on completing the next. |
| Claude Code SDK breaking changes | `query()` wrapped behind internal `agentSession` interface. SDK version pinned. Changes isolated to one file. |
| Scope creep from brainstorming ideas | 100 ideas generated, but PRD phases are strict. Ideas that don't fit a phase get parked, not shoehorned in. |

## User Journeys

### Journey 1: Morning Commute — Mobile Commander

**Who:** You, on mobile, heading to work. No laptop, just Telegram.

**Opening Scene:** It's 8:15am. You're on the bus, coffee in hand. Your phone buzzes — Raven's morning briefing has arrived in Telegram. It's a concise summary: 3 TickTick tasks overdue (with suggested next steps for each), 2 emails that need attention (one from a client, one a shipping notification — Raven already labeled the shipping one and archived it), and a note that your Google Drive health doc folder has a new upload from yesterday's lab results.

**Rising Action:** You scan the briefing. The client email needs a response — you voice-message Raven: "Reply to the client email, tell them I'll have the proposal ready by Thursday, and create a TickTick task for me to draft it tomorrow afternoon." Raven confirms with an inline keyboard: `[Send reply] [Edit first] [Cancel]`. You tap Send. Done. One message, three actions.

The overdue tasks — one is stale from two weeks ago. You tap the inline button: `[Snooze 1 week] [Delegate to Raven] [Drop it]`. You drop it. The other two you bump to today with a tap.

**Climax:** A proactive insight pops up: "You've had 4 meetings this week but zero deep work blocks. Last time this happened, you missed the Friday deadline on the research paper. Want me to block Thursday morning?" You tap yes. Raven creates the calendar block and moves your low-priority tasks away from that slot.

**Resolution:** By the time you reach the office, your day is organized, the client is handled, stale tasks are triaged, and your calendar is defended — all from your phone, all in under 5 minutes. You never opened your laptop.

**Requirements revealed:** Morning briefing pipeline, Telegram inline keyboards, voice-to-intent, email reply composition, task management actions, calendar integration, proactive pattern detection, one-tap approvals.

### Journey 2: Deep Work Evening — Dashboard Operator

**Who:** You, at the desk after dinner, with the web dashboard open.

**Opening Scene:** You open Raven's dashboard to check on the day's activity. The timeline feed shows everything Raven did autonomously: 12 emails processed (8 archived, 3 labeled for review, 1 flagged urgent), 5 TickTick tasks updated, the morning briefing sent, and a failed pipeline that couldn't reach the TickTick API at 2pm (auto-retried successfully at 2:05pm).

**Rising Action:** You check the Kanban board — three agent tasks are in flight. One is a research task you kicked off this morning from Telegram: "Research the best SQLite backup strategies for production single-file databases." The agent is 80% done, currently writing the summary document. You can see its progress live.

You navigate to the pipeline configuration page. You want a new weekly pipeline: every Sunday at 9pm, Raven should review your TickTick projects, identify tasks that haven't moved in 7+ days, and send you a Telegram summary with suggested actions. You describe it in the chat panel, Raven generates the pipeline YAML, and you review it in the diff viewer before confirming. Git commits the config automatically.

**Climax:** You open the knowledge explorer. Last week you fed Raven a PDF from a conference talk and three articles about event-driven architecture. Raven clustered them into a knowledge bubble, cross-referenced with your project context, and surfaced a connection: "The saga pattern from the conference talk could solve your cross-skill coordination problem in Raven's pipeline engine." You hadn't made that connection yourself.

**Resolution:** You've reviewed the day's autonomous work, confirmed a new automation, and discovered an architectural insight — all without writing a single line of code or manually coordinating anything. The dashboard is your window into a system that's working for you even when you're not watching.

**Requirements revealed:** Activity timeline feed, Kanban agent task board, live agent progress, pipeline configuration via chat, YAML diff viewer, git-backed config, knowledge bubble clustering, cross-domain insight surfacing, pipeline health monitoring.

### Journey 3: Overnight Autopilot — Raven Solo

**Who:** Raven, operating autonomously. You're asleep.

**Opening Scene:** It's 11pm. The daily digest pipeline triggers. Raven scans Gmail for the day's unprocessed emails, categorizes them, archives newsletters (after extracting any action items), and labels the rest by urgency. Three emails become TickTick tasks automatically (Green tier — pre-approved for this pattern).

**Rising Action:** At midnight, the weekly knowledge maintenance pipeline runs. Raven reviews all knowledge bubbles created this week, identifies overlapping content, merges duplicates, and updates the tag index. One bubble from a voice memo you recorded while driving has low transcription confidence — Raven flags it for your review tomorrow rather than acting on uncertain data (Yellow tier — reports after acting).

At 2am, an event fires: a new file appears in your Google Drive health folder. Raven detects it's a lab report PDF. It processes the document, extracts key values, stores them as a health knowledge bubble, and compares against your previous results. One value is flagged as outside normal range. This triggers a Red tier action — Raven queues a Telegram notification for morning delivery (respecting the "tell when active" urgency tier, not waking you up) suggesting you discuss the result with your doctor.

At 6am, Raven compiles the morning briefing. It pulls together: overnight email triage results, the flagged health value (prioritized to the top), the knowledge bubble needing review, today's calendar, overdue TickTick tasks with AI-suggested next steps, and yesterday's spending summary from monobank. The briefing is ready before your alarm goes off.

**Resolution:** You wake up to a single, well-organized Telegram message. Eight hours of autonomous work — email triage, knowledge maintenance, health monitoring, financial tracking, and briefing compilation — all happened without a single human interaction. The only thing that needs your attention is the health flag, and Raven made sure it's the first thing you see.

**Requirements revealed:** Scheduled pipeline execution, email auto-triage rules, automatic task creation from email, knowledge maintenance pipelines, Google Drive file watchers, health document processing, urgency tier delivery timing, Red tier notification queuing, morning briefing compilation, multi-source aggregation, silence-aware delivery.

### Journey 4: Evolution Day — System Builder

**Who:** You, adding a new integration to Raven.

**Opening Scene:** You've decided to add monobank (Ukrainian bank) integration. You want Raven to track spending, categorize transactions, and alert on anomalies. You open your laptop and tell Raven via web chat: "I want to add monobank as a new skill. Here's their API docs." You paste a link.

**Rising Action:** Raven's development sub-agent (using Claude Code with filesystem MCP) scaffolds the new skill: `packages/skills/skill-monobank/`. It creates the package.json, tsconfig, the `RavenSkill` implementation with `getMcpServers()` and `getAgentDefinitions()`, and a basic transaction-fetching sub-agent. It follows the existing skill patterns it knows from the project context — `.ts` extensions, Pino logging, Zod validation, proper BaseSkill extension.

You review the generated code in the dashboard diff viewer. Two small adjustments needed: the transaction categorization prompt needs Ukrainian hryvnia formatting, and you want the anomaly threshold set higher. You make the changes, Raven commits them.

**Climax:** You configure the permission tiers for the new skill in `config/permissions.json`: reading transactions is Green (auto), categorization is Green, but any spending alerts that trigger TickTick task creation are Yellow (act and report). Transferring money (if you ever add that) is Red (always ask). You enable the skill in `config/skills.json` and restart. The skill loads, registers its sub-agents, and the first transaction sync runs within seconds.

**Resolution:** In under an hour, you've gone from "I want bank integration" to a working skill that syncs transactions, categorizes spending, and will alert on anomalies — all following established patterns, with proper trust tiers, and fully integrated into the existing event bus and orchestrator. No core code was modified. The skill is an isolated plugin, exactly as the architecture intended.

**Requirements revealed:** Skill scaffolding assistance, project context awareness for code generation, skill configuration UI, permission tier configuration per skill, diff viewer for code review, git-backed config changes, hot-reload or simple restart for new skills, skill pattern enforcement, skill isolation verification.

### Journey Requirements Summary

| Capability Area | Journey 1 (Mobile) | Journey 2 (Dashboard) | Journey 3 (Autopilot) | Journey 4 (Builder) |
|---|---|---|---|---|
| Telegram inline keyboards | **Primary** | | | |
| Voice-to-intent | **Primary** | | | |
| Morning briefing pipeline | **Primary** | | **Primary** | |
| One-tap task management | **Primary** | | | |
| Calendar integration | **Primary** | | | |
| Activity timeline | | **Primary** | | |
| Kanban agent board | | **Primary** | | |
| Pipeline configuration | | **Primary** | | |
| Knowledge explorer | | **Primary** | | |
| Git-backed config | | **Primary** | | **Primary** |
| Scheduled pipelines | | | **Primary** | |
| Email auto-triage | | | **Primary** | |
| Event-triggered processing | | | **Primary** | **Primary** |
| Urgency-aware delivery | **Primary** | | **Primary** | |
| Permission gate enforcement | **Primary** | | **Primary** | **Primary** |
| Skill scaffolding | | | | **Primary** |
| Diff viewer / code review | | **Primary** | | **Primary** |
| Proactive intelligence | **Primary** | **Primary** | **Primary** | |

## Innovation & Novel Patterns

### Detected Innovation Areas

**1. Claude Code as Execution Substrate**
Raven does not build an agentic framework. It delegates all reasoning, tool use, and multi-step execution to Claude Code subprocesses. The orchestrator is a routing and context layer, not a reasoning engine. This architecture is lighter than framework-based approaches (LangChain, AutoGen), inherits all future Claude Code improvements automatically, and avoids the complexity of maintaining a custom agent runtime. The trade-off: execution depends entirely on Claude Code's availability and capabilities.

**2. MCP-Native Integration Architecture**
Skills declare MCP servers rather than building custom API clients. Sub-agents interact with external services through MCP tool interfaces, making new integrations a configuration problem rather than a coding problem. As the MCP ecosystem expands, Raven's integration surface expands with zero code changes.

**3. Code-Level Autonomy Gates**
Permission enforcement is system-level middleware in the agent spawner, not prompt instructions. The Green/Yellow/Red tier model is evaluated before any sub-agent is invoked. The LLM cannot reason its way past a Red gate — it's a code wall, not a suggestion. This separates trust from intelligence, which is critical for a system that acts while you sleep.

**4. Proactive-First with Attention Respect**
The interaction paradigm is inverted: Raven initiates, the user engages optionally. The Friend Protocol (urgency tiers, category snooze, silence-aware throttling, time-of-day awareness) ensures proactiveness doesn't become annoyance. Insights queue until the right moment. No response to a suggestion means "acknowledged" — no guilt, no follow-ups.

**5. Single-User Depth Over Multi-User Breadth**
Designed for one person's complete digital life. This enables hard-coded assumptions about workflow, preferences, and context that would be impossible in a multi-user product. No role-based access control, no tenant isolation, no feature flags for personas — just maximum depth for one human.

### Validation Approach

| Innovation | Validation Method | Success Signal |
|---|---|---|
| Claude Code as substrate | Run real multi-step tasks through sub-agents | Tasks complete reliably without custom agentic code |
| MCP-native integrations | Add a new service using only MCP config | New skill works without writing API client code |
| Code-level autonomy gates | Attempt to bypass Red tier via prompt | Gate holds — action blocked regardless of prompt |
| Proactive-first interaction | Run proactive suggestions for 2 weeks | User engages with >30% of surfaced insights |
| Single-user depth | Daily use for 1 month | Net time saved vs. manual coordination |

### Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Claude Code API changes break sub-agent interface | High — all execution depends on it | Pin SDK version, abstract query() behind internal interface, monitor changelogs |
| MCP ecosystem doesn't grow as expected | Medium — limits integration speed | Skills can fall back to custom API code while maintaining MCP interface shape |
| Permission gates too restrictive (user bypasses them) | Medium — undermines trust model | Progressive trust unlocking, easy tier promotion, audit trail for review |
| Proactive suggestions become noise | High — user disables the feature | Friend Protocol filters as first-class feature, category snooze, easy global mute |
| Single-user architecture prevents sharing | Low — not a goal | Delegated access (Phase 7+) if ever needed, but not a priority |

## Platform-Specific Requirements

### Project-Type Overview

Raven is a three-interface platform: Telegram bot (primary daily driver), Next.js web dashboard (monitoring and configuration), and Fastify REST API (internal backbone). All three share the same core: orchestrator, event bus, agent spawner, skill registry, and SQLite persistence. The system is single-user, self-hosted, with no external API consumers.

### Web Dashboard Architecture

- **SPA-only** — Pure client-side Next.js, no SSR/SEO requirements. Single-user tool, not discoverable.
- **Data refresh strategy:**
  - Kanban board and activity feeds: periodic HTTP polling (configurable interval, default 5s)
  - Agent output streaming: HTTP streaming (Server-Sent Events or chunked response) — no WebSocket required for this
  - WebSocket reserved for real-time notifications and chat only (already implemented)
- **Key views (by phase):**
  - MVP: Chat interface, skill status, schedule management (already exists)
  - Growth: Kanban agent task board, activity timeline, pipeline monitor, knowledge explorer
  - Vision: Life dashboard homepage, visual graph explorer, diff viewer, commit history

### API Architecture

- **Internal-only** — API serves the web dashboard and Telegram bot. No external consumers, no public documentation needed.
- **No rate limiting** — Single-user system, no abuse vector. If runaway pipelines become an issue, solve with pipeline concurrency limits, not API throttling.
- **Existing endpoints** preserved: health, projects, sessions, chat, skills, schedules, events
- **New endpoints needed by phase:**
  - MVP: Permission gates config CRUD, pipeline config CRUD, audit log retrieval
  - Growth: Knowledge bubble CRUD, search and retrieval, agent task board state, pipeline execution history
  - Vision: Knowledge graph queries, integration scaffolding triggers, pipeline builder API

### Telegram Bot Architecture

- **Group with topics** (priority) — One Telegram group with topic threads per domain/project:
  - General: quick queries, briefings, approvals
  - Per-project topics: project-specific conversations and notifications
  - System: health alerts, error notifications, audit reports
- **Inline keyboards** — Quick-action buttons for approvals, task management, and pipeline triggers
- **Voice messages** — Transcription via Google Gemini API, then processed as text intent through the orchestrator
- **Media handling** — Photos, files, and screenshots routed to appropriate skill sub-agents for processing

### Skill Integration Contract

The `RavenSkill` interface is the core contract. This PRD formalizes its requirements:

**Mandatory skill contract:**
- `getManifest()` — Skill metadata: name, version, description, capabilities list
- `getMcpServers()` — MCP server declarations (lazy-loaded, only spawned with sub-agents)
- `getAgentDefinitions()` — Sub-agent definitions with scoped prompts, tools, and MCP bindings
- `initialize(context)` — Receives `DatabaseInterface`, logger, config, event bus reference
- `shutdown()` — Graceful cleanup

**Permission contract (new — MVP):**
- Each skill action declared with a default permission tier (Green/Yellow/Red)
- Actions enumerated in skill manifest: `getActions(): SkillAction[]`
- Each action: `{ name, description, defaultTier, reversible: boolean }`
- Tier overrides stored in `config/permissions.json`, not in skill code

**Event contract:**
- Skills emit events to the bus via `context.eventBus.emit()`
- Skills register handlers for events they care about
- Cross-skill communication only through events or orchestrator-composed sub-agent chains — never direct skill imports

**Isolation rules:**
- No skill imports another skill
- No skill accesses the database outside `context.db`
- No skill loads MCP servers into the orchestrator — MCPs only travel with sub-agents
- Each skill is an independent npm workspace with its own `package.json` and `tsconfig.json`

### Implementation Considerations

- **Build order** remains: `@raven/shared` → `@raven/core` → skills → `@raven/web`
- **Gemini API integration** needed for voice transcription — either as a shared utility in `@raven/shared` or as part of the Telegram skill
- **Telegram group topics** require bot admin permissions in the group — setup documented in deployment guide
- **HTTP streaming for agent output** — Fastify supports chunked transfer encoding; consider SSE for dashboard compatibility with `EventSource` API
- **Pipeline configs** git-tracked — changes auto-committed when modified through API or dashboard

## Functional Requirements

### Trust & Autonomy

- **FR1:** User can assign a permission tier (Green/Yellow/Red) to any skill action [MVP]
- **FR2:** System enforces permission tiers at the agent spawner level before any sub-agent execution [MVP]
- **FR3:** Green-tier actions execute without any user notification or approval [MVP]
- **FR4:** Yellow-tier actions execute and report results to the user after completion [MVP]
- **FR5:** Red-tier actions queue for explicit user approval before execution [MVP]
- **FR6:** System batches multiple pending Red-tier approvals into a single approval request [MVP]
- **FR7:** User can review a complete audit trail of all gated actions with timestamps and outcomes [MVP]
- **FR8:** Each skill declares its available actions with default permission tiers and reversibility flags [MVP]
- **FR9:** User can promote or demote permission tiers for individual skills as trust is established [MVP]
- **FR10:** System defaults all undeclared actions to Red tier [MVP]

### Pipeline Automation

- **FR11:** User can define automation pipelines as YAML configuration files [MVP]
- **FR12:** System executes pipelines on cron schedules [MVP]
- **FR13:** System executes pipelines in response to events (new email, file change, task update) [MVP]
- **FR14:** Pipeline configurations are automatically git-committed on every change [MVP]
- **FR15:** User can view pipeline execution history and status [MVP]
- **FR16:** System retries failed pipeline steps with configurable retry policy [MVP]
- **FR17:** User can create pipelines through natural language conversation [Vision]
- **FR18:** System suggests new pipelines based on detected manual patterns [Vision]

### Telegram Interaction

- **FR19:** User can interact with Raven through a Telegram group with topic threads per domain/project [MVP]
- **FR20:** User can send voice messages that are transcribed via Gemini and processed as text intent [MVP]
- **FR21:** System presents inline keyboard buttons for quick actions and approvals [MVP]
- **FR22:** User can send photos, files, and screenshots for routed processing by appropriate skills [MVP]
- **FR23:** System delivers morning briefings as formatted Telegram messages [MVP]
- **FR24:** User can manage tasks (create, complete, snooze, drop) via inline keyboard taps [MVP]
- **FR25:** System respects urgency tiers for notification delivery timing (tell now / tell when active / save for later) [Growth]
- **FR26:** System detects unanswered notification categories and proposes snooze [Growth]

### Web Dashboard

- **FR27:** User can view an activity timeline of all autonomous Raven actions [Growth]
- **FR28:** User can view a Kanban-style board of active and completed agent tasks [Growth]
- **FR29:** User can monitor pipeline execution status and health in real-time [Growth]
- **FR30:** User can view streaming agent output as tasks execute [Growth]
- **FR31:** User can configure pipelines through a chat interface with YAML preview [Growth]
- **FR32:** User can view and selectively revert git-committed configuration changes [Vision]
- **FR33:** User can view a life dashboard homepage aggregating all system activity [Vision]

### Task Management

- **FR34:** System autonomously manages TickTick tasks based on permission tiers [MVP]
- **FR35:** System creates TickTick tasks from email action items automatically [MVP]
- **FR36:** System surfaces stale tasks (no activity for configurable period) with suggested next steps [MVP]
- **FR37:** User can delegate task management decisions to Raven from mobile [MVP]

### Email Processing

- **FR38:** System auto-triages Gmail by categorizing, archiving, and labeling based on configured rules [MVP]
- **FR39:** System extracts action items from emails and creates corresponding tasks [MVP]
- **FR40:** User can compose and send email replies via Raven from Telegram [MVP]
- **FR41:** System flags urgent emails based on sender and content analysis [MVP]

### Knowledge Management

- **FR42:** User can store information as knowledge bubbles (markdown + metadata) [Growth]
- **FR43:** System ingests text, audio, and documents into structured knowledge storage [Growth]
- **FR44:** System auto-clusters related knowledge bubbles and maintains tag indexes [Growth]
- **FR45:** Sub-agents can query the knowledge layer for context injection during task execution [Growth]
- **FR46:** System detects cross-domain connections between knowledge nodes [Vision]
- **FR47:** User can explore a visual knowledge graph showing relationships [Vision]
- **FR48:** System identifies knowledge gaps and suggests learning tracks [Vision]

### Proactive Intelligence

- **FR49:** System performs background pattern analysis across all connected services [Growth]
- **FR50:** System queues proactive insights for delivery at contextually appropriate times [Growth]
- **FR51:** System classifies all outbound notifications by urgency tier [Growth]
- **FR52:** System throttles notifications based on user engagement patterns [Growth]
- **FR53:** User can snooze entire notification categories [Growth]

### Skill Extensibility

- **FR54:** User can enable or disable skills via configuration without code changes [MVP]
- **FR55:** New skills integrate through the RavenSkill interface without modifying core code [MVP]
- **FR56:** Skills declare MCP servers that are loaded only into their sub-agents, never the orchestrator [MVP]
- **FR57:** System can scaffold new skill boilerplate from a conversation description [Vision]
- **FR58:** User can configure per-skill permission tiers through a configuration file [MVP]

### Expanding Integrations

- **FR59:** System monitors Google Drive folders for new files and processes them automatically [Growth]
- **FR60:** System tracks financial transactions from bank APIs and categorizes spending [Vision]
- **FR61:** System detects financial anomalies and alerts the user [Vision]
- **FR62:** System manages calendar blocks to protect deep work time [Vision]
- **FR63:** System provides meeting prep briefings from knowledge and relationship context [Vision]

### System Observability

- **FR64:** System logs all agent task executions with status, duration, and outcomes [MVP]
- **FR65:** System self-monitors health and reports failures through Telegram [MVP]
- **FR66:** User can view system health status through the web dashboard [MVP]
- **FR67:** System provides execution metrics and usage statistics [Growth]

## Non-Functional Requirements

### Security

- **NFR1:** All credentials and API tokens stored in environment variables or encrypted config, never in code or git history
- **NFR2:** Audit trail is append-only — no agent or process can modify or delete audit log entries
- **NFR3:** Permission gate enforcement is code-level middleware — cannot be bypassed through prompt injection or agent reasoning
- **NFR4:** MCP servers carry only the credentials needed for their specific skill — no shared credential pool across sub-agents
- **NFR5:** SQLite database file permissions restricted to the Raven process user only
- **NFR6:** Telegram bot token and webhook validated — reject messages not from the authenticated user
- **NFR7:** No sensitive data (credentials, tokens, email content) appears in log output at any log level

### Reliability

- **NFR8:** Individual skill load failures must not crash the process — log warning and continue with remaining skills
- **NFR9:** Individual agent task errors are caught, logged, and reported — never bubble up to crash the event loop
- **NFR10:** Scheduled pipelines that fail are retried with exponential backoff (max 3 retries) before reporting failure
- **NFR11:** System auto-restarts on crash via Docker restart policy or process manager
- **NFR12:** SQLite database survives unclean shutdowns — WAL mode enabled for crash resistance
- **NFR13:** System health endpoint (`/api/health`) responds within 500ms and reports component status
- **NFR14:** Failed Telegram message delivery retries 3 times before queuing for next active period

### Performance

- **NFR15:** API endpoints respond within 200ms for non-agent operations (health, config, status queries)
- **NFR16:** Agent task spawning (Claude Code subprocess launch) completes within 5 seconds
- **NFR17:** Morning briefing compilation (aggregating all sources) completes within 10 minutes
- **NFR18:** Pipeline step execution does not block the event loop — all I/O is non-blocking
- **NFR19:** Maximum 3 concurrent agent tasks by default (configurable via `RAVEN_MAX_CONCURRENT_AGENTS`)
- **NFR20:** SQLite queries complete within 50ms for typical operations — no full table scans on large tables
- **NFR21:** Telegram inline keyboard responses acknowledged within 2 seconds

### Integration

- **NFR22:** External API failures (TickTick, Gmail, Gemini, bank APIs) handled gracefully — skill degrades, system continues
- **NFR23:** MCP server startup failures logged and reported — sub-agent launches with zero tools rather than crashing
- **NFR24:** Telegram bot maintains connection through network interruptions — automatic reconnection with backoff
- **NFR25:** Git operations (auto-commit on config change) are non-blocking and failure-tolerant — config change applies even if git commit fails
- **NFR26:** Gemini voice transcription timeout set to 30 seconds — fallback to "please type" message on timeout

### Operational

- **NFR27:** System deployable via single `docker-compose up` command
- **NFR28:** Configuration changes (skills, permissions, pipelines) take effect without full restart where possible
- **NFR29:** Log output is structured JSON (Pino) — parseable by standard log tools
- **NFR30:** Database backup achievable by copying single SQLite file — no multi-file consistency concerns
