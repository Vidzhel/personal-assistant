---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'Raven platform evolution — architecture, interaction models, and automation design for maximum personal value'
session_goals: 'Flexible pipelines, async execution, dynamic reconfigurability, multi-channel interaction, proactive intelligence, observability, Claude Code as brain, expanding integrations, security, maximum autonomy'
selected_approach: 'progressive-flow'
techniques_used: ['What If Scenarios', 'Morphological Analysis', 'First Principles Thinking', 'Decision Tree Mapping']
ideas_generated: [100]
context_file: ''
---

# Brainstorming Session Results

**Facilitator:** User
**Date:** 2026-03-03

## Session Overview

**Topic:** Raven platform evolution — architecture, interaction models, and automation design for maximum personal value

**Goals:**
- Flexible pipeline architecture (rigid + dynamic, n8n-inspired)
- Non-blocking async execution across multiple projects
- Dynamic reconfigurability on-the-fly
- Multi-channel rich interaction (Telegram topics, rich Web UI)
- Proactive intelligence (daily nudges, stale task surfacing)
- Observability & control (Kanban, execution visibility, error tracking)
- Claude Code as the universal LLM engine
- Expanding integrations (TickTick, Gmail, Google Drive, Gemini, knowledge base)
- Security with isolated execution and confirmation gates
- Maximum autonomy — minimal interruptions, only ask when truly necessary

### Session Setup

_Progressive Technique Flow selected — start broad with divergent thinking, then systematically narrow toward actionable ideas and architecture decisions._

## Technique Selection

**Approach:** Progressive Technique Flow
**Journey Design:** Systematic development from exploration to action

**Progressive Techniques:**

- **Phase 1 - Exploration:** What If Scenarios — maximum idea generation, boundary-breaking
- **Phase 2 - Pattern Recognition:** Morphological Analysis — systematic parameter mapping
- **Phase 3 - Development:** First Principles Thinking — rebuild from fundamental truths
- **Phase 4 - Action Planning:** Decision Tree Mapping — implementation roadmap with decision points

**Journey Rationale:** The Raven platform vision spans multiple complex dimensions (architecture, interaction, autonomy, integrations). Progressive flow ensures we first explore without limits, then systematically map the solution space, strip to essentials, and create actionable paths forward.

## Phase 1: Expansive Exploration — What If Scenarios (100 Ideas)

### Autonomy & Self-Extension (#1-6, #20-21)
- **#1 Self-Scaffolding Integrations** — Raven autonomously creates new skill integrations, scaffolds code, wires pipelines, only asks for credentials
- **#2 Secure Credential Flow via Telegram** — OAuth links or credentials via Telegram, secure storage, message erasure
- **#3 Remote Meeting Capture** — "Record this meeting" from phone, auto-launches capture, records, processes
- **#4 Knowledge Bubble Creation** — Feed any media, Raven transcribes/chunks/structures into queryable knowledge bubbles
- **#5 Google Drive Awareness** — Passive awareness of Drive layout, tracks changes, knows WHERE things are
- **#6 Unsolicited Idea Generation** — Independently analyzes projects/tasks and surfaces improvement ideas as action items
- **#20 Overnight Project Drafting** — Describe idea, send reference images, sleep, wake up to working prototype deployed locally
- **#21 Multi-Modal Project Input** — Photos, sketches, voice notes, screenshots all synthesized into coherent project specs

### Proactive Intelligence (#7-8)
- **#7 Daily Stale Task Nudge** — Finds ignored TickTick tasks, presents 2-3 with context and proposed next steps
- **#8 Daily Retrospective & Story-Sharing** — "How was your day?" conversations that build deeper user model over time

### DevOps & Development (#9-10)
- **#9 Remote Project Kickoff** — Start working on projects from Telegram, knows Git repos, file system, GitLab issues, runs BMM workflows
- **#10 Autonomous Dev Task Execution** — Checks assigned GitLab issues, proposes which to tackle, starts BMM flow, reports progress

### Task Management (#11-12)
- **#11 Intelligent Task Creation from Forwarded Messages** — Forward Telegram message → parsed into TickTick task with smart defaults
- **#12 Chat-Aware Task Proposals** — Reads whitelisted Telegram groups, detects action items, proposes tasks with privacy boundaries

### Finance (#13-14)
- **#13 Multi-Bank Financial Aggregation** — Integrate monobank + other banks, auto-aggregate, categorize spending
- **#14 Financial Strategy & Planning** — Spending pattern analysis, budgeting strategies, savings plans, financial coaching

### Research (#15-16)
- **#15 Deep Autonomous Research** — Full research pipeline producing Word/PDF deliverables with action plans
- **#16 Research Companion & Idea Discovery** — Analyzes notes, discovers connections, suggests developments for scientific projects

