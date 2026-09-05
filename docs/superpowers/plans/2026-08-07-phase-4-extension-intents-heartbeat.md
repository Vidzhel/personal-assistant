# Phase 4 — No-Code Extension, Intents, Heartbeat

> **Historical plan — reconciled September 5, 2026.** The original instructions
> and checkboxes below are retained as history, not the current execution queue.
> See the [canonical reliability completion record](../../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
> for verified outcomes and remaining work. Reconciliation does not mean every
> implementation detail proposed here was adopted; do not recreate retired systems.
>
> Heartbeat intentionally runs in a fresh session, rather than resuming an
> interactive conversation as proposed below. Its silence contract and capability
> boundaries are tested in isolation; live outbound delivery is not claimed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner extends Raven from chat, never from an editor: "learn to do X" produces a live, git-committed artifact without a restart. "Remind me when Y" becomes a deterministic intent row with budget/cooldown/expiry — never LLM inference. A heartbeat keeps ambient awareness with silence as the default.

**Context:** Phases 0–3 complete through `fd860d0` (green, pushed). The Raven MCP is live with scoped tools; `create_agent`/`update_agent`/`list_agents`/`list_projects` already exist in `mcp-server/tools/system.ts`; scaffolding REST API exists (`scaffolding/scaffolding-api.ts`); registries load once at boot; schedule engine + fire log + self-test all work; memory loop closed.

**Owner requirements:** "adapt, improve, extend easily WITHOUT me going into code", "cost effective" (deterministic matching, no idle model burn), "see what happens and stop if necessary" (intents visible + cancellable).

## Global Constraints

- check/test/build/validate:projects exit 0 per task; commit per task; push at phase end.
- Freeze rule holds. No new eslint-disable. One shell command at a time.
- Anti-nagging is structural (per the assessment's "What NOT to do"): fire budgets (default 3), cooldowns (default 24h), expiry (default 90d), quiet hours respected via the existing notification path. NO LLM-inferred commitments.
- Heartbeat: silence contract — the model must reply `HEARTBEAT_OK` when nothing needs the owner's attention, and that reply is swallowed, never delivered.

## Verified facts / carried context

- Raven MCP tool scoping: `mcp-server/scope.ts` roles (chat/task/system/validation/knowledge); chat scope already includes `create_agent` etc. via system tools.
- Registries with boot-time load: `CapabilityLibrary.load(libraryDir)`, `ProjectRegistry.load(projectsDir)`, `TemplateRegistry.load(projectsDir)`, `createYamlNamedAgentStore` (reads via registry), `createScheduleEngine({schedules: projectRegistry.getGlobal().schedules, ...})` — schedule engine takes a SNAPSHOT at construction; reload requires stop/start or an addSchedule API (verify engine surface; extend minimally).
- `ConfigCommitter` auto-commits agent YAML changes via `agent:config:*` events; memory-consolidation commits via `gitAutoCommit` directly — reuse that helper for scaffold commits.
- `POST /api/scaffold/*` routes exist but artifacts are inert until restart (the original "five painted doors" finding); Phase 4 makes ONE door real and the REST scaffold routes reuse the same hot-reload path.
- Notification path: emit `notification` event `{channel:'telegram', title, body, topicName?}`.
- `schedule_fires` table exists (032). Migrations append-only; next is 033.
- Orchestrator routes every chat to the default agent; per-session agent selection does NOT exist (deliberately unchanged this phase — the default agent gets the extension tools).

---

### Task 1: Hot-reload — scaffolds go live without restart

**Files:** Modify `packages/core/src/scaffolding/scaffolding-api.ts` (+deps), `scheduler/schedule-engine.ts` (add `reload(schedules)` or `addSchedule/removeSchedule` — smallest correct surface), `template-engine/template-registry.ts` (+`reload()` if absent), `capability-library/capability-library.ts` (+`reload()`), `mcp-server/tools/system.ts` (extend with `create_template`, `create_schedule`, `create_skill`; wire scaffolding+reload deps via RavenMcpDeps), `mcp-server/types.ts`, `raven.ts`, scaffolding REST routes (share the same code path), tests.

- [ ] Read the scaffolding API + each registry's load/reload surface first. Design one function per artifact kind: `scaffoldAndActivate(kind, spec)` = validate spec (zod) → write file(s) → reload the affected registry (project/template/schedule/library) → `gitAutoCommit` with a descriptive message → return {path, live: true}. Schedule engine: after registry reload, re-sync its schedule set (stop/start of individual croner jobs; verify engine internals for the cheapest correct resync).
- [ ] MCP tools (chat + system scope): `create_template` (YAML spec: name, plan, tasks with agent/prompt/dependencies — mirror existing template shape), `create_schedule` (name, cron, kind job|template, target, enabled), `create_skill` (library skill: domain, name, description, skill.md body, optional mcps refs — validate mcp refs exist; actions optional with defaultTier capped at yellow via tool — red requires editing the file, deliberate friction), plus `reload_registries` (manual escape hatch). `create_agent` already exists — extend it to accept `skills` list + write through the same activate path (verify it already hot-updates via namedAgentStore).
- [ ] The existing `POST /api/scaffold/*` routes call the same scaffoldAndActivate functions (delete any duplicated write-only logic).
- [ ] Orchestrator prompt (prompt-builder MCP Tools section): add one line telling the agent these creation tools exist and when to use them ("when the owner asks you to learn a new behavior/schedule/skill").
- [ ] Tests: unit per artifact kind (write→registry reflects it→git log shows commit, temp dirs); E2E: chat-driven fake backend calls create_schedule via canUseTool-passing raven MCP? (the fake backend can't call MCP tools — instead E2E: POST /api/scaffold/schedule → schedule fires without restart via a near-term cron in temp env; MCP tool handlers get direct unit tests with real deps on temp dirs).
- [ ] Commit: `feat(core): scaffold-and-activate — new skills, templates, schedules, and agents go live without restart, git-committed`.

### Task 2: Intents — deterministic prospective memory

**Files:** Create `migrations/033-intents.sql` (`intents`: id, kind ('event'|'time'), pattern (keywords, JSON array), event_types (JSON, e.g. ["email:new"]), message, fire_budget INT default 3, fires_used INT default 0, cooldown_hours INT default 24, last_fired_at, expires_at, status ('active'|'exhausted'|'expired'|'cancelled'), created_at, source_session), `packages/core/src/intents/intent-store.ts` + `intent-matcher.ts` (service), MCP tools `create_intent`/`list_intents`/`cancel_intent` (chat scope) in a new `mcp-server/tools/intents.ts`, `services/registry.ts` entry (matcher service, requiresEnv []), web: intents visible on the dashboard or schedules page with cancel buttons (smallest surface: a section on the Schedules page), API routes GET /api/intents + POST /api/intents/:id/cancel, tests.

- [ ] `create_intent` (chat scope): kind time → also creates a one-shot schedule via Task 1's scaffoldAndActivate (cron for the target time + self-cancel after fire) OR stores next_fire_at handled by the matcher's minute sweep — pick ONE (prefer the matcher sweep: no schedule-file churn for one-shots; document). kind event → keyword pattern + event types. Tool descriptions teach the model to compile the OWNER'S explicit ask ("remind me when X arrives") — never speculative intents.
- [ ] Matcher service: subscribes to the declared event types (start with `email:new`, `notification`-adjacent events, `financial:transaction:recorded` — enumerate what exists in events.ts and pick the sensible inbound set); on event: case-insensitive ALL-keywords match against the event's text payload (define per event type what field is matched; document); on match + budget/cooldown/expiry pass → emit notification (title "Reminder", body = intent.message + trigger context) + update fires_used/last_fired_at; exhausted/expired → status flip. Minute sweep for time intents + expiry sweeps.
- [ ] Anti-nagging: budget/cooldown/expiry enforced in the store (single UPDATE with guards), tested.
- [ ] Tests: store guards; matcher match/no-match/budget/cooldown/expiry; E2E: create intent via API → emit matching event → notification emitted once; second event within cooldown → nothing.
- [ ] Commit: `feat(core): intents — deterministic prospective memory with fire budgets, cooldowns, expiry`.

### Task 3: Heartbeat schedule kind

**Files:** `scheduler/schedule-engine.ts` (+kind 'heartbeat'), heartbeat handler in `scheduler/` or `services/system/heartbeat.ts`, `projects/schedules/heartbeat.yaml` (disabled by default — the OWNER enables it), prompt content, config (RAVEN_HEARTBEAT_ACTIVE_HOURS default 08-22 local via RAVEN_TIMEZONE), tests.

- [ ] Heartbeat fire: skip if outside activeHours, skip if any agent task ran in the last interval (busy-deferral — query agent_tasks), skip if a previous heartbeat is still running. Otherwise dispatch ONE chat-session agent turn (resume the default agent's current session — reuse the orchestrator's chat path with a synthetic prompt) whose prompt: "Ambient check-in. Review your memory, pending approvals, task board, and recent events for anything the owner must know NOW. If nothing: reply exactly HEARTBEAT_OK." Response === HEARTBEAT_OK (trim) → swallow (log only). Anything else → notification to telegram.
- [ ] The heartbeat turn goes through the session-serialization (F1) path naturally since it uses the session — verify it can't wedge user chat (busy-deferral covers it; also cap heartbeat maxTurns low, e.g. 8).
- [ ] Tests: activeHours/busy-deferral/skip logic pure functions; handler with fake backend returning HEARTBEAT_OK → no notification; returning text → notification. E2E optional (job trigger route pattern).
- [ ] Commit: `feat(core): heartbeat schedule kind — ambient awareness with a silence contract, off by default`.

### Task 4: Phase wrap

- [ ] Update CLAUDE.md "Extending Raven": the chat path is now primary ("ask Raven to learn it"), files second. One paragraph, truthful.
- [ ] Update ARCHITECTURE.md briefly (intents + heartbeat + hot-reload).
- [ ] Run the FULL verification battery + validate scripts; push everything.
- [ ] Commit: `docs: Phase 4 — extension from chat, intents, heartbeat`.

## Self-review notes
- Schedule engine resync (Task 1) is the trickiest bit — read the engine before choosing addSchedule vs full reload; the fire-log dep (032) must survive reload.
- create_skill capping tool-created actions at yellow is deliberate: red powers require the owner to touch the file — friction as a feature.
- Heartbeat is DISABLED by default; enabling is the owner's explicit act (cost + noise are theirs to opt into).
- Intents deliberately have no UI creation form — chat is the interface; web only lists + cancels.
