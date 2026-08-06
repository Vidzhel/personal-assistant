# Raven — Final Architecture Assessment

*Prepared for the owner. Based on six codebase maps, four independent judge assessments, external research on the 2025–2026 agent ecosystem, and spot-checks against the repo at `/home/user/projects/personal-assistant` (verified: `ravenMcpDeps` appears only in `agent-manager.ts`/`agent-session.ts`, never `index.ts`; no `resume` in any backend; `linkSdkSession` has zero callers).*

---

## 1. Executive summary

Raven's philosophy — filesystem as source of truth, YAML-defined agents, per-agent markdown memory, MCP isolation, one event contract across web/WS/Telegram — is exactly where the field converged in 2026, but its execution layer is five unfinished generations stacked on each other, and every mission-defining loop is severed at one wire: chat has no memory (no SDK `resume`, transcript never injected, so every turn is a cold agent), task trees can never complete (`onTaskCompleted`'s only caller lives behind a Raven MCP that `index.ts` never constructs — trees stuck "running" since 2026-03-30), memory has no write path (`projects/agents/raven/memory/MEMORY.md` says "(no memories yet)" after five months), and the no-code extension story exists as five fragments none of which reaches from chat to a live capability. The live database proves the system does not work: `pipeline_runs` shows 22 failed / 0 completed, the last logged boot loaded zero of ten suites ("Unknown file extension .ts"), and nothing ever told the owner. Meanwhile the Claude Agent SDK now ships natively most of what Raven hand-rolled worse — sessions/resume, compaction, skills, per-subagent MCP scoping, `canUseTool` permission enforcement, the Workflow tool — so for a single maintainer, the fixes and the deletions are largely the same move. The mandated quality gate (`npm run check`) is red on clean master with no CI to notice, and the one "E2E" test hand-assembles a parallel universe instead of booting the real 620-line composition in `index.ts`, so per-file tests are green while the system is red. The path forward is not a rewrite: close two or three severed wires, delete roughly half the concept inventory, delegate the agent runtime to the SDK, and finish exactly one extension path the way the June 2026 schedule-engine unification was finished — migrate AND delete.

---

## 2. What Raven gets right

These should survive any redesign:

- **One event contract, three front doors.** Web REST (`packages/core/src/api/routes/chat.ts`), WebSocket (`api/ws/handler.ts`), and Telegram (`suites/notifications/services/telegram-bot.ts`) all emit the identical `user:chat:message` event and consume the same reply stream. The "talk to it from anywhere" topology is done and correct.
- **Filesystem-as-source-of-truth for definitions**, with git auto-commit of agent edits (`agent-registry/config-committer.ts`). Letta's MemFS pivot, Anthropic's memory tool, and OpenClaw's "no hidden state" rule all validate this bet. The substrate is right even where the wiring is broken.
- **The per-agent memory store** (`agent-memory/memory-store.ts`): YAML-declared budgets, atomic writes, path-traversal guards, `MEMORY.md` injected into the system prompt. The read side of the correct 2026 memory design, already wired.
- **The June 2026 schedule engine** (`scheduler/`): 9 YAML schedules migrated, legacy Scheduler class and DB rows deleted (migrations 026/029, commits 8122952/ce580f2), YAML-declares/DB-overrides pattern. The one generation executed end-to-end — and the proof the owner can finish a consolidation when it's scoped as "migrate and delete."
- **MCP isolation as a stated principle.** The rule is inverted in code today, but the instinct — context breadth is the scarce resource — is correct and is now directly expressible in the SDK (`AgentDefinition.mcpServers` + `disallowedTools: ['mcp__*']`).
- **The Telegram bot and Next.js dashboard** are legitimate custom surface no runtime provides. `bash-gate/` is the model module: single purpose, single consumer, well tested. The TaskBoard (`packages/web/src/components/board/`) already merged manual tasks and agent plans into one owner-facing concept — the right unification instinct.
- **Real testing discipline at the unit level**: 147 test files, SDK consistently mocked, temp SQLite per test, almost no cosmetic tests. The discipline exists; the targets are wrong.