### Knowledge System (#17-19, #42, #53-55)
- **#17 Auto-Clustering Knowledge Bubbles** — Automatically identifies related content and merges into knowledge series
- **#18 Personal Knowledge Graph (Obsidian-Style)** — Living graph of ALL knowledge, auto-built, discovers cross-domain connections
- **#19 Graph-Driven Idea Generation** — Traverses knowledge graph, finds bridges and gaps, proposes novel ideas
- **#42 Knowledge Graph Sub-Agent** — Dedicated agent for KG traversal, queryable service for all other agents
- **#53 Proactive Learning Material Curator** — Subscribes to relevant content, delivers scheduled digests with summaries
- **#54 Spaced Repetition Integration** — Creates review prompts from learning material, woven into Telegram flow
- **#55 Knowledge Gap Detection** — Analyzes graph, identifies learning gaps, suggests targeted learning tracks

### Communication & Personality (#25-30)
- **#25 The Good Friend Protocol** — Warm, perceptive friend personality, not corporate assistant
- **#26 Silence-Aware Message Throttling** — No response = message received, no follow-ups, no guilt
- **#27 Creative Garnish, Not Force-Feeding** — Light creative touch on every output unless suppressed, easy to ignore
- **#28 Category Snooze Detection** — Unanswered category suggestions trigger snooze proposal (vacation mode, etc.)
- **#29 Context-Sensitive Urgency Tiers** — "Tell now" / "Tell when active" / "Save for when they ask" classification
- **#30 Mood-Adaptive Communication Style** — Mirrors your energy from message patterns without being told

### Trust & Security (#31-37)
- **#31 System-Enforced Permission Tiers** — Code-level gates, not LLM judgment. Like Claude Code's folder permissions
- **#32 Simple Three-Tier Permission Model** — Green (auto) / Yellow (act & report) / Red (always ask). Dead simple
- **#33 Reversibility-Aware Autonomy** — "Can it be undone?" determines permission level. Git = auto, permanent deletion = always ask
- **#34 Bulk Permission Requests** — Batches approval requests into one interruption instead of many
- **#35 "Mark for Human" Pattern** — Marks objects for you to delete rather than asking permission to delete
- **#36 Progressive Trust Unlocking per Skill** — New skills start restricted, you explicitly promote when ready
- **#37 Immutable Audit Trail** — Every action logged, reviewable anytime. Trust through transparency

### Architecture (#38-43)
- **#38 Transparent Progress via Live Status Updates** — Telegram messages that update in-place, Web UI dashboard of active agents
- **#39 Unlimited Sub-Agent Spawning** — As many Claude Code instances as tasks require, true parallelism
- **#40 Project Context as Loadable Modules** — Per-project context files loaded by orchestrator, human-readable and editable
- **#41 Scoped Sub-Agents with Response-Only Interface** — Sub-agents return results only, don't dump context back to orchestrator
- **#43 Cross-Agent Communication Bus** — Event bus for agent signals, not direct chat. Lightweight cross-agent awareness

### Pipelines & Projects (#44-52)
- **#44 Simplified Visual Pipeline Builder** — Lightweight n8n-inspired system in Web UI, conversational creation
- **#45 Proactive Pipeline Suggestion** — Detects manual patterns, suggests automation. Respects snooze principle
- **#46 Strict vs. Freeform Project Modes** — Strict pipeline / prompt instructions / no project — three gears
- **#47 Programmatic Pipelines as Real Code** — TypeScript/bash scripts for deterministic execution, no LLM in the loop
- **#48 No-Project Quick Actions** — Simple queries hit orchestrator directly without project overhead
- **#49 Per-Project Skill/Agent Restrictions** — Whitelist skills per project, no cross-contamination
- **#50 Project as Prompt Instructions** — Natural language instructions as the lightest project structure
- **#51 Git-Backed Assistant Configuration** — All config is version-controlled, every change is a commit
- **#52 Web UI Commit Viewer & Selective Revert** — Visual commit history, surgical rollback of specific changes

### Health (#22-24)
- **#22 Auto-Detect Health Document Uploads** — Detects new health docs in Google Drive, integrates into knowledge base
- **#23 Health-Life Correlation Engine** — Correlates health data with productivity, mood, energy
- **#24 Household Information Management** — Warranties, maintenance, utilities, appliance data managed automatically

### Time Management (#56-60, #76-78)
- **#56 Intelligent Time Block Architect** — Energy-aware scheduling based on learned patterns
- **#57 Calendar Defense Agent** — Protects deep work blocks from meeting invites
- **#58 Time Audit & Visibility** — Weekly time reports comparing intention vs. reality
- **#59 Smart Deadline Negotiation** — Capacity-aware deadline assessment with prioritization
- **#60 Context-Switch Cost Tracker** — Surfaces the hidden cost of project-bouncing
- **#76 Gentle Time-Tracking Gap Filler** — Asks what you did during untracked gaps, conversationally
- **#77 Data Analyst Sub-Agent with Charts** — Generates actual visualizations of time patterns
- **#78 Improvement Recommendations** — Actionable suggestions based on time data analysis

### Social & Relationships (#61-64)
- **#61 Personal Relationship Memory** — Remembers details about people, surfaces before meetings
- **#62 Relationship Maintenance Nudges** — Gentle reminders to reach out to people you value
- **#63 Gift & Occasion Tracker** — Birthdays, anniversaries, gift suggestions based on knowledge
- **#64 Meeting Prep Briefings** — Context briefs before any meeting, work or personal

