# Raven v2 Architecture Design

**Date**: 2026-03-28
**Status**: Approved
**Scope**: Full architecture redesign — task execution engine, capability library, project hierarchy, permissions

---

## Table of Contents

1. [Overview](#1-overview)
2. [Task-Board Execution Engine](#2-task-board-execution-engine)
3. [Capability Library](#3-capability-library)
4. [Project-Centric File Structure](#4-project-centric-file-structure)
5. [Agent Builder & Workflow Templates](#5-agent-builder--workflow-templates)
6. [Permissions & Tool Access](#6-permissions--tool-access)
7. [Validation](#7-validation)
8. [DB vs Filesystem Storage](#8-db-vs-filesystem-storage)
9. [Migration Path](#9-migration-path)

---

## 1. Overview

### Vision

Raven v2 transforms from a suite-based agent orchestrator into a **harness-driven, project-centric personal operating system**. The core innovation is a unified task execution engine that replaces both the current orchestrator relay pattern and the pipeline engine with a single, reliable, auditable system.

### Key Architectural Shifts

| Aspect | Raven v1 | Raven v2 |
|--------|----------|----------|
| Agent orchestration | Orchestrator stays open, relays between agents | Orchestrator plans once, engine executes, orchestrator synthesizes |
| Reliability | No validation, hope agent completes correctly | Three-gate validation harness with retry |
| Skill organization | Tightly coupled to suites | Shared hierarchical library with progressive disclosure |
| Project structure | Flat projects in DB | Filesystem hierarchy with inheritance |
| Pipelines vs tasks | Two separate systems | Unified task templates with mixed node types |
| Agent definitions | DB + JSON config | YAML files on filesystem, git-committed |
| Bash access | Binary (has it or not) | Four graduated levels with code-level enforcement |
| Workflow creation | Manual YAML authoring | Agent builder scaffolds entire project domains |

### Design Principles

1. **The harness determines the outcome** — reliability comes from deterministic code wrapping agent execution, not from better prompts (Anthropic Harness 2.0)
2. **Filesystem is source of truth** — all definitions are git-committed, diffable, human-readable. DB stores only runtime state and statistics
3. **Progressive disclosure** — agents see skill catalogs (names + descriptions), load full instructions on-demand, access deep reference only when needed
4. **Task-as-artifact** — agents communicate through task artifacts, not context forwarding. Each agent gets a fresh context window
5. **One engine, many task types** — agent calls, code execution, conditions, notifications, delays, approvals all run through the same execution engine
6. **Code-level enforcement** — permissions are middleware gates, not prompt instructions. Impossible to bypass via prompt injection

### Multi-Level Spawning Assessment

The Claude Agent SDK limits sub-agents to two levels (orchestrator + workers — sub-agents cannot spawn sub-agents). **This is not a significant gap in the v2 architecture.** The task-board relay pattern provides effectively unlimited depth with better properties:

- Each agent gets a fresh context window (no accumulated noise)
- Artifacts are persistent and auditable (vs. ephemeral nested context)
- The orchestrator can make routing decisions between steps (vs. rigid nesting)
- Any agent can be retried independently without replaying the entire chain
- The execution engine handles chaining deterministically (zero tokens for routing)

For deeply recursive exploration tasks, iterative deepening via orchestrator loop (research → evaluate → go deeper or stop) is more controllable than unbounded recursive spawning.

---

## 2. Task-Board Execution Engine

### 2.1 Orchestrator Decision Logic

The orchestrator evaluates every incoming request and decides the execution mode. This is prompt-engineered, not hard-coded — the LLM is good at this classification.

**DIRECT** — Single agent call. For quick lookups, simple queries, casual chat. No task tree, no engine. Dispatch immediately, return result.

**DELEGATED** — One agent, substantial work. Create a single task. Agent creates subtasks as needed during execution. Validation gates apply.

**PLANNED** — Multi-agent, dependencies, complex. Create full task tree with agent assignments. Display plan to user for approval. Engine executes after approval. Orchestrator re-engaged to synthesize results.

### 2.2 Task Tree Lifecycle

```
User request arrives
        │
        ▼
   Orchestrator TRIAGE
   (DIRECT / DELEGATED / PLANNED)
        │
        │ if PLANNED:
        ▼
   Orchestrator creates task tree
   with agent assignments, dependencies,
   and validation configs
        │
        ▼
   PENDING APPROVAL
   Plan displayed to user (dashboard + Telegram)
   User can edit tasks, reorder, reassign agents
        │
        ▼ user approves
   Task Execution Engine takes over
   (deterministic code, zero tokens)
        │
   For each task with no unmet dependencies:
        ├─ Spawn assigned agent (or orchestrator if agent: null)
        ├─ Agent creates/claims Raven task, sets in_progress
        ├─ Agent works, attaches artifacts to task
        ├─ Agent completes task with summary
        ├─ Validation pipeline runs (3 gates)
        ├─ If pass → mark completed, unblock dependents
        └─ If fail → retry with feedback (up to maxRetries)
        │
   All subtasks completed
        │
        ▼
   Orchestrator re-triggered for SYNTHESIS
   Reviews all subtask results
   Completes parent task with summary
   Sends notification
```

### 2.3 Dynamic Task Trees

Task trees are mutable during execution. Three triggers cause orchestrator re-engagement:

1. **Agent flags `needs_replan: true`** — discovered new information that changes the plan. Engine pauses remaining tasks, orchestrator modifies the tree.

2. **Agent marks task `blocked`** — can't proceed, provides reason. Engine triggers orchestrator to replan (add/remove/reassign tasks).

3. **Agent completes and requests additional subtasks** — engine notifies orchestrator, which can add new tasks to the tree without disrupting running tasks.

The orchestrator can: add subtasks, remove pending subtasks, reassign agents, modify prompts, change dependencies. It cannot modify completed tasks or their artifacts.

### 2.4 Task Statuses

```
pending_approval → todo → in_progress → completed
                              │              │
                              ▼              ▼
                           blocked        failed
                              │              │
                              ▼              ▼
                         (orchestrator   (retry or
                          replans)       escalate)
```

### 2.5 Three-Gate Validation Harness

Every agent task passes through a validation pipeline before being marked complete.

**Gate 1: Programmatic Validation** (always on, zero tokens)
- Did agent set task status to completed?
- Are required artifacts present?
- Do artifacts exist on disk and are non-empty?
- Schema validation if `artifactSchema` defined?
- Timeout check?

**Gate 2: Evaluator Agent** (default: on, Haiku model, ~pennies per call)
- Receives: original task prompt + expected output description + actual artifacts/summary
- Binary judgment: PASS or FAIL with one-sentence reason
- Strict but fair — partial useful result is PASS, empty/off-topic is FAIL

**Gate 3: Quality Review** (optional, configurable, Sonnet model)
- Adversarial review — checks completeness, accuracy, coherence
- Score 1-5 with detailed feedback
- Only triggered for tasks where `qualityReview: true`
- Threshold configurable (default: 3)

**On failure at any gate**:
- Same agent re-spawned with fresh context
- Receives: original task + failure reason + previous attempt summary
- Attempt counter tracked
- Max retries exceeded → mark failed → escalate to orchestrator for replan → notify user

### 2.6 Validation Configuration

```typescript
interface TaskValidation {
  // Gate 1: Programmatic (always on)
  requireArtifacts?: boolean;           // default: true
  artifactSchema?: ZodSchema;           // optional structured validation
  maxDurationMs?: number;               // timeout

  // Gate 2: Evaluator (default: on)
  evaluator?: boolean;                  // default: true
  evaluatorModel?: 'haiku' | 'sonnet';  // default: haiku
  evaluatorCriteria?: string;           // custom criteria

  // Gate 3: Quality review (default: off)
  qualityReview?: boolean;              // default: false
  qualityModel?: 'sonnet' | 'opus';    // default: sonnet
  qualityThreshold?: number;            // minimum score 1-5, default: 3

  // Retry policy
  maxRetries?: number;                  // default: 2
  retryBackoffMs?: number;             // default: 1000
  onMaxRetriesFailed?: 'fail' | 'escalate' | 'skip';  // default: escalate
}
```

**Defaults by context**:
- Ad-hoc tasks: Gates 1+2, 2 retries
- Template tasks: Gates 1+2, 2 retries (overridable per-task)
- High-stakes (red tier): Gates 1+2+3, 3 retries
- Quick lookups (green tier reads): Gate 1 only, 1 retry

### 2.7 Reliability Math

| Scenario | Per-step success | 10-step workflow |
|----------|-----------------|------------------|
| No harness | 90% | 35% |
| With 2 retries | 99.9% (1 - 0.1^3) | 99% |
| With 2 retries + evaluator | ~99.97% | 99.7% |

Retries are nearly free — each agent gets a fresh context window. No context rot from accumulated failures.

### 2.8 Task-Board Protocol (Agent Awareness)

Every agent gets task management awareness baked into its system prompt. When an agent starts work:

1. Claims or creates a Raven task — sets status to `in_progress`
2. Attaches artifacts as it works — files saved to `data/artifacts/{taskId}/`
3. Completes the task — sets status to `completed`, writes condensed summary
4. Returns to orchestrator: task ID + summary only (not full content)

The orchestrator passes task IDs to downstream agents, which read artifacts on-demand via the task API — just-in-time retrieval, not context pre-loading.

### 2.9 Task Artifact Schema

```typescript
interface TaskArtifact {
  type: 'file' | 'data' | 'reference';
  label: string;                      // "Schedule data", "Study notes"
  filePath?: string;                  // for file artifacts
  data?: Record<string, unknown>;     // for structured data (JSON-serializable)
  referenceId?: string;               // for linking to other tasks/sessions/knowledge
}
```

### 2.10 Built-In Agents

```yaml
# agents/_built-in/_evaluator.yaml
name: _evaluator
description: Validates task completion quality
model: haiku
maxTurns: 1
tools: [Read]
prompt: |
  You are a task completion evaluator. You receive:
  - TASK: The original task description and expected output
  - RESULT: The agent's output summary and artifact descriptions

  Evaluate with binary judgment:
  - PASS: The task was meaningfully completed. Output addresses the prompt.
  - FAIL: The task was not completed, output is empty/irrelevant/hallucinated,
    or critical requirements were missed.

  Respond in exactly this format:
  VERDICT: PASS or FAIL
  REASON: One sentence explaining why.

  Be strict but fair. A partial but useful result is PASS.
  An empty, off-topic, or "I cannot do this" response is FAIL.
```

```yaml
# agents/_built-in/_quality-reviewer.yaml
name: _quality-reviewer
description: Adversarial quality review for high-stakes tasks
model: sonnet
maxTurns: 3
tools: [Read, Grep, Glob]
prompt: |
  You are an adversarial quality reviewer. You receive a completed task
  and its artifacts. Your job is to find problems.

  Evaluate on these criteria:
  1. Completeness — does the output address ALL aspects of the task?
  2. Accuracy — are facts, dates, names correct?
  3. Coherence — is the output well-structured and logical?
  4. Usefulness — would the user find this valuable?

  Score 1-5 (1=unusable, 3=acceptable, 5=excellent).
  Provide specific, actionable feedback for any score below threshold.

  Format:
  SCORE: N
  FEEDBACK: Specific issues found (or "No issues" if score >= threshold)
```

### 2.11 Harness Principles Mapping

| Harness Principle | Implementation |
|-------------------|---------------|
| Architecture | Hybrid: task-tree engine (specialized sequential) + orchestrator (dynamic planning) |
| Planning | Orchestrator creates task tree (fixed plan), can replan on escalation (adaptive) |
| File Systems | `data/artifacts/{taskId}/` per-task workspace |
| Delegating Tasks | Task tree with agent assignments, parallel where no dependencies |
| Tool Guardrails | MCP isolation + graduated Bash access (Section 6) |
| Memory | Task artifacts (short-term), knowledge engine (long-term), context.md (persistent) |
| State Machines | Task status transitions in DB: pending_approval → todo → in_progress → completed/failed/blocked |
| Code Execution | `type: code` tasks run scripts deterministically |
| Context Management | Fresh context per agent, artifacts as files not prompt content |
| Human-in-the-Loop | Plan approval gate, `type: approval` tasks, permission tiers, Telegram notifications |
| Validation Loops | Three-gate validation pipeline with retry on failure |
| Agent Skills | Capability library with progressive disclosure |

---

## 3. Capability Library

### 3.1 Structure

Three separate, independently referenceable layers replace the current suite system.

```
library/
├── mcps/                              # MCP server definitions
│   ├── ticktick.json
│   ├── gmail.json
│   ├── google-calendar.json
│   ├── google-drive.json
│   ├── markdownify.json
│   └── monobank.json
│
├── skills/                            # Hierarchical skill library
│   ├── file-management/
│   │   ├── _index.md
│   │   ├── documents/
│   │   │   ├── _index.md
│   │   │   ├── pdf/
│   │   │   │   ├── skill.md           # Full instructions
│   │   │   │   ├── config.json        # MCPs, model, tools
│   │   │   │   └── examples/          # On-demand deep reference
│   │   │   │       ├── merge.md
│   │   │   │       └── ocr.md
│   │   │   ├── docx/
│   │   │   ├── xlsx/
│   │   │   └── pptx/
│   │   └── media/
│   │       ├── _index.md
│   │       ├── ffmpeg/
│   │       └── transcription/
│   │
│   ├── communication/
│   │   ├── _index.md
│   │   ├── email/
│   │   │   ├── triage/
│   │   │   ├── compose/
│   │   │   └── action-extract/
│   │   └── messaging/
│   │       └── telegram/
│   │
│   ├── productivity/
│   │   ├── _index.md
│   │   ├── task-management/
│   │   │   ├── ticktick/
│   │   │   └── raven-tasks/
│   │   ├── scheduling/
│   │   │   ├── calendar-read/
│   │   │   └── calendar-manage/
│   │   └── notes/
│   │       ├── knowledge-capture/
│   │       └── study-guides/
│   │
│   ├── finance/
│   │   ├── _index.md
│   │   ├── banking/
│   │   │   ├── monobank/
│   │   │   └── privatbank/
│   │   └── budgeting/
│   │       └── ynab/
│   │
│   └── system/
│       ├── _index.md
│       ├── task-board/
│       ├── knowledge-query/
│       └── config-management/
│
├── vendor/                            # External packages (git submodules)
│   ├── anthropic-skills/
│   ├── markdownify-mcp/
│   ├── smart-extractors/
│   └── claude-plugin-marketplace/
│
└── services/                          # Long-running background processes
    ├── imap-watcher/
    ├── telegram-bot/
    └── delivery-scheduler/
```

### 3.2 Progressive Disclosure (Three Tiers)

**Tier 0 — Discovery** (always in agent prompt): Skill catalog — names and one-line descriptions only.

```markdown
## Available Skills
- file-management/documents/pdf — Read, create, merge, split, OCR PDF files
- communication/email/triage — Categorize and prioritize emails
- productivity/scheduling/calendar-read — Read calendar events
```

**Tier 1 — Category index** (loaded when agent navigates to a domain): Agent reads `_index.md` to understand what's available and which skill to pick.

**Tier 2 — Skill instructions** (loaded on-demand via Skill tool): Agent loads `skill.md` when it decides to use a specific skill. Full operational instructions.

**Tier 3 — Deep reference** (loaded only when needed): Agent loads specific example files from `examples/` for complex sub-tasks.

### 3.3 Skill Config Schema

```json
{
  "name": "pdf",
  "displayName": "PDF Processing",
  "description": "Read, create, merge, split, OCR, watermark, encrypt PDF files",
  "domain": "file-management",

  "mcps": ["markdownify"],
  "vendorSkills": ["anthropic-skills/pdf"],
  "tools": ["Bash", "Read", "Write", "Skill"],
  "systemDeps": ["poppler-utils"],

  "model": "sonnet",
  "maxTurns": 10,

  "expectedOutputs": [
    { "type": "file", "description": "Processed PDF file" }
  ]
}
```

### 3.4 MCP Definitions

Standalone JSON files, referenced by name from skill configs:

```json
// library/mcps/ticktick.json
{
  "name": "ticktick",
  "displayName": "TickTick Task Manager",
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-ticktick/src/index.ts"],
  "env": {
    "TICKTICK_CLIENT_ID": "${TICKTICK_CLIENT_ID}",
    "TICKTICK_CLIENT_SECRET": "${TICKTICK_CLIENT_SECRET}",
    "TICKTICK_ACCESS_TOKEN": "${TICKTICK_ACCESS_TOKEN}"
  }
}
```

MCP namespacing still applies at runtime — when loaded, MCPs become `mcp__{mcpName}__*` tool patterns. But they're a shared library, not suite-owned.

### 3.5 Agent Capability Resolution

When resolving an agent's capabilities:

1. Read agent's `skills` list from YAML
2. Look up each skill in the library (by name, path-agnostic via index)
3. Collect all required MCPs (deduped across skills)
4. Build Tier 0 skill catalog for agent's system prompt
5. Skills loaded on-demand via Skill tool during execution

### 3.6 Vendor Integration

Vendor packages live under `library/vendor/` as git submodules. Referenced by skills via `vendorSkills` field. The `scripts/update-vendor.sh` script updated to point to `library/vendor/`.

---

## 4. Project-Centric File Structure

### 4.1 Hierarchy

Everything lives in one tree. Each level can define agents, templates, schedules, and context.

```
projects/
├── context.md                         # Global context (app-level)
├── agents/                            # Global agents
│   ├── raven.yaml
│   └── file-processor.yaml
├── templates/                         # Global templates
│   └── morning-briefing.yaml
├── schedules/                         # Global schedules
│   └── daily-briefing.yaml
│
├── uni-spring-2026/                   # Top-level project
│   ├── context.md
│   ├── agents/
│   │   └── academic-coordinator.yaml
│   ├── templates/
│   │   ├── exam-prep.yaml
│   │   └── weekly-review.yaml
│   ├── schedules/
│   │   └── check-classes-daily.yaml
│   ├── calculus/                      # Sub-project
│   │   ├── context.md
│   │   ├── agents/
│   │   │   └── calculus-assistant.yaml
│   │   └── templates/
│   │       └── problem-set-review.yaml
│   └── physics/                       # Sub-project
│       ├── context.md
│       ├── agents/
│       └── schedules/
│
├── freelance/
│   ├── client-a/
│   └── client-b/
│
└── personal/
    ├── finance/
    └── health/
```

### 4.2 Inheritance Model

When an agent runs in `projects/uni-spring-2026/calculus/`:

**Context** (bottom-up concatenation):
- `projects/context.md` (global)
- `projects/uni-spring-2026/context.md` (project)
- `projects/uni-spring-2026/calculus/context.md` (sub-project)

**Agents** (union, deeper level overrides same-name):
- `projects/agents/*.yaml` (global)
- `projects/uni-spring-2026/agents/*.yaml` (project)
- `projects/uni-spring-2026/calculus/agents/*.yaml` (sub-project)

**Templates** (same union pattern as agents)

**Schedules** (scoped — only run for their level + children)

### 4.3 Agent YAML Format

```yaml
# projects/uni-spring-2026/calculus/agents/calculus-assistant.yaml
name: calculus-assistant
displayName: Calculus Assistant
description: Helps with calculus coursework, exam prep, and lecture notes
isDefault: false

skills:
  - calendar-read
  - note-taking
  - study-guides
  - raven-tasks

instructions: |
  You are a calculus study assistant. You help with:
  - Understanding lecture material
  - Solving practice problems step-by-step
  - Preparing for exams
  - Organizing notes by topic

  Always show your work. Use LaTeX notation for formulas.

model: sonnet
maxTurns: 15

bash:
  access: none

validation:
  evaluator: true
  qualityReview: false
  maxRetries: 2
```

Agent project scope is determined by filesystem location — an agent in `projects/uni-spring-2026/calculus/agents/` is scoped to the calculus sub-project and its children.

### 4.4 Agent Storage

- Agent YAML files are the source of truth (not DB)
- On boot, system scans `projects/**/agents/` and loads all definitions
- Dashboard agent CRUD writes to YAML files on filesystem
- Git-committed, reviewable, diffable
- DB stores only runtime state (active sessions, task counts) — rebuilt from filesystem on boot

---

## 5. Agent Builder & Workflow Templates

### 5.1 Agent Builder

A built-in agent (`agents/_built-in/_agent-builder.yaml`) that scaffolds entire project domains from natural language descriptions.

**Trigger**: User says "Set up my university project" or uses dashboard "New Project Domain" button.

**Workflow**:
1. **UNDERSTAND** — Ask clarifying questions (tools/integrations, recurring patterns, agent needs, autonomy level)
2. **DESIGN** — Produce structured plan (project hierarchy, agents, templates, schedules)
3. **APPROVE** — Display plan to user, allow modifications
4. **SCAFFOLD** — Write all files (agent YAMLs, template YAMLs, context.md files, create project directories)
5. **VERIFY** — Run library validation, confirm all referenced skills exist

The builder uses the skill library `_index.md` files to know what skills are available when composing agents. It will not reference skills that don't exist.

### 5.2 Unified Task Templates

Task templates replace the pipeline system. A template is a pre-defined task tree with mixed node types that gets instantiated on-demand or by schedule.

### 5.3 Task Types

| Type | Execution | Cost | Use Case |
|------|-----------|------|----------|
| `agent` | Spawns agent with prompt, MCPs, validation | Tokens | Any LLM-driven work |
| `code` | Runs script/command, captures stdout as artifact | Zero | Deterministic operations, data fetching |
| `condition` | Evaluates expression, returns boolean | Zero | Branching logic |
| `notify` | Sends notification via channel | Zero | Telegram, email alerts |
| `delay` | Waits for duration then unblocks next | Zero | Scheduled follow-ups |
| `template` | Instantiates another template as subtask group | Varies | Composing workflows |
| `approval` | Pauses execution, waits for user input | Zero | Human checkpoints |

### 5.4 Template Format

```yaml
name: morning-briefing
displayName: Morning Briefing
description: Compile morning briefing from schedule, email, tasks, weather
trigger:
  - schedule: "30 7 * * *"
  - manual
params:
  date:
    type: string
    default: "today"

plan:
  approval: auto                       # auto | manual
  parallel: true                       # independent tasks run in parallel

tasks:
  # Agent tasks
  - id: check-schedule
    type: agent
    agent: academic-coordinator
    prompt: "Get today's events, deadlines, and classes for {{ date }}"
    validation:
      evaluator: true

  - id: triage-email
    type: agent
    agent: email-assistant
    prompt: "Summarize overnight emails, flag urgent ones"

  # Code tasks (zero tokens)
  - id: fetch-weather
    type: code
    script: "scripts/fetch-weather.ts"
    args: ["--city", "Kyiv"]

  # Condition tasks
  - id: has-exams
    type: condition
    expression: "{{ check-schedule.artifacts.data.exams.length }} > 0"
    blockedBy: [check-schedule]

  # Conditional agent task
  - id: exam-reminder
    type: agent
    agent: academic-coordinator
    prompt: "Create exam prep reminder for: {{ check-schedule.artifacts.data.exams }}"
    blockedBy: [has-exams]
    runIf: "{{ has-exams.result }}"

  # Synthesis
  - id: compile-briefing
    type: agent
    prompt: "Compile morning briefing from: schedule ({{ check-schedule.id }}), email ({{ triage-email.id }}), weather ({{ fetch-weather.output }})"
    blockedBy: [check-schedule, triage-email, fetch-weather]
    validation:
      qualityReview: true
      qualityThreshold: 3

  # System action
  - id: deliver
    type: notify
    channel: telegram
    message: "{{ compile-briefing.summary }}"
    blockedBy: [compile-briefing]

  # Delay + follow-up
  - id: evening-wait
    type: delay
    duration: "12h"
    blockedBy: [deliver]

  - id: end-of-day-review
    type: agent
    prompt: "Review what was accomplished today vs the morning briefing plan"
    blockedBy: [evening-wait]
```

### 5.5 Dynamic Fan-Out

The `template` task type with `forEach` enables dynamic expansion:

```yaml
  - id: per-subject-prep
    type: template
    template: exam-prep
    forEach: "{{ check-schedule.artifacts.data.exams }}"
    params:
      subject: "{{ item.subject }}"
    blockedBy: [check-schedule]
```

### 5.6 Template Interpolation

Uses Handlebars-style `{{ }}` syntax with a lightweight custom evaluator (not full Handlebars — just variable resolution and simple expressions). No complex logic in templates — use `type: condition` tasks for branching instead.

- `{{ param }}` — template parameters
- `{{ task-id.summary }}` — completed task's summary
- `{{ task-id.artifacts.data.field }}` — structured artifact data (dot-path traversal)
- `{{ task-id.output }}` — code task stdout
- `{{ task-id.result }}` — condition result (boolean)
- `{{ item }}` — current item in forEach iteration
- `{{ item.field }}` — field on current forEach item

Expressions in `type: condition` and `runIf` use JavaScript-safe evaluation (no eval — parsed AST with whitelisted operators: comparisons, boolean logic, `.length`, arithmetic).

### 5.7 Pipeline Migration

Everything the pipeline engine does, task templates can do:

| Pipeline Feature | Task Template Equivalent |
|-----------------|------------------------|
| DAG with nodes + connections | Tasks with `blockedBy` |
| Parallel execution | Tasks with no mutual dependencies |
| Data passing `{{ node.output }}` | `{{ task-id.artifacts }}` |
| Condition nodes | `type: condition` + `runIf` |
| Delay nodes | `type: delay` |
| Cron triggers | `trigger: schedule` |
| Event triggers | `trigger: event` |
| Error handling / retry | Validation pipeline + `maxRetries` |
| Code execution nodes | `type: code` |

Plus capabilities pipelines lack: agent validation gates, dynamic task tree modification, `forEach` fan-out, `type: approval` human checkpoints, ad-hoc creation by orchestrator.

---

## 6. Permissions & Tool Access

### 6.1 Graduated Bash Access

Instead of binary has-Bash / no-Bash, agents get scoped access defined in their YAML:

**`none`** — No Bash access. Only MCPs and built-in tools (Read, Write, Grep, Glob).

**`sandboxed`** — Whitelisted commands and paths. Harness intercepts and validates every Bash call.

**`scoped`** — Any command allowed within path boundaries. No command whitelist, but path restrictions enforced.

**`full`** — Unrestricted. Only for meta-project system admin. Requires red-tier per-session approval.

### 6.2 Bash Gate Configuration

```yaml
bash:
  access: sandboxed
  allowedCommands:
    - "ffmpeg *"
    - "ffprobe *"
    - "libreoffice --headless *"
    - "mkdir -p *"
    - "cp *"
    - "mv *"
  deniedCommands:
    - "rm -rf *"
    - "curl *"
    - "wget *"
  allowedPaths:
    - "data/artifacts/**"
    - "data/files/**"
    - "/tmp/raven-*"
  deniedPaths:
    - "projects/**"
    - "library/**"
    - ".env"
    - "config/**"
```

### 6.3 Enforcement

Code-level gate in agent session — not prompt-based, impossible to bypass:

1. Check access level (none → block immediately)
2. Parse command — extract binary, args, target paths
3. Validate command against allowedCommands / deniedCommands (deniedCommands takes precedence)
4. Validate all file paths within allowedPaths, none in deniedPaths
5. Parse pipe chains and subshells — validate ALL commands in chain
6. Log to audit trail
7. PASS → execute / FAIL → return error to agent with reason

### 6.4 Permission Tier Integration

| | Green (auto) | Yellow (act + report) | Red (ask first) |
|---|---|---|---|
| **none** | N/A | N/A | N/A |
| **sandboxed** | Whitelisted runs silently | Logged + reported | Non-whitelisted queued for approval |
| **scoped** | Read operations | Write operations | Destructive operations |
| **full** | Read operations | Write operations | All write + destructive |

### 6.5 Organic Permission Growth

For commands not in the whitelist, the agent can request elevated access:

1. Agent attempts command outside its whitelist
2. Bash gate blocks, creates approval request
3. Telegram notification: "file-processor wants to run: `pandoc input.md -o output.epub`. Allow? [Yes] [Yes + Remember] [No]"
4. "Yes + Remember" adds the command pattern to agent's `allowedCommands` in YAML (committed to git)

Permissions grow organically — agents start restrictive, expand as needed through use.

### 6.6 Mandatory Deny Rules

Regardless of access level, these are always denied (enforced by validation, cannot be overridden):

- `.env` in deniedPaths
- `.git/` in deniedPaths
- `rm -rf /` and similar catastrophic patterns in deniedCommands

---

## 7. Validation

### 7.1 Library Validation (`library/validate.ts`)

Run on build, CI, and before agent builder scaffolding:

**Skill validation**:
- Every skill directory has `skill.md` + `config.json`
- Every `_index.md` lists all child skills in its directory
- All `mcps` references resolve to `library/mcps/*.json`
- All `vendorSkills` references resolve to `library/vendor/`
- `systemDeps` are documented
- No orphaned skills (exist but not in any `_index.md`)
- `config.json` validates against SkillConfig Zod schema

**MCP validation**:
- Every MCP JSON has `name`, `command`, `args`
- Environment variables referenced in `env` are documented
- No duplicate MCP names

### 7.2 Project Validation (`projects/validate.ts`)

**Agent YAML validation**:
- Schema validation via Zod (name, skills, model, bash config)
- All `skills` references resolve to existing skills in library
- `bash.access: full` only allowed in global agents directory
- `bash.deniedPaths` always includes `.env`, `.git/`
- `bash.allowedCommands` are valid glob patterns
- `bash.allowedPaths` don't escape project root
- No duplicate agent names within same scope

**Template YAML validation**:
- Schema validation (tasks array, dependencies, types)
- All `blockedBy` references point to existing task IDs within same template
- All `agent` references resolve to agents accessible at the template's scope level
- `runIf` expressions are syntactically valid
- No circular dependencies (DAG validation — reuse existing logic from pipeline engine)
- `type: code` tasks reference existing scripts
- `type: template` references resolve to existing templates

**Schedule YAML validation**:
- Valid cron expressions
- Referenced templates exist
- Timezone is valid

**Project structure validation**:
- Every directory with agents/templates/schedules has a `context.md`
- No deeply nested projects beyond 3 levels (global → project → sub-project)
- No name collisions across sibling projects

### 7.3 Runtime Validation

- Agent capability resolution validates all skill references at boot
- Template instantiation validates params and interpolation expressions
- Task execution engine validates task state transitions
- Bash gate validates every command at execution time

---

## 8. DB vs Filesystem Storage

### 8.1 Principle

**Filesystem** (source of truth, git-committed): If losing it means you can't reconstruct the system.

**DB** (runtime state, queryable, ephemeral): If losing it means you lose history/stats but the system still works.

### 8.2 Filesystem Stores

| Data | Location | Format |
|------|----------|--------|
| Agent definitions | `projects/**/agents/*.yaml` | YAML |
| Task templates | `projects/**/templates/*.yaml` | YAML |
| Schedules | `projects/**/schedules/*.yaml` | YAML |
| Project context | `projects/**/context.md` | Markdown |
| Skill library | `library/skills/**/` | MD + JSON |
| MCP configs | `library/mcps/*.json` | JSON |
| Vendor packages | `library/vendor/` | Git submodules |
| Services | `library/services/` | TypeScript |
| Permission configs | `config/permissions.json` | JSON |
| Built-in agents | `agents/_built-in/*.yaml` | YAML |

### 8.3 DB Stores

| Data | Purpose | Can be lost? |
|------|---------|-------------|
| Task instances | Running/completed task trees with artifacts | Lose history, system works |
| Agent task execution records | Duration, status, errors, prompt/result | Lose audit trail |
| Audit logs | Permission checks, action outcomes | Lose compliance trail |
| Event timeline | Chronological event feed | Lose activity history |
| Metrics/stats | Aggregated performance data | Lose dashboards |
| Session transcripts | Conversation message history | Lose chat history |
| Knowledge bubbles | User knowledge entries | Important but reconstructable |
| Notification state | Delivery tracking, snooze state | Lose notification history |
| Approval queue | Pending permission approvals | Active approvals lost |

### 8.4 What Moves OUT of DB

| Data | Current | Proposed |
|------|---------|----------|
| Named agents | `named_agents` table + `config/agents.json` | `projects/**/agents/*.yaml` only |
| Pipeline definitions | `pipeline_runs` metadata | `projects/**/templates/*.yaml` |
| Schedule definitions | `schedules` table | `projects/**/schedules/*.yaml` |
| Skill/suite configs | `config/suites.json` + `config/skills.json` | `library/skills/**/config.json` |

DB retains only the index/cache of these (rebuilt from filesystem on boot) for fast API queries.

---

## 9. Migration Path

### Phase 1: Capability Library
- Create `library/` structure
- Extract MCPs from `suites/*/mcp.json` → `library/mcps/`
- Extract skills from suite agents → `library/skills/`
- Move vendor from `vendor/` → `library/vendor/`
- Extract services from suites → `library/services/`
- Build skill validation
- Update agent resolver to read from library

### Phase 2: Project Hierarchy
- Create `projects/` structure
- Migrate `config/agents.json` entries → `projects/agents/*.yaml`
- Add project hierarchy support (parent directories = parent projects)
- Migrate context from DB project descriptions → `projects/**/context.md`
- Update dashboard for hierarchy navigation

### Phase 3: Task Execution Engine
- Extend task types with `pending_approval`, `blocked` statuses
- Build task execution engine (dependency resolution, auto-triggering)
- Implement three-gate validation harness (programmatic, evaluator, quality)
- Add task-board protocol to agent system prompts
- Implement retry with feedback

### Phase 4: Unified Templates
- Create template YAML schema and loader
- Implement all task types (agent, code, condition, notify, delay, template, approval)
- Implement `forEach` dynamic fan-out
- Implement `runIf` conditional execution
- Build template interpolation engine
- Migrate existing pipelines → templates
- Template validation

### Phase 5: Permissions
- Implement graduated Bash access (none/sandboxed/scoped/full)
- Build Bash gate (command parsing, path validation)
- Implement "Yes + Remember" approval flow
- Add bash config to agent YAML schema
- Mandatory deny rules enforcement

### Phase 6: Agent Builder
- Build agent builder agent
- Implement project domain scaffolding workflow
- Template generation from natural language
- Dashboard "New Project Domain" UI

### Phase 7: Dashboard Updates
- Project hierarchy view (tree + flat toggle)
- Template management UI
- Task tree visualization
- Agent YAML editor
- Skill library browser
- Validation status indicators

---

## References

- [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [HumanLayer: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Anthropic's Harness Design Philosophy Evolution](https://www.working-ref.com/en/reference/anthropic-harness-design-philosophy-evolution)
- [The Third Evolution: Harness Engineering](https://www.epsilla.com/blogs/harness-engineering-evolution-prompt-context-autonomous-agents)
- [Progressive Disclosure for AI Agents](https://pub.towardsai.net/progressive-disclosure-in-ai-agent-skill-design-b49309b4bc07)
- [Claude Agent SDK: Subagents Documentation](https://platform.claude.com/docs/en/agent-sdk/subagents)