---

## 3. Core problems

Ordered by how much each blocks the mission.

### 3.1 The brain has no short-term memory — every turn is a cold agent

**Evidence:** `agent-manager/prompt-builder.ts` (58 lines) reads only `task.projectContextChain` — no transcript, ever. `agent-backend.ts` has no field for resumption; neither `cli-backend.ts` nor `sdk-backend.ts` passes `resume`/`--resume`. `SessionManager.linkSdkSession` (session-manager.ts:46) has zero callers; `sessions.sdk_session_id` is dead schema. The orchestrator's own prompt guideline ("if the conversation history shows a tool failed, do NOT retry") is unenforceable fiction because history is never shown. Meanwhile ~1,160 LOC of hand-rolled session machinery (message-store, session-compaction, idle-detector, session-references) persists a transcript the agent never sees — `session-compaction.ts` summarizes history for an agent that receives no history.

**Why it's first:** multi-turn work ("now book the second one"), preference continuity, and everything else in the mission sit on top of this hole. The SDK ships `resume`, `forkSession`, `sessionStore`, and native compaction; Raven uses none of them.

### 3.2 Complex-task execution structurally cannot finish

**Evidence:** `TaskExecutionEngine.onTaskCompleted()` — the only method that advances a tree, unblocks dependents, runs validation, or marks completion — has exactly one non-test caller: `mcp-server/tools/task-lifecycle.ts:107`, inside the Raven MCP, which is never constructed because `index.ts` never passes `ravenMcpDeps` (verified). Commit 59465c9 (2026-03-29) deliberately deleted the working `agent:task:complete → onTaskCompleted` bridge; the replacement was never switched on. Live DB: 2 task trees stuck "running" since 2026-03-30, including a morning-briefing tree. The `execution:task:run-agent` bridge (index.ts:247-280) additionally drops the template's `agent` field and hardcodes `skillName:'orchestrator'`, `mcpServers:{}` — so even a fixed loop would run every node capability-less. And `orchestrator.ts:346-354` instructs the model to call `classify_request`/`create_task_tree`/`send_message` — tools that do not exist at runtime.

**The deeper ceiling:** even wired, completion depends on the model volunteering a tool call. The runtime never observes that a run finished. Durable multi-step work requires the runtime, not the model, to own lifecycle transitions.

### 3.3 Three workflow engines, five definition directories, zero automations that complete

**Evidence:** pipeline-engine (`config/pipelines/`), legacy task-templates (`config/task-templates/`), and v2 templates+schedules (`projects/templates/`, `projects/schedules/`) all load at boot. Pipelines are provably dead — `pipeline_runs`: 22 failed / 0 completed, every failure "Suite not found: gmail/ticktick" because nodes name pre-rename suites — yet stay cron-armed every boot. The same briefing is defined three times (pipeline at 06:00, `morning-digest.yaml` at 08:00, `morning-briefing.yaml` at 09:00); system-maintenance fires from two independent cron systems in the same minute. An owner reading the repo cannot answer "where do I define an automated behavior?"

### 3.4 MCP isolation — the project's own Critical Rule — is inverted

**Evidence:** every agent YAML on disk declares `skills: []`, and `yaml-named-agent-store.ts:64` hardcodes `suiteIds: []`, so `agent-resolver.ts:78-91` takes the DEFAULT/ALL branch and resolves the *entire* capability library — all 14 sub-agents and all 3 MCPs — onto the top-level `query()` for every chat turn, with `mcp__<name>__*` wildcards pushed into the parent's `allowedTools` (`agent-session.ts:279-284`). CLAUDE.md says "MCPs are NEVER loaded into the main orchestrator agent context." The code does the exact opposite, and the web Skills picker (`AgentFormModal.tsx:246`) writes suite names the library silently drops.

### 3.5 Two complete capability systems, each holding half of a working whole