### Mobile Experience (#65-69)
- **#65 Voice-First Telegram Interaction** — Voice messages transcribed and acted upon
- **#66 Photo/Screenshot as Input** — Camera as universal input device for all life systems
- **#67 Quick-Action Telegram Buttons** — Inline keyboards for one-tap decisions
- **#68 Offline Queue with Sync** — Messages queue offline, execute on reconnect
- **#69 Location-Aware Context** — Automatic mode switching based on where you are

### Emergency & Resilience (#70-73)
- **#70 Dead Man's Switch** — Escalation chains for failed critical pipelines
- **#71 System Health Self-Monitoring** — Raven monitors own health, degrades gracefully
- **#72 Financial Anomaly Alert** — Overrides all notification preferences for unusual transactions
- **#73 Backup & Recovery Protocol** — Periodic state backups, full disaster recovery capability

### Multi-User (#74-75)
- **#74 Family Shared Pipelines** — Household-level shared tasks, calendars, lists with individual privacy
- **#75 Delegated Access** — Role-based access for trusted people within same instance

### Writing & Scientific (#79-84)
- **#79 Scientific Writing Co-Pilot** — Structure, lit review, citations, argument flow for academic writing
- **#80 Living Literature Review** — Auto-maintained, grows as new papers appear
- **#81 Multi-Draft Writing Workflow** — Phase-appropriate assistance from brainstorm to polish
- **#82 Citation & Reference Manager** — Citation tracking and formatting woven into writing flow
- **#83 Research Exploration Chains** — Follow citation graphs, map intellectual landscapes
- **#84 Argument Stress-Tester** — Devil's advocate review before submission

### Habits & Personal Growth (#85-88)
- **#85 Habit Streak Tracker** — Gentle nudges, celebrates wins more than highlighting misses
- **#86 Habit-Context Correlation** — Data-driven proof that YOUR habits affect YOUR outcomes
- **#87 Micro-Habit Insertion** — Finds natural calendar gaps for habit insertion
- **#88 Personal Growth Roadmaps** — Progressive plans for long-term development goals

### Travel & Shopping (#89-92)
- **#89 End-to-End Trip Planner** — Full travel planning with learned preferences
- **#90 Real-Time Trip Companion** — Live assistance during travel via Telegram
- **#91 Smart Shopping Research** — Preference-aware product research and comparison
- **#92 Price Watch Agent** — Background price monitoring with alert triggers

### Dashboard & Visualization (#93-98)
- **#93 Life Dashboard Homepage** — Full life overview in one screen
- **#94 Kanban-Style Agent Task Board** — OpenClaw-inspired live task visibility
- **#95 Custom Chart Builder** — On-demand data visualization from any personal data
- **#96 Knowledge Graph Visualizer** — Interactive graph view of entire knowledge base
- **#97 Pipeline Monitor & Debugger** — DevOps-grade pipeline observability
- **#98 Timeline & Activity Feed** — Chronological feed of all Raven activity, filterable

### Wild Ideas (#99-100)
- **#99 Dream Journal Integration** — Voice-record dreams, pattern detection, wellbeing correlation
- **#100 Digital Legacy Manager** — Organize digital life for longevity and emergency access

## Phase 2: Pattern Recognition — Morphological Analysis

### 7 Core System Dimensions

**DIMENSION 1: Interaction Channel**

| Value | Description |
|---|---|
| Telegram Text | Typed messages, forwarded content |
| Telegram Voice | Voice messages transcribed |
| Telegram Media | Photos, screenshots, files sent |
| Telegram Buttons | Inline keyboard quick-actions |
| Web UI Chat | Rich browser-based conversation |
| Web UI Dashboard | Visual monitoring and control |
| API/Webhook | External systems triggering Raven |

**DIMENSION 2: Task Structure**

| Value | Description |
|---|---|
| Quick Query | No project, instant response |
| Freeform Project | Prompt instructions, flexible guidance |
| Strict Pipeline | Programmatic, deterministic execution |
| Scheduled Pipeline | Time-triggered automated flows |
| Proactive Suggestion | Raven-initiated based on pattern detection |
| Event-Triggered | Responds to external events (new file, new email) |

**DIMENSION 3: Autonomy Level**

| Value | Description |
|---|---|
| Green — Full Auto | Read, create, non-destructive. No permission needed |
| Yellow — Act & Report | Reversible changes, reports after |
| Red — Always Ask | Irreversible/sensitive, requires approval |
| Bulk Approval | Batches multiple red items into one request |
| Mark for Human | Identifies targets, human executes the action |

**DIMENSION 4: Knowledge Involvement**

| Value | Description |
|---|---|
| None | Simple action, no knowledge needed |
| Contextual Lookup | Quick query to knowledge graph |
| Deep Graph Traversal | Sub-agent explores knowledge graph extensively |
| Knowledge Creation | Result gets stored as new knowledge bubble |
| Cross-Domain Synthesis | Connects knowledge across different domains |

**DIMENSION 5: Agent Architecture**

| Value | Description |
|---|---|
| Orchestrator Direct | Simple enough for orchestrator to handle alone |
| Single Sub-Agent | One scoped agent spawned for the task |
| Parallel Sub-Agents | Multiple agents working concurrently |
| Agent Chain | Sequential agents, each building on previous output |
| Agent + Knowledge Agent | Task agent paired with KG exploration agent |

**DIMENSION 6: Output & Visibility**

| Value | Description |
|---|---|
| Silent | Logs only, no notification |
| Status Update | In-place updating message (Telegram/Web UI) |
| Summary Report | Delivered result with key findings |
| Rich Document | PDF/Word/formatted deliverable |
| Visual/Chart | Data visualization, graphs, dashboards |
| Live Dashboard | Real-time Kanban/timeline view |

**DIMENSION 7: Lifecycle & Persistence**

| Value | Description |
|---|---|
| One-Shot | Execute and done, no state |
| Session | Persists within a conversation/project |
| Recurring | Scheduled, repeats on cadence |
| Evolving | Learns and improves over time |
| Version-Controlled | Full git history, rollback capability |

### 7 Architecture Patterns (Cross-Dimensional Combinations)

#### PATTERN A: "The Quick Brain Pick"
*When you just need an answer, no ceremony*

| Dimension | Value |
|---|---|
| Channel | Telegram Text / Voice |
| Task Structure | Quick Query |
| Autonomy | Green — Full Auto |
| Knowledge | Contextual Lookup or Deep Traversal |
| Architecture | Orchestrator Direct or Single Sub-Agent |
| Output | Summary Report |
| Lifecycle | One-Shot |

**Examples:** "What did I spend on dining?" / "What did we discuss about auth?" / "When is Mom's birthday?"
**Insight:** The FAST PATH. No project, no pipeline, no permissions. Sub-second routing, response in seconds.

#### PATTERN B: "The Overnight Builder"
*Give it a vision, go to sleep, wake up to results*

| Dimension | Value |
|---|---|
| Channel | Telegram Media → Web UI Dashboard |
| Task Structure | Freeform Project |
| Autonomy | **Configurable: Review Checkpoints OR Full Auto** |
| Knowledge | Cross-Domain Synthesis |
| Architecture | Parallel Sub-Agents (with optional gate points) |
| Output | Live Dashboard → Rich deliverable |
| Lifecycle | Session + Version-Controlled |

**Autonomy Negotiation at kickoff:**
> "Here's my plan. How do you want to handle this?
> [1] Review each phase before I proceed
> [2] Review the plan now, then full auto
> [3] Full auto — surprise me in the morning
> [4] Custom gates — tell me which phases need review"

**Insight:** Needs PROJECT MANAGER sub-agent + DISPATCHER + configurable checkpoint gates. Each phase has `requires_approval: true/false` flag. Even in full auto, Red tier is still respected.

#### PATTERN C: "The Daily Autopilot"
*Scheduled pipelines that just run, reliably, every day*

| Dimension | Value |
|---|---|
| Channel | Telegram Buttons |
| Task Structure | Scheduled Pipeline |
| Autonomy | Green — Full Auto |
| Knowledge | Contextual Lookup |
| Architecture | Agent Chain |
| Output | Summary Report with quick-action buttons |
| Lifecycle | Recurring + Evolving |

**Examples:** 8am morning briefing / 12pm stale task nudge / 6pm learning digest / Weekly time audit
**Insight:** STRICT pipelines — programmatic, deterministic. Content selection evolves but structure is fixed code.

#### PATTERN D: "The Research Deep Dive"
*Multi-hour autonomous research producing deliverables*

| Dimension | Value |
|---|---|
| Channel | Telegram Text → Web UI Dashboard → Telegram |
| Task Structure | Freeform Project |
| Autonomy | Green (research) + Yellow (creates documents) |
| Knowledge | Deep Traversal + Knowledge Creation + Cross-Domain Synthesis |
| Architecture | Parallel Sub-Agents |
| Output | Rich Document + Knowledge bubble creation |
| Lifecycle | Session + permanent knowledge |

**Insight:** KG agent checks what you already know BEFORE researching. Output creates NEW knowledge, compounding intellectual capital.

#### PATTERN E: "The Proactive Friend"
*Raven-initiated, respecting your attention*

| Dimension | Value |
|---|---|
| Channel | Telegram Text |
| Task Structure | Proactive Suggestion |
| Autonomy | Green (analysis) + requires engagement to act |
| Knowledge | Cross-Domain Synthesis |
| Architecture | Agent + Knowledge Agent |
| Output | Summary Report (concise, easy to ignore) |
| Lifecycle | Evolving |

**Insight:** Separate scheduled analysis process. Passes through Good Friend Protocol filters: urgency tier, category snooze, response pattern. Insights queue until the right moment.

#### PATTERN F: "The Event Reactor"
*Something happens in the world, Raven responds*

| Dimension | Value |
|---|---|
| Channel | Event source → Telegram notification |
| Task Structure | Event-Triggered |
| Autonomy | Green (detect + analyze) → Red if action needed |
| Knowledge | Knowledge Creation |
| Architecture | Single Sub-Agent |
| Output | Status Update or Silent |
| Lifecycle | Recurring (always listening) + Version-Controlled |

**Examples:** Health doc uploaded → auto-process / Unusual transaction → alert / New email from VIP → summarize / GitLab issue assigned → add to TickTick
**Insight:** WATCHER layer — always-on lightweight listeners. Most events processed silently. Only significant events surface.

#### PATTERN G: "The Conversational Pipeline Creator"
*Describe automation in natural language, Raven builds it*

| Dimension | Value |
|---|---|
| Channel | Telegram Text → Web UI Dashboard |
| Task Structure | Creates new Scheduled/Event-Triggered Pipeline |
| Autonomy | Yellow (creates config) → Red (activating) |
| Knowledge | Contextual Lookup |
| Architecture | Single Sub-Agent (pipeline architect) |
| Output | Visual pipeline in Web UI + confirmation |
| Lifecycle | Version-Controlled |

**Insight:** Pipeline builder must know available skills, trust tiers, data sources. Essentially a code generator for pipeline definitions. Git-backed = bad pipeline is just a revert.

### Pattern Comparison Matrix

| Pattern | Speed | Autonomy | Complexity | User Attention |
|---|---|---|---|---|
| A: Quick Brain Pick | Instant | Full auto | Minimal | Seconds |
| B: Overnight Builder | Hours | Configurable | Maximum | Glance or sleep |
| C: Daily Autopilot | Scheduled | Full auto | Medium (fixed) | 1 min per delivery |
| D: Research Deep Dive | Hours | Auto + creates docs | High | Review result |
| E: Proactive Friend | Background | Suggest only | Medium | Optional engagement |
| F: Event Reactor | Real-time | Auto + escalate | Low per event | Only when significant |
| G: Pipeline Creator | Minutes | Needs approval | Medium | Approve once |

### Cross-Pattern Analysis: 8 Core Architectural Components

**1. The Orchestrator Router** — Every interaction starts here. Classification layer that routes intent to the right pattern. Fast, reliable, on the critical path.

**2. The Sub-Agent Spawner** — Core execution engine. Agent pool/concurrency management, context injection, scoped response interface, lifecycle management.

**3. The Permission Gate System** — System-level enforcement. Checks trust tiers (Green/Yellow/Red), evaluates reversibility, batches approvals, supports "Mark for Human," configurable checkpoint gates.

**4. The Knowledge Graph Service** — Queryable service, not a monolith. Contextual lookup, deep traversal, knowledge creation, cross-domain synthesis, auto-clustering.

**5. The Event Bus** — Everything important becomes an event. Agent completions, pipeline steps, external events, user responses, proactive insights. Consumed by orchestrator, dashboard, notification engine.

**6. The Notification & Delivery Engine** — Decides HOW to deliver. Urgency tier classification, channel selection, Good Friend Protocol filters (snooze, throttle, batch), format selection, time-of-day awareness.

**7. The Pipeline Engine** — Executes defined flows. Strict/programmatic pipelines, scheduled/event triggers, pipeline definition storage (git-backed), visual representation for Web UI.

**8. The Version Control Layer** — Everything is git-backed. Pipeline definitions, project configs, trust settings, skill configurations. Web UI exposes commits and selective revert.

### System Architecture Map

```
                    ┌─────────────────────┐
   Telegram ──────►│                     │
   Web UI ────────►│   1. ORCHESTRATOR   │◄──── 7. PIPELINE ENGINE
   API/Webhook ───►│      ROUTER         │         (scheduled/event triggers)
                    └──────────┬──────────┘
                               │ routes to
                    ┌──────────▼──────────┐
                    │  2. SUB-AGENT       │◄───► 4. KNOWLEDGE GRAPH
                    │     SPAWNER         │         SERVICE
                    └──────────┬──────────┘
                               │ every action passes through
                    ┌──────────▼──────────┐
                    │  3. PERMISSION      │
                    │     GATE SYSTEM     │
                    └──────────┬──────────┘
                               │ emits events
                    ┌──────────▼──────────┐
                    │  5. EVENT BUS       │
                    └──────┬─────┬────────┘
                           │     │
              ┌────────────▼┐   ┌▼────────────────┐
              │6. NOTIFICATION│   │  Web UI Dashboard │
              │   & DELIVERY  │   │  (Kanban, logs,   │
              │   ENGINE      │   │   timeline)       │
              └───────────────┘   └───────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 8. VERSION CONTROL  │
                    │    LAYER (git)      │
                    └─────────────────────┘
```

All 100 ideas from Phase 1 map to one or more of these 8 components. No feature requires a component not on this list.

## Phase 3: Idea Development — First Principles Thinking

### First Principle #1: What is Raven, fundamentally?

**Raven is a ROUTING LAYER between user intent and Claude Code execution, with memory.**

The irreducible core loop:
1. You express intent (text, voice, photo, scheduled trigger)
2. Raven routes it to the right Claude Code instance with the right context
3. Claude Code does the actual work
4. The result comes back through Raven
5. Raven remembers what happened

