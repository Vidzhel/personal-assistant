# Consolidated Orchestration, Agent Memory & Pipeline Self-Healing — Design

**Date:** 2026-06-11
**Status:** Approved by user (brainstorming session)

## Overview

Raven's agentic platform gets four coordinated improvements:

1. **Consolidation** — one source of truth for agent definitions (filesystem YAML); DB reduced to runtime state. Fixes the drift caused by three parallel agent stores.
2. **Flexible orchestration** — a new `agentic` pipeline node type: instead of rigid steps, a node carries instructions, a lead agent, and a roster of agents it may delegate to (modeled on Claude managed agents' coordinator pattern).
3. **Pipeline-manager agent** — builds pipelines conversationally and monitors pipeline health, proposing approval-gated repairs when runs fail (rigid config fixes and agentic prompt tuning alike).
4. **Layered agent memory** — per-agent file memory with a hard budget and idle-time "dreaming" consolidation, plus delegated knowledge-engine recall via a dedicated sub-agent.

Plus one bug fix: **Telegram topic persistence** — stop creating duplicate forum topics for agents on every boot.

Implementation approach (chosen over alternatives): extend the existing pipeline engine directly. The v2 task-execution engine (task trees, three-gate validation) is **not** a dependency of this work; it can land later under the same node model.

## 1. Consolidation & data model

### Agent definitions: filesystem only

`projects/agents/` moves from flat files to a directory per agent:

```
projects/agents/
├── raven/
│   ├── agent.yaml          # definition: name, displayName, description,
│   │                       # instructions, model, skills, roster, maxTurns,
│   │                       # bash access, validation, memory budget
│   └── memory/
│       ├── MEMORY.md       # index — injected into the agent's system prompt
│       └── *.md            # one fact/topic per file
├── _pipeline-manager/
│   └── agent.yaml
├── _evaluator/
├── _quality-reviewer/
├── _agent-builder/
└── knowledge-researcher/
    └── agent.yaml          # the ONLY agent carrying the knowledge MCP
```

- `config/agents.json` is **deleted**. `named-agent-store.ts` is replaced by the
  existing agent YAML store (extended for the directory-per-agent layout).
- The `named_agents` DB table is reduced to runtime state only, or dropped if
  nothing runtime remains. No dual-write, no sync.
- One-time migration: move flat `projects/agents/*.yaml` into directories,
  fold `config/agents.json` entries in, delete legacy paths. Migration is
  aggressive by explicit user decision (single-user system, no external
  consumers).

### DB holds runtime state only

Sessions, messages, agent tasks, pipeline runs, pipeline proposals (new),
telegram topic mappings (new). Definitions (agents, pipelines, templates,
schedules) live on the filesystem and are git-tracked.

### New table: `telegram_topics`

| column     | type    | notes                          |
|------------|---------|--------------------------------|
| scope      | TEXT    | `agent` \| `project`           |
| key        | TEXT    | agent name or project id       |
| group_id   | TEXT    | telegram group                 |
| topic_id   | INTEGER | forum topic id                 |
| created_at | TEXT    |                                |

Primary key: `(scope, key, group_id)`.

## 2. Agentic pipeline nodes

New node type alongside the existing rigid ones (`agent`, `code`, `condition`,
`delay`, `notify`, `approval`, `template`):

```yaml
- id: digest-research
  type: agentic
  agent: researcher                  # lead agent (from projects/agents/)
  instructions: |
    Gather today's items from the inbox artifacts of the previous node.
    Decide yourself what's worth including. If you need historical context,
    ask the knowledge-researcher. Hand polished sections to the writer.
    Done when: a markdown digest exists at {{ artifacts.dir }}/digest.md.
  roster: [knowledge-researcher, writer]   # who the lead may delegate to
  maxTurns: 40
  timeout: 10m
```

### Execution semantics

- The executor resolves the lead agent and every roster member from the YAML
  store and runs **one SDK `query()`** with roster members passed via the
  SDK `agents` option. The SDK's native sub-agent mechanism provides the
  managed-agents coordinator pattern: the lead decides whom to call and when,
  reads results, and steers — no scripted routing, no custom thread management.
- Roster members carry their own MCPs (MCP isolation rule unchanged). The lead
  carries only its own declared capabilities.
- Node interpolation (`{{ node.output }}`, `{{ artifacts.dir }}`) works as for
  rigid nodes; instructions are interpolated before spawn.
- Node output = final result text + declared artifacts + full message
  transcript, stored on the pipeline run record like any rigid node. Rigid and
  agentic nodes mix freely in one DAG: rigid where precision matters, agentic
  where judgment matters.
- `maxTurns` and `timeout` are hard limits; breach fails the node through the
  normal failure path (which feeds pipeline-manager health monitoring).

## 3. Pipeline-manager agent

Built-in agent `_pipeline-manager` defined like any other agent. Two jobs:

### Conversational pipeline building

- Reachable via dashboard project chat or its Telegram topic.
- Carries a small **in-process MCP**: `pipeline_list`, `pipeline_get`,
  `pipeline_validate(yaml)`, `pipeline_save(yaml)`, `run_history(name)`,
  `run_logs(runId)`.
- Drafts YAML (rigid, agentic, or mixed), validates via the existing schema +
  DAG validator, shows the user the result, saves only on user confirmation
  (same path as `PUT /api/pipelines/:name`).

### Health monitoring & self-healing

- Orchestrator routes `pipeline:run:failed` events to it.
- It pulls the run record + node logs, diagnoses, and drafts a **repair
  proposal**: a YAML diff for rigid breakage (e.g., changed file format →
  adjust a code node's args) or an instruction/prompt edit for an
  underperforming agentic node.
- Proposals persist in a new `pipeline_proposals` table (id, pipeline name,
  run id, diff, rationale, status `pending|approved|rejected|applied`,
  timestamps) and surface via Telegram + dashboard with diff and reasoning.
- **Nothing applies without user approval.** On approval it applies the edit
  and offers to re-trigger the failed run.
- Repeated failures of the same pipeline escalate ("3rd failure, last fix
  didn't hold") instead of spamming similar proposals.

## 4. Layered agent memory

### Layer 1 — file memory (direct)

- Every agent owns `projects/agents/<name>/memory/`; `MEMORY.md` index is
  injected into its system prompt at spawn.
- Three in-process memory tools, scoped strictly to the agent's own directory:
  `memory_read`, `memory_write`, `memory_update`. Path validation prevents
  escaping the directory; writes are atomic.
- Format: one fact/topic per file, one-line index entry per file in
  `MEMORY.md`. Human-editable, git-tracked.

### Hard memory budget

- Per-agent config in `agent.yaml`:
  `memory: { maxFiles: 30, maxTotalKb: 64 }` (defaults shown).
- Enforced **programmatically, not by prompt**: `memory_write` /
  `memory_update` reject any operation that would exceed the budget. The error
  returns current usage and instructs the agent to consolidate or prune first.
  At the cap, an agent must curate before it can save anything new.

### Layer 2 — knowledge engine (delegated, never direct)

- Working agents do **not** carry the knowledge MCP. A `knowledge-researcher`
  sub-agent — the only carrier of the knowledge MCP — is auto-appended to every
  agent's roster.
- Agent prompts instruct: for historical/semantic recall beyond your own
  memory, ask `knowledge-researcher`; to save noteworthy findings to the
  shared knowledge base, hand them to `knowledge-researcher`.
- This preserves the MCP isolation rule and the direction of the recent MCP
  refactor (agents pull context via MCP-carrying sub-agents).

### Dreaming (idle-time consolidation)

- A scheduler job per agent (default nightly, configurable) runs only when the
  agent is idle **and** has new activity since its last dream; otherwise skips
  silently.
- The dream run spawns the agent with only its memory tools, a memory usage
  report, and summaries of its sessions/tasks since the last dream (no
  external MCPs; `knowledge-researcher` in roster for promotions).
- Dream instructions: extract durable facts and lessons; merge or rewrite
  existing entries; rearrange the index; prune stale or low-value entries;
  promote anything of cross-agent value to the knowledge engine **before**
  deleting it locally (promotion is the escape valve for the budget).
- Dream runs are ordinary agent tasks (`source: 'dream'`) — visible in the
  activity feed and run history. Last-dream timestamp stored in DB.

## 5. Telegram topic persistence (bug fix)

Root cause: `suites/notifications/services/telegram-bot.ts` keeps the
agent→topic mapping only in an in-memory `Map`; every boot re-creates forum
topics for all agents.

Fix:

- `ensureAgentTopic()` / `ensureProjectTopic()` consult the `telegram_topics`
  table before creating; write the mapping after creating.
- If Telegram reports a stored topic missing/deleted, recreate **once** and
  update the row — never loop.
- The in-memory map remains as a per-process cache in front of the table.
- Existing duplicate topics: user cleans up manually in Telegram; on next boot
  the bot records whichever topic it is configured/first to use.

## 6. Error handling

- Agentic node limit breaches fail the node through the normal pipeline
  failure path.
- Memory tools: path validation, atomic writes, programmatic budget rejection.
- Pipeline-manager proposals never auto-apply; repeated-failure escalation
  prevents proposal spam.
- Telegram topic recreation is single-shot per boot per key.

## 7. Testing

Per project testing philosophy (integration-first, mocked SDK, temp DBs):

- Pipeline run with mixed rigid + agentic nodes end-to-end (SDK mocked,
  roster delegation asserted via `agents` option passed to `query()`).
- Pipeline-manager flow: failure event → diagnosis → proposal persisted →
  approval → applied YAML → optional re-trigger.
- Memory tools: read/write/update, directory-scope enforcement, budget
  rejection at the cap.
- Dreaming: skip-when-idle/no-activity; consolidation run writes within
  budget; promotion handoff invoked.
- Telegram topics: persistence across simulated restarts (temp DB), stale
  topic recreation happens exactly once.
- Migration regression: agent-store consolidation produces directory layout,
  legacy stores removed, resolver finds every previously defined agent.

## 8. Out of scope

- v2 task-execution engine completion (task trees, three-gate validation,
  `needs_replan`) — deferred, compatible with this design.
- Suites → capability library migration beyond what agent consolidation
  requires.
- Dashboard redesign (only the proposal approval surface and agent memory
  views are touched as needed).

## 9. Decision log

| Decision | Choice |
|---|---|
| Sequencing | Design first; telegram fix is task #1 of the implementation plan |
| Orchestration model | Hybrid: keep rigid pipelines, add `agentic` nodes (instructions + lead + roster); SDK `agents` option for delegation |
| Self-healing autonomy | Propose → user approves; covers rigid config and agentic prompts |
| Memory | Layered: per-agent file memory + delegated knowledge engine |
| KB access | Agents must delegate knowledge-base exploration to a sub-agent, never direct |
| Memory limits | Hard per-agent budget, programmatically enforced |
| Dreaming | Idle-time retrospective consolidation per agent, scheduler-driven |
| Consolidation | Aggressive: filesystem YAML is the sole agent definition source |