**Evidence:** `suites/` (10 dirs, ~10.7k LOC) still owns all long-running services, the only action set the permission engine reads (`permission-engine.ts:80` reads `suiteRegistry.collectActions()` only; `capabilityLibrary.collectActions()` has zero callers), and 4 of 7 job handlers. `library/` owns what agents can actually do. Every integration exists twice (16 actions byte-duplicated, 30 same-concept-renamed; `packages/mcp-ticktick` declared in both `library/mcps/ticktick.json` and `suites/task-management/mcp.json`). The halves disagree: suites env-gate correctly, the library has no `requiresEnv` and advertises transcription/transactions skills whose credentials are missing. Worse, `suites/` sits outside every tsconfig include and ESLint glob — un-typechecked, un-linted — and loads only under `--experimental-strip-types`, which `npm run start:core` and `Dockerfile.core` lack. **The last logged boot (data/logs/raven.1.log) shows all ten suites failing** — no Telegram bot, no IMAP watcher, no TickTick sync — and the brain was deaf without reporting it. `library/services/README.md` still says migration "will happen in Phase 2."

### 3.6 No write path into memory, no learning from outcomes

**Evidence:** retrospective bubbles go to Neo4j, which no agent can query — the knowledge MCP tools live in the unwired Raven MCP; `knowledge-agent.ts` declares `tools: []` while naming three nonexistent tools; `_contextInjector` is created and discarded in `index.ts`. Result: after five months, `MEMORY.md` contains "(no memories yet)". `agent_tasks` records every outcome and `pipeline_runs` records 22 consecutive failures — and no job, component, or prompt ever reads either signal. The three-gate validation harness exists but is opt-in per node and no shipped template opts in. Neo4j is meanwhile a hard boot dependency and a Docker service — heavy infra the field walked away from (Letta went git-backed markdown; mem0 removed its graph store; the LoCoMo benchmark that justified graph memory is discredited) — serving zero functioning agent consumers.

### 3.7 No prospective memory

**Evidence:** grep for remind/standing-intent/prospective across `packages/core/src` returns no implementation. "Remind me when X" can only exist as prose in a transcript the agent never re-reads. The proactive-intelligence suite infers patterns — precisely the approach OpenClaw shipped, measured, and retired ("inferred commitments" removed in favor of explicitly compiled intents). Scheduled YAML requires a process restart to arm.

### 3.8 "Extend without writing code" exists as five severed fragments

**Evidence:** (a) `POST /api/scaffold/*` writes valid YAML but `templateRegistry.load()` and `scheduleEngine.start()` run exactly once at boot — scaffolded artifacts are inert until restart; scaffolds are never git-committed; `scaffoldDomain` has zero non-test callers. (b) `_agent-builder` is unreachable from any UI (chat always routes to `namedAgentStore.getDefaultAgent()`), has `bash: none` and no Write tool, and is instructed to WebFetch-to-localhost — the anti-pattern the team's own Mar-29 MCP spec was written to kill. (c) The suite scaffolder generates TypeScript into the dead layer. (d) The config-approval chain (`config-approval-handler.ts`) never starts; `POST /api/config-changes/:id` returns 501. (e) CLAUDE.md, README, and ARCHITECTURE.md all teach `packages/skills/skill-<name>/` implementing `RavenSkill` — a directory and interface with zero implementers. The adaptation ceiling today is "owner edits YAML and restarts the process," i.e., writing code.

### 3.9 Two disconnected models of the owner's life

**Evidence:** a "project" is simultaneously a SQLite row and a filesystem node, joined by case-insensitive name match (`orchestrator.ts:295-308`, `routes/projects.ts` `enrichWithRegistry`). Telegram's `ensureProject()` inserts DB rows named after raw topic IDs that can never match; `projects/system/` (holding the only bash-capable agent) has no DB row and is unreachable from chat. After five months, the DB holds 3 rows ("Tasks manager", "telegram-default", "meta") and the filesystem tree has zero actual life domains — the taxonomy of the owner's life was never built.

### 3.10 Permissions are theater