If this core loop breaks, nothing works. If this core loop works, everything else can be built incrementally.

### First Principle #2: Day-One Fundamentals vs. Growth Features

| Component | Day One? | Reasoning |
|---|---|---|
| Orchestrator Router | **YES** | IS the system — without routing, intent goes nowhere |
| Sub-Agent Spawner | **YES** | Without execution, nothing happens |
| Event Bus | **YES** | Nervous system for async — even simplest flow is an event chain |
| Permission Gates | **YES** | Trust prerequisite for real data — must exist before agents touch real services |
| Knowledge Graph | SIMPLE VERSION | Per-project context + SQLite first, full graph later |
| Pipeline Engine | SIMPLE VERSION | Cron configs + scripts first, visual builder later |
| Notification Engine | SIMPLE VERSION | Basic Telegram/Web delivery first, Friend Protocol later |
| Version Control | YES (nearly free) | Already using git, just commit on config changes |

**4 must be solid from day one. 3 start simple and grow. 1 is nearly free.**

### First Principle #3: Real Constraints (Design Walls)

**CONSTRAINT 1: Claude Code is a subprocess, not a server**
- Every sub-agent is a fresh process with injected context
- No persistent "always learning" agent — illusion created by good context management
- The ORCHESTRATOR is the persistent brain, not Claude Code
- Context injection quality = agent intelligence quality

**CONSTRAINT 2: Context windows are finite**
- Orchestrator must stay LEAN — route, don't accumulate
- Sub-agents get scoped context, not entire life history
- Knowledge graph exists because you CAN'T put all knowledge into a prompt
- Every decision should ask: "does this bloat context or keep it focused?"

**CONSTRAINT 3: You are ONE person with limited attention**
- Every notification is a withdrawal from attention bank
- Default to autonomous action
- Batch interruptions
- Friend Protocol is a survival requirement, not a nice-to-have

**CONSTRAINT 4: Security is binary — trustworthy or useless**
- System-level gates in code, not prompts
- No LLM reasoning can bypass a Red tier gate
- Credentials encrypted at rest, never in logs
- Immutable audit trail

**CONSTRAINT 5: Building incrementally, solo**
- Add skills without rebuilding core
- Change pipelines without restart
- Grow knowledge graph without migration
- Each piece delivers value independently

### First Principle #4: Three-Layer Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    PERSISTENT LAYER                       │
│                  (Always running, lean)                    │
│                                                          │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Orchestrator │  │ Event    │  │ Permission         │  │
│  │ Router       │──│ Bus      │──│ Gate System        │  │
│  │              │  │          │  │ (code-level, not   │  │
│  │ • Classify   │  │ • Async  │  │  LLM-level)        │  │
│  │   intent     │  │ • Decouple│  │                    │  │
│  │ • Load       │  │ • Log    │  │ • Green/Yellow/Red │  │
│  │   context    │  │          │  │ • Reversibility    │  │
│  │ • Route      │  │          │  │   check            │  │
│  └──────┬───────┘  └──────────┘  │ • Bulk batching    │  │
│         │                        └────────────────────┘  │
│  ┌──────▼───────┐  ┌──────────────────────────────────┐  │
│  │ Agent        │  │ Storage (SQLite + filesystem)     │  │
│  │ Spawner      │  │                                   │  │
│  │              │  │ • Project contexts (markdown)     │  │
│  │ • Spawn      │  │ • Pipeline configs (git-tracked)  │  │
│  │   Claude Code│  │ • Event log                       │  │
│  │ • Inject     │  │ • Knowledge (simple → graph later)│  │
│  │   context    │  │ • Skill configs                   │  │
│  │ • Collect    │  │ • Trust tier settings              │  │
│  │   result     │  └──────────────────────────────────┘  │
│  │ • Enforce    │                                        │
│  │   gates      │                                        │
│  └──────────────┘                                        │
└──────────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────┐
│                   DELIVERY LAYER                          │
│               (How results reach you)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Telegram Bot  │  │ Web UI       │  │ Scheduler     │  │
│  │ • Topics      │  │ • Chat       │  │ • Cron-like   │  │
│  │ • Keyboards   │  │ • Dashboard  │  │ • Event       │  │
│  │ • Voice/media │  │ • Kanban     │  │   watchers    │  │
│  └──────────────┘  │ • History    │  │ • Pipeline    │  │
│                     │ • Commits    │  │   executor    │  │
│                     └──────────────┘  └───────────────┘  │
└──────────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────┐
│                    SKILL LAYER                            │
│              (Pluggable, isolated, grows)                 │
│                                                          │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐ │
│  │TickTick│ │ Gmail  │ │ Google │ │Finance │ │Future │ │
│  │  MCP   │ │MCP+IMAP│ │Drive   │ │  API   │ │skills │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └───────┘ │
└──────────────────────────────────────────────────────────┘
```

**Key insight:** Claude Code is the hands, not the brain. The orchestrator is the brain — it persists, remembers, routes. Claude Code is spawned, does work, returns.

### First Principle #5: Current State Gap Analysis

**Already aligned with first-principles architecture:**
- MCP isolation model (skills declare sub-agents with own MCPs) = Skill Layer ✓
- Event bus exists ✓
- Agent session with Claude SDK query() = sub-agent spawner ✓
- Orchestrator with event routing ✓
- SQLite persistence ✓
- Telegram bot + Web UI = delivery layer ✓
- RavenSkill plugin architecture ✓

**Gaps (all ADDITIVE — nothing needs to be torn down):**
- Permission Gate System — not yet system-enforced at spawner level
- Knowledge layer — no structured knowledge storage yet
- Pipeline engine — scheduler exists but no pipeline definition system
- Project context management — no rich context loading for agent injection
- Git-backed config versioning — not yet automatic
- Notification intelligence — no Friend Protocol, urgency tiers, or snooze

### First Principle #6: Highest Leverage First Enhancement

**Permission Gate System wins.** Reasoning:
- Unlocks letting Raven touch real data autonomously (TickTick, Gmail, finances)
- Without it, every action needs manual trust → breaks "maximum autonomy" goal
- Gates are the TRUST UNLOCK that makes everything else safe to build
- Medium effort — code-level middleware in the agent spawner
- Every future feature (knowledge ingestion, pipeline execution, proactive actions) depends on trusted autonomous execution

## Phase 4: Action Planning — Decision Tree Mapping

### Decision 1: Permission Gate Implementation Strategy

**Chosen approach: Incremental (A → B → C)**

**Branch A: Minimal Gate — Action Allowlist (FIRST)**
- Every skill action has a permission level (Green/Yellow/Red) in a config file
- Agent spawner checks config before executing any action
- Default: everything Red unless explicitly granted
- Simple JSON config, no UI needed initially
- **Time: Days, not weeks**

**Branch B: + Reversibility Engine (LATER, Phase 4)**
- Automatic reversibility detection (git-backed = more permissive)
- Dynamic tier adjustment based on context

**Branch C: + Bulk Approval UI (LATER, Phase 2)**
- Telegram inline keyboard for batch approvals
- Queue Red-tier actions, present as batch

### Decision 2: Post-Gates Priority Sequencing

Three independent tracks identified:

| Track | Immediate Daily Value | Foundation for Future | Effort |
|---|---|---|---|
| A: Knowledge Layer | Medium (builds over time) | VERY HIGH (compounds) | Medium-High |
| B: Pipeline Definitions | HIGH (daily briefings) | High (automation backbone) | Medium |
| C: Enhanced Telegram | HIGH (daily mobile control) | Medium (UX, not architecture) | Medium |

**Chosen sequence:** B + C in parallel → then A

### Decision 3: Complete 8-Phase Roadmap

#### PHASE 1: TRUST & AUTONOMY FOUNDATION (Weeks 1-2)
```
Permission Gate System (Branch A: Minimal)
├── Action allowlist config (JSON)
├── Gate enforcement in agent spawner
├── Default Red, explicitly grant Green/Yellow
└── Audit logging for all gated actions
```
**Milestone:** Raven can safely auto-manage TickTick and read Gmail without asking every time.

#### PHASE 2: DAILY VALUE (Weeks 3-6)
```
Pipeline Definitions + Enhanced Telegram (parallel)
│
├── Pipeline Engine (simple)
│   ├── YAML pipeline config format
│   ├── Cron-scheduled execution
│   ├── Event-triggered execution
│   ├── Strict mode (programmatic, no LLM)
│   └── Git-tracked pipeline configs
│
└── Telegram Enhancement
    ├── Group topics per project/domain
    ├── Voice message → transcription → intent
    ├── Photo/file → routed processing
    ├── Inline keyboard buttons
    └── Bulk approval UI for Red-tier batches
```
**Milestone:** Morning briefing arrives automatically. Phone becomes real control surface. Daily stale task nudges live.

#### PHASE 3: KNOWLEDGE & MEMORY (Weeks 7-10)
```
Knowledge Layer (simple version)
├── Knowledge bubble storage (markdown + SQLite metadata)
├── Ingestion pipeline (text, audio, video → process → store)
├── Tagging and auto-clustering
├── Retrieval sub-agent for context injection
├── Project context enrichment
└── Gemini API integration for transcription/media processing
```
**Milestone:** Record a meeting → knowledge bubble. Ask about it weeks later → Raven remembers. Agents get smarter with accumulated context.

#### PHASE 4: PROACTIVE INTELLIGENCE (Weeks 11-14)
```
Friend Protocol + Proactive Engine
├── Notification intelligence
│   ├── Urgency tier classification
│   ├── Category snooze detection
│   ├── Silence-aware throttling
│   └── Time-of-day awareness
│
├── Proactive analysis engine
│   ├── Background pattern detection across services
│   ├── Suggestion queue with delivery timing
│   ├── Stale task intelligence (beyond simple cron)
│   └── Cross-domain insight generation
│
└── Permission Gate upgrade (Branch B)
    ├── Reversibility-aware autonomy
    └── Dynamic tier adjustment
```
**Milestone:** Raven proactively suggests useful things at the right time. Feels like a thoughtful friend, not a notification machine.

#### PHASE 5: RICH VISUALIZATION & OBSERVABILITY (Weeks 15-18)
```
Web UI Enhancement
├── Life Dashboard homepage
├── Kanban-style agent task board (OpenClaw-inspired)
├── Pipeline monitor & debugger
├── Timeline & activity feed
├── Commit viewer with selective revert
└── Project-level history and context views
```
**Milestone:** Web UI shows entire life system at a glance. Watch agents work in real-time. Debug any pipeline visually.

#### PHASE 6: KNOWLEDGE GRAPH & DEEP INTELLIGENCE (Weeks 19-24)
```
Full Knowledge Graph
├── Graph database or graph layer on SQLite
├── Automatic relationship detection between knowledge nodes
├── Visual graph explorer in Web UI
├── Knowledge gap detection
├── Graph-driven idea generation
├── Research exploration chains (citation graph following)
└── Cross-domain correlation engine (health ↔ productivity ↔ habits)
```
**Milestone:** Living, navigable knowledge graph. Raven discovers insights by traversing connections you'd never make manually.

#### PHASE 7: EXPANDING INTEGRATIONS (Weeks 25+, ongoing)
```
New Skills (each independent, add anytime after Phase 1)
├── Google Drive (file awareness, health doc detection)
├── Finance (monobank + bank APIs, spending tracking)
├── Calendar (time blocking, defense agent)
├── Scientific writing tools (citation management, lit review)
├── Shopping/price watch agents
├── Gemini API (image gen, advanced media processing)
└── Future: Smart home, location services, etc.
```
**Milestone:** Each new skill plugs in, gets a trust tier, starts working. Platform grows organically.

#### PHASE 8: ADVANCED AUTOMATION (Weeks 30+)
```
Pipeline Builder + Self-Extension
├── Visual pipeline builder in Web UI
├── Conversational pipeline creation via Telegram
├── Proactive pipeline suggestion (pattern detection)
├── Self-scaffolding skill integrations
└── Overnight Builder pattern (full project autonomy with gate negotiation)
```
**Milestone:** Describe a pipeline in natural language → Raven builds it. Describe a website → wake up to working prototype.

### Complete Decision Tree

```
Current State (working core)
│
▼ PHASE 1: Permission Gates [Weeks 1-2]
│   "Raven can be trusted with my data"
│
├─▶ PHASE 2: Pipelines + Telegram [Weeks 3-6]  (parallel)
│   "Raven works for me daily, I control it from my phone"
│
▼ PHASE 3: Knowledge Layer [Weeks 7-10]
│   "Raven remembers everything I teach it"
│
▼ PHASE 4: Proactive Intelligence [Weeks 11-14]
│   "Raven suggests things at the right time"
│
▼ PHASE 5: Rich Web UI [Weeks 15-18]
│   "I can see and control everything visually"
│
▼ PHASE 6: Knowledge Graph [Weeks 19-24]
│   "Raven discovers insights I'd never find"
│
├─▶ PHASE 7: New Integrations [Weeks 25+, ongoing]
│   "Raven touches every part of my digital life"
│
▼ PHASE 8: Advanced Automation [Weeks 30+]
    "Raven extends itself and builds things overnight"
```

### Roadmap Principles
- Each phase delivers standalone value — no waiting 30 weeks to benefit
- Earlier phases are foundations for later ones, but no phase is wasted
- New integrations (Phase 7) can start anytime after Phase 1 — each skill is independent
- Week estimates are rough guides, not commitments

---

## Session Summary

### What We Accomplished

| Phase | Technique | Output |
|---|---|---|
| 1. Expansive Exploration | What If Scenarios | 100 ideas across 17 domains |
| 2. Pattern Recognition | Morphological Analysis | 7 system dimensions, 7 architecture patterns, 8 core components |
| 3. Idea Development | First Principles Thinking | 3-layer architecture, 5 constraints, gap analysis, highest-leverage priority |
| 4. Action Planning | Decision Tree Mapping | 8-phase implementation roadmap with decision trees |

### Key Outcomes

**The Vision:** Raven evolves from a working assistant prototype into a full Life Operating System — managing tasks, knowledge, finances, health, relationships, development, research, and learning — all with maximum autonomy and minimum interruption.

**The Architecture:** Three-layer design (Persistent / Delivery / Skill) with 8 core components. Claude Code as the hands, orchestrator as the brain. Context injection quality = agent intelligence quality.

**The Principles:**
- System-enforced trust, not LLM-based (Green/Yellow/Red tiers)
- Good Friend Protocol — silence-aware, category snooze, urgency tiers
- Git-backed everything — full history, selective revert
- Start simple, grow organically — no premature complexity
- Each piece delivers value independently

**The Roadmap:** 8 phases, starting with Permission Gates (the trust unlock), followed by daily-value features (pipelines + Telegram), then knowledge, proactive intelligence, visualization, knowledge graph, integrations, and advanced automation.

**Immediate Next Step:** Build Permission Gate System (Branch A: Minimal Action Allowlist) — days, not weeks.