**Evidence:** both backends run `bypassPermissions` (with `--dangerously-skip-permissions` on the CLI path); the bash gate audits commands *after* the SDK executed them ("observational — SDK already executed the command", `agent-session.ts:352`); `resolveTier()` is invoked only from the dead pipeline path, so chat and template tasks are never tier-gated; graduated bash levels (sandboxed/scoped/full) are runtime-identical. Forward-compat break pending: the TS SDK now requires `allowDangerouslySkipPermissions` alongside `bypassPermissions` and refuses it as root — the next SDK bump breaks the Docker deployment. Three approval subsystems exist (red-tier approvals: Telegram-only, no web UI; config-changes: page orphaned from nav, its SSE endpoint doesn't exist; task-tree `pending_approval`: its only UI is unreachable dead code). The owner cannot see everything Raven is asking permission for anywhere.

### 3.11 No deletion discipline, red gate, no CI

**Evidence:** `npm run check` exits 1 on clean master (37 ESLint errors); `npm test` has 6 non-flaky failures from test/implementation drift; no `.github/workflows` exists. Standing inventory of dead or lying artifacts: `orchestrator/task-queue.ts` (zero importers), `RavenSkill`/`config/skills.json` (unread), `TaskTreeView.tsx` (unreachable), `scripts/test-skill.ts` (imports deleted `packages/skills/`), the Settings page pointing owners at a dead config file, `/config` page opening an EventSource on an unregistered route, docs naming the wrong SDK package (`@anthropic-ai/claude-code` vs the real `@anthropic-ai/claude-agent-sdk`), and Neo4j required for green tests but undocumented. A red gate is worse than no gate: it trains every agent session to treat failures as "pre-existing."

---

## 4. What the field learned (2025–2026)

1. **The agent loop is ~1.4% of the problem — be a gateway, not an orchestrator.** OpenClaw (~385k stars, the category reference) has no event-bus-DAG-planner stack; its vendored agent core is 5,851 lines out of ~417k. Its VISION.md bans "manager-of-managers / nested planner trees" and "heavy orchestration layers that duplicate existing agent and tool infrastructure." The value is in channels, sessions, scheduling, approvals, memory, and skills. Raven built three orchestration engines and zero of them complete.

2. **File-first memory won; graphs and vector DBs were demoted to derived indexes.** Letta — the MemGPT authors — made git-backed markdown (MemFS) the *default*, a reversal by the people most committed to the alternative. Anthropic's memory tool is a filesystem API. mem0 removed its external graph store. The LoCoMo benchmark justifying graph memory was discredited (a full-context baseline beat the memory systems). Raven's Neo4j dependency is a distributed-systems tax on a note-taking problem.

3. **Writing is the hard part of memory; curation runs in the background behind deterministic gates.** OpenClaw: unforgeable provenance columns (`owner`/`agent`/`untrusted`/`system`), session-kind gating (cron/heartbeat/subagent runs produce *no* durable memory candidates — production audits found auto-captured memory was overwhelmingly scaffolding noise), recall-loop prevention, promotion only via gated background consolidation. Raven has the read side and no write side.

4. **Prospective memory gets compiled out of the model.** OpenClaw turns "remind me Friday" into a cron row at utterance time and event intents into SQLite rows matched by deterministic FTS — zero model calls, fire budgets (3), cooldowns (24h), expiry (90d). Its LLM-inferred-commitments feature was shipped, measured, and **retired**. Raven's proactive-intelligence suite is re-running the retired experiment.

5. **Proactivity decomposes into five mechanisms with silence as default.** Cron (exact, isolated session, task record), heartbeat (approximate, main session, `HEARTBEAT_OK` silence contract, busy-deferral, activeHours, cost guards — early OpenClaw users burned ~$250/week on idle heartbeats), standing intents, hooks, standing orders (authority in markdown). LifeOS's notification-governor states the finding plainly: "alert fatigue is the dominant failure mode — cap nudge volume structurally before building anything else."

6. **Skills standardized on markdown directories with declarative gating.** SKILL.md + frontmatter, discovered from the filesystem, gated by `requires.bins/env/config`, progressive disclosure (descriptions at startup, body on invoke) — OpenClaw, Hermes, agentskills.io, and the Claude Agent SDK itself (`settingSources`/`plugins`). No package.json, no compile step. Raven's live extension unit is un-typechecked TypeScript.

7. **The SDK runtime now owns sessions, permissions, and orchestration.** `resume`/`forkSession`/`sessionStore`, native compaction, `canUseTool` + PreToolUse hooks, per-subagent `mcpServers` + `disallowedTools`, budgets, and the **Workflow tool** — the model writes a resumable JS orchestration script (`agent()`/`pipeline()` primitives), savable as a named reusable routine. That last one *is* Anthropic's 2026 answer to Raven's hand-rolled DAG, and it doubles as a no-code extension surface. Raven passes ~10 of ~70 `Options` fields.

8. **Survivors practice deliberate deletion; accretion kills.** AutoGPT/AgentGPT died of bespoke scaffolding around a moving model. LifeOS v7 ("The Bitter Pill") cut always-loaded context 88KB→28KB on one test: "would a smarter model make this rule unnecessary?" OpenClaw refuses config-compat aliases — breaking changes ship a `doctor --fix` migration instead. Raven's own schedule-engine migration proves the pattern works here; it was just applied once out of four needed times.

---

## 5. Target architecture

**The principle: Raven shrinks to a gateway plus a personal data model. The Claude Agent SDK owns the agent runtime.**

### Delegated to the SDK/runtime
- **Sessions & continuity**: persist the SDK session id per Raven session (`linkSdkSession` already exists), pass `resume` per turn. Delete `session-compaction.ts`, `session-references.ts`; demote `message-store.ts` to a read-model for the dashboard.
- **One backend**: the SDK drives the same `claude` binary under CLI/MAX auth. Delete `cli-backend.ts` and the API-key split.
- **Skills**: `library/skills` migrates to SDK-loaded SKILL.md format with declarative `requires` (env/bins) gating, loaded via `plugins`/`settingSources`. Delete the suite registry, suite scaffolder, `RavenSkill`.
- **MCP isolation**: per-subagent `AgentDefinition.mcpServers`; `disallowedTools: ['mcp__*']` on the parent; `skills: []` means *nothing*, not everything — the default agent lists its skills explicitly.
- **Permission enforcement**: `canUseTool`/PreToolUse hooks call the existing bash-gate and tier engine *before* execution; red-tier routes to the existing Telegram approval flow. Fix `allowDangerouslySkipPermissions` before an SDK bump does.
- **Multi-step orchestration** (eventually): the SDK Workflow tool — model-authored, resumable, savable routines — replaces the hand-rolled DAG.

### Stays custom (the gateway — genuinely Raven's)
- Channels: Telegram bot, web dashboard, WebSocket protocol.
- The unified ScheduleEngine (already works) + notification engine + approvals inbox (unified to one surface).
- The personal data model: filesystem project tree as the *only* project store (SQLite reduced to a cache keyed by path), the memory files, the intents table.
- Background services (IMAP watcher, TickTick sync, Telegram) folded into compiled, type-checked core — never launch-mode-dependent again.

### The unified concept model — six nouns, one each
| Concept | One home |
|---|---|
| Project (life domain) | `projects/<name>/` directory with `context.md` — every creation surface (web, Telegram) scaffolds a real directory |
| Agent | `projects/**/agents/*.yaml`, explicit skill list, git-committed |
| Skill (capability) | `library/skills/**/SKILL.md` + declarative requires |
| Schedule (WHEN) | `projects/schedules/*.yaml` |
| Routine (WHAT, multi-step) | `projects/templates/` now → saved Workflows later |
| Intent (prospective memory) | `intents` SQLite table: trigger keywords/cron, fire budget, cooldown, expiry — compiled at utterance time via two MCP tools |

### Extension without code
One path, finished end-to-end: **conversational scaffolding via the (wired) Raven MCP** — `create_skill` / `create_agent` / `create_template` / `create_schedule` / `create_intent` tools that write to disk, **hot-reload the affected registry**, and **git-commit via ConfigCommitter**. Owner says "Raven, learn to do X" in chat; a versioned artifact appears on disk, live, no restart, no TypeScript. Delete the other four half-paths.

### Memory
Four problems, four answers: (1) *curated* — the existing file memory store, fed by retrospectives writing gated candidates (interactive sessions only, provenance recorded) promoted by a scheduled consolidation job; (2) *live state* — always tool-fetched fresh (calendar/inbox/tasks), never remembered; (3) *corpus* — SQLite FTS5 over email/transcripts, local; (4) *prospective* — the intents table. Neo4j demoted from boot-critical to deleted-or-optional.

### Proactivity
Cron (exists, works) + a heartbeat schedule kind (main session, silence-by-default contract, activeHours, busy-deferral, cheap-model option) + deterministic intent matching on inbound events + structural anti-nagging caps. No inferred commitments.

```
                 ┌────────────────────────── RAVEN GATEWAY (custom) ─────────────────────────┐
  Telegram ──┐   │  channels ─▶ event bus ─▶ session router (one main session per owner)     │
  Web/WS  ───┼──▶│  ScheduleEngine (cron+heartbeat)   Intents table (deterministic match)    │
  (future) ──┘   │  Approvals inbox (ONE surface)     Notification engine (caps/quiet hours) │
                 │  Self-test job ─▶ invariants ─▶ Telegram alert                            │
                 └───────────────┬──────────────────────────────────────────────────────────┘
                                 │ resume=<sdk_session_id>, canUseTool ▶ bash-gate/tiers
                                 ▼
                 ┌────────────── CLAUDE AGENT SDK (delegated) ───────────────┐
                 │ session store + compaction   SKILL.md skills (library/)   │
                 │ subagents w/ scoped MCPs     Workflow tool (routines)     │
                 │ Raven MCP: memory, task lifecycle, scaffolding, intents   │
                 └───────────────┬───────────────────────────────────────────┘
                                 ▼
                 FILESYSTEM (source of truth, git-committed)        SQLITE (runtime state,
                 projects/ (life domains, agents, schedules,        cache, intents, FTS5
                 templates)  library/skills/  memory/               corpus index)
```

---

## 6. Testing & verification agenda

### Honestly, today
147 test files / ~1,768 cases, SDK properly mocked, temp DBs — and the estate is anti-correlated with risk. The one "E2E" test (`packages/core/src/__tests__/e2e.test.ts`) hand-assembles its own components, never touching the real 620-line boot in `index.ts` — the single most defect-dense artifact in the repo — and mocks the SDK backend while production runs the CLI backend. Every production-breaking defect (severed `ravenMcpDeps`, stale pipeline names, all-suites boot failure, inert scaffolds) is a *wiring* defect no existing test can see. `npm run check` is red on trunk (37 errors), `npm test` has 6 drifted failures, there is no CI, `suites/` (~10.7k LOC including the Telegram bot) is invisible to the compiler, `packages/web` has zero rendering tests, and the 16 `manual-tests/*.md` specs assert a `/task-trees` route deleted in commit 5fac6d4. The live system was stuck for four months and never said so.

### The E2E-first suite design
**Foundation:** extract `main()` into an exported composition root — `createRaven(config, overrides)` returning `{start, stop, eventBus, db, api}` — where overrides inject only true boundaries (agent backend, clock, Telegram transport, Neo4j-optional). This makes wiring bugs testable and survives every refactor in section 7.

**Named suites** (each <200 lines, asserting *terminal observable state* — DB rows, files, emitted events, HTTP responses — never mock-call payloads):

1. **`schedule-roundtrip`** — fake clock fires a schedule → template instantiated → tree created → agent step runs (mocked backend) → `onTaskCompleted` → tree `completed` → notification emitted. *Proves the automation loop, which has never once closed in production.*
2. **`chat-roundtrip`** — WS `chat:send` → `user:chat:message` → agent reply → transcript JSONL written + WS broadcast received; second turn asserts `resume` was passed. *Proves conversation and continuity.*
3. **`email-triage`** — `email:new` → triage task → notification queued.
4. **`scaffold-hot-reload`** — `POST /api/scaffold/agent` → agent resolvable and usable in the next chat turn *without restart*. **Fails today — good; it pins the requirement.**
5. **`approval-flow`** — red-tier action → pending approval → resolve → execution proceeds (and not before).
6. **`cli-backend-roundtrip`** — a fake `claude` binary (30-line node script emitting stream-json NDJSON) on PATH, so the *actual production backend* gets a real subprocess test.
7. **`boot-smoke`** — build, then `node packages/core/dist/index.js` with `RAVEN_PORT=0`; assert the health endpoint reports N services loaded. *Pins the strip-types regression that silently killed the whole service layer.*

**Delete:** tests for pipeline-engine, task-queue, TaskTreeView, unreachable suite-registry branches, `scripts/test-skill.ts` — in the same commits as the code they cover. Rewrite the 6 shape-coupled failing tests as outcome assertions. Collapse `manual-tests/` from 16 stale specs to ~5 current journey specs with dated run records; add 2–3 real Playwright specs (dashboard loads, chat round trip, task board) plus a trivial contract check that every URL `api-client.ts` constructs exists in the route registry (catches the dead SSE endpoint for free).

**CI:** one ~40-line GitHub Actions workflow — `npm run check` + `npm test` (Neo4j testcontainers split into an opt-in project so the default run needs no Docker) + `validate:library` + `validate:projects` + the boot smoke. First make trunk green; the fixes are mechanical.

**Continuous self-verification** — the system must detect its own stroke: a nightly `self-test` job (`projects/schedules/self-test.yaml`, using the working ScheduleEngine, zero model calls) checking deterministic invariants: no task tree "running" >24h; services loaded == services enabled; every schedule's last fire reached terminal status; `agent_tasks` 24h error rate below threshold; event-bus listener count sane. Violations → one batched Telegram alert; same checks exposed on `/api/health` so the dashboard shows red. Weekly: a live canary template run that must reach `completed`. **Fix the doc lies** that sabotage agents: SDK package name (`@anthropic-ai/claude-agent-sdk`), Neo4j requirement, dead "Adding a New Skill" sections.

---

## 7. Migration roadmap

Each phase leaves the system usable. ⚡ = quick win.

### Phase 0 — Stop the bleeding (days)
- ⚡ **Wire `ravenMcpDeps` in `index.ts`** (the Raven MCP plan's own "Step 6") *and* restore a small `agent:task:complete → onTaskCompleted` listener keyed by `executionTaskId`, so the runtime observes completion whether or not the model cooperates. ⚡ Fix the run-agent bridge to honor the template's `agent` field.
- ⚡ **Delete**: `pipeline-engine/` + `config/pipelines/` + `/pipelines` page, `config/task-templates/` loader, `task-queue.ts`, `TaskTreeView.tsx`, `scripts/test-skill.ts`, suite-scaffolder, the orchestrator's phantom-tool prompt blocks, `RavenSkill`/`config/skills.json`, repo-root snapshot dumps (`skills.yml`, `dash-nav.yml`, …) — with their tests.
- ⚡ Make trunk green (37 lint errors, 6 drifted tests) and stand up the CI workflow. Rewrite the "Adding a Skill" docs and the SDK package name.
- **Freeze**: no new stratum lands without a plan that deletes its predecessor.

### Phase 1 — Give the brain memory and one runtime (1–2 weeks)
- Verify the SDK backend under CLI auth, then **delete `cli-backend.ts`** and the backend split.
- Persist the SDK session id (`linkSdkSession`) and pass `resume` per turn — *the single highest-leverage change in the repo*. Then delete `session-compaction.ts` and `session-references.ts`; demote message-store to a dashboard mirror.
- ⚡ Invert `skills: []` to mean zero; explicit skill list in `raven/agent.yaml`; per-subagent `mcpServers`; `disallowedTools: ['mcp__*']` on the parent.
- Extract the composition root and land E2E suites 1, 2, and 7.

### Phase 2 — One capability system, real enforcement (2–3 weeks)
- Add `requires.env` to the skill schema; point permission-engine at library actions; move suite *services* into compiled core registered by manifest; then **delete SuiteRegistry, suite-loader, `suites/`, `config/suites.json`**.
- Replace `bypassPermissions` with a `canUseTool` seam calling bash-gate + tiers before execution; route red-tier to Telegram; fix `allowDangerouslySkipPermissions`.
- Unify approvals into one pending-decisions inbox (dashboard + Telegram); delete the orphaned `/config` page.
- Land E2E suites 3, 5, 6; add the boot health assertion (Telegram alert when a declared service fails to start).

### Phase 3 — One world model, closed learning loop (2–3 weeks)
- Filesystem ProjectRegistry becomes the only project store; SQLite `projects` reduced to a cache keyed by path; web and Telegram project creation scaffold real directories.
- Retrospectives write gated candidates (interactive sessions only, provenance) into `projects/agents/*/memory/`; a scheduled consolidation job promotes into `MEMORY.md`. Weekly system-retrospective job reads `agent_tasks` failure aggregates into the same memory. Make validation opt-out for owner-facing agent nodes.
- Drop Neo4j as a boot dependency; migrate curated knowledge to files + SQLite FTS5.
- Nightly self-test job + weekly canary.

### Phase 4 — The no-code extension path and proactivity (2–4 weeks)
- Scaffold-then-hot-reload as MCP tools: every scaffold write reloads the affected registry and git-commits. Per-session agent selection so `_agent-builder` is invocable. Extend scaffolding to library skills. E2E suite 4 turns green.
- `intents` table + `create_intent`/`cancel_intent` MCP tools (time-based → schedule rows; event-based → deterministic keyword rows with budget/cooldown/expiry). Heartbeat schedule kind with the silence contract.
- Evaluate the SDK Workflow tool as the template engine's successor: owner describes an outcome, Claude writes the routine, it's saved and re-runnable.

### Phase 5 — Live on it (ongoing)
- Create the first real life-domain projects; migrate skills to SKILL.md format; let the weekly retrospective and self-test drive further pruning. Success metric: things Raven remembered this week, automations that reached `completed`, and capabilities added from chat without touching an editor.

---

## 8. What NOT to do

- **Don't build a fourth workflow engine or "fix" the pipeline engine.** Two are being deleted; the survivor gets one wire. OpenClaw's hard ban on planner-tree frameworks is the field's verdict on where this road leads.
- **Don't expand Neo4j or add a vector database.** The people who invented agent memory reversed course to markdown files; the benchmark that justified graphs is discredited; your files + FTS5 cover a single user's corpus.
- **Don't build LLM-inferred commitments.** OpenClaw shipped it, measured it, and retired it. Compile intents into deterministic rows at utterance time instead.
- **Don't keep the CLI-spawn backend "as a fallback."** The SDK drives the same binary; text-only CLI backends are "a safety net, not a primary path," and keeping both means implementing resume, hooks, and permissions twice.
- **Don't let cron/heartbeat sessions write memory.** Production audits elsewhere found auto-captured memory is overwhelmingly scaffolding noise; gate candidates to interactive sessions with provenance.
- **Don't add proactivity before the anti-nagging structure.** Fire budgets, cooldowns, quiet hours, and the silence contract come first — alert fatigue is the documented dominant failure mode, and a muted assistant fails the mission as surely as a broken one.
- **Don't finish all five extension paths.** Finish one (conversational scaffolding via MCP) and delete four. Five painted-on doors are why "extend without code" doesn't exist today.
- **Don't write more implementation-shape tests or another parallel-universe E2E.** Six are already dead on trunk from healthy refactors while real wiring bugs went unseen. Outcomes only, through the composition root.
- **Don't distribute Raven with MAX/CLI auth.** Personal use is fine; Anthropic's terms bar offering claude.ai login/rate limits through third-party products — relevant if the "share it with friends" temptation ever arrives.
- **Don't start a v3 spec before v2's wires are closed.** Five generations in 3.5 months, each additive, none finished, is the root cause of everything above. The schedule engine proved the alternative: migrate, delete, then move on.