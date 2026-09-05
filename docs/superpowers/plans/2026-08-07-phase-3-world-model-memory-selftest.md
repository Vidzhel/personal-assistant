# Phase 3 — One World Model, Closed Memory Loop, Self-Verification

> **Historical plan — reconciled September 5, 2026.** The original instructions
> and checkboxes below are retained as history, not the current execution queue.
> See the [canonical reliability completion record](../../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
> for verified outcomes and remaining work. Reconciliation does not mean every
> implementation detail proposed here was adopted; do not recreate retired systems.
>
> The implemented weekly canary uses a dedicated canary template, not the
> morning-digest template proposed below. Verification establishes isolated
> scheduling, execution and delivery behavior only; live owner-account delivery
> has not been established by this reliability pass. Graph storage remains in use.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One project store (filesystem), a memory loop that actually writes (file-first, owner-reviewable, provenance-gated), and a system that detects its own failures (nightly self-test + weekly canary) instead of staying silently broken for months.

**Context:** Phases 0–2 complete through `fcc4162`: dead strata deleted, MCP + completion bridge wired, SDK-only backend with per-session resume, Neo4j-optional boot, suites deleted (services compiled in core), canUseTool pre-execution enforcement, approvals inbox. Trunk green, pushed.

**Owner requirements this phase serves:** "memory must be simple but must be retrospectable" (file-first, the owner can read/edit every memory file; retrospectives feed it), "sustain itself" (self-test + canary), "visibly see what happens" (health + Telegram alerts).

## Global Constraints

- check/test/build exit 0 after every task; commit per task; push at phase end.
- Freeze rule: migrations delete predecessors in the same commit.
- TEST SAFETY (incident 2026-08-07): tests must NEVER run against live credentials. Task 0 makes this structural; until it lands, every test touching services must blank credential env vars.
- Memory files: markdown with YAML frontmatter, human-editable, git-committed via the existing ConfigCommitter pattern. No vector DB, no graph store. Neo4j-backed knowledge engine stays boot-optional and untouched this phase except where retrospectives decouple from it (full retirement is a later decision, recorded in `docs/assessments/2026-08-06-architecture-assessment.md`).

## Verified facts / carried context

- `agent-memory/memory-store.ts`: per-agent file memory under `projects/agents/<name>/memory/` with YAML budget, `MEMORY.md` index injected into system prompt when `task.namedAgentId` set. READ side works; nothing writes (every `MEMORY.md` says "(no memories yet)").
- `session-manager/session-retrospective.ts`: runs on `session:idle` (idle-detector), currently writes knowledge bubbles via knowledgeStore+neo4j (only constructed when both exist — degraded mode = no retrospectives at all today).
- Projects: SQLite `projects` table (rows created by `orchestrator.ensureProject` — Telegram topic ids become phantom rows) + filesystem `ProjectRegistry` (`projects/` dir), joined by case-insensitive name match in `routes/projects.ts` enrichWithRegistry and `orchestrator.ts` (~295-308). `scaffolding/scaffolding-api.ts` can create project dirs (`POST /api/scaffold/*` routes exist; scaffolds are inert until restart — hot-reload is Phase 4; creating dirs is NOT inert for the DB-join problem since enrich happens per-request).
- Scheduler: `projects/schedules/*.yaml` + `scheduler/schedule-engine.ts` (job kinds: job/template) + `scheduler/core-jobs.ts` registry — this all works (the one healthy subsystem).
- `agent_tasks` table records every run w/ status+duration+errors. `execution_tasks`/`task_trees` similar. Nobody reads failures.
- Telegram alert path: emit `notification` event `{channel:'telegram', title, body, topicName?}` — telegram-bot service delivers (works when env present).

---

### Task 0: Structural test-env safety

**Files:** root `vitest.config.ts` or per-project configs (setupFiles), create `packages/core/src/__tests__/setup/test-env-guard.ts`, `packages/core/src/config.ts`.

- [ ] `config.ts` runs `dotenv.config()` at import time — gate it: skip when `process.env.VITEST` or `NODE_ENV === 'test'` (verify vitest sets VITEST=true — it does by default). Tests that need specific env set it explicitly.
- [ ] Belt-and-suspenders: a vitest `setupFiles` entry that deletes every credential-shaped var (TELEGRAM_*, TICKTICK_*, GMAIL_*, GWS_*, YNAB_*, GOOGLE_API_KEY, ANTHROPIC_API_KEY, NEO4J_PASSWORD, MONOBANK_*, PRIVATBANK_*) before any test module loads. Check vitest 4 `test.projects` setupFiles semantics (per-project vs root).
- [ ] Verify the e2e-email-triage test still passes with its explicit fake env; remove its now-redundant manual blanking if the global guard covers it.
- [ ] Commit: `test: structural guard — tests can never see real credentials`.

### Task 1: One project store — filesystem wins

**Files:** `packages/core/src/orchestrator/orchestrator.ts` (ensureProject), `packages/core/src/api/routes/projects.ts`, `packages/core/src/project-registry/*`, `packages/core/src/scaffolding/*`, web project-creation surfaces (`packages/web/src` project modal / api-client createProject), telegram-bot topic→project mapping, migrations (new: mark `projects` table as cache — add `fs_path` column), tests.

- [ ] Read first: routes/projects.ts (list/create/enrich), orchestrator ensureProject, meta-project.ts, ProjectRegistry node shape, scaffoldingApi.createDomain/createProject capabilities, how telegram maps topics to projects.
- [ ] New invariant: a project EXISTS iff a directory exists under `projects/` (registry node). The DB row is a cache row keyed by `fs_path` for runtime state (sessions FK etc.). Implement: `project-manager/project-sync.ts` — on boot and on scaffold, upsert DB rows from registry nodes (name, fs_path); `ensureProject` (telegram/chat path) now: resolve registry node by name → if missing, scaffold a real minimal project dir (reuse scaffoldingApi; kebab-case the name; for telegram topics use the topic NAME not the numeric id — read what's available in the event payload; fall back to a `projects/inbox/` catch-all project for unnameable sources) → upsert cache row. No more phantom rows.
- [ ] Web/API create-project routes call scaffoldingApi then sync (registry reload for the new node — registry has load(); check for a cheaper single-node add; full reload is acceptable at this scale).
- [ ] One-time migration of existing DB rows: for rows with no matching registry node, scaffold dirs for rows that have sessions/tasks referencing them; drop the rest. Write as migration 0xx + a boot-time reconciler in project-sync (idempotent).
- [ ] Meta-project: keep (it's the system project) but give it a registry node (projects/system exists — check linkage).
- [ ] Tests: project-sync unit; E2E: POST /api/projects → dir exists + registry node + cache row + chat to it works. Update enrichWithRegistry consumers (it may simplify away).
- [ ] Commit: `feat(core)!: filesystem is the only project store — DB reduced to cache; every creation surface scaffolds a real directory`.

### Task 2: Memory write path — retrospectives produce reviewable candidates

**Files:** Create `packages/core/src/agent-memory/memory-candidates.ts` + `memory-consolidation.ts`; modify `session-manager/session-retrospective.ts` (decouple from Neo4j: knowledge write stays IF available, memory candidates ALWAYS), `agent-memory/memory-store.ts` (add write/list APIs as needed), `scheduler/core-jobs.ts` (+`memory-consolidation` job), `projects/schedules/memory-consolidation.yaml` (daily, quiet hours), prompt-builder (unchanged — MEMORY.md injection already works), raven.ts wiring, tests.

- [ ] Candidate shape: markdown file in `projects/agents/<agent>/memory/candidates/<date>-<slug>.md` with frontmatter `{source: 'session-retrospective'|'system-retrospective', sessionId?, provenance: 'interactive'|'system', createdAt, status: 'pending'}`. ONLY interactive sessions produce candidates (retrospective already runs per session — gate on the session having user messages; cron/heartbeat/internal tasks never write). Extraction: the retrospective agent task's prompt gains a section asking for 0-3 durable memory candidates (owner preferences, corrections, standing facts) as a fenced JSON block; parse defensively; drop on parse failure (log).
- [ ] Consolidation job (scheduled daily): for each agent with pending candidates: dispatch ONE small agent task (haiku-tier model if configured) that reads current MEMORY.md + memory files + candidates and returns file operations (create/update/delete memory files within budget) as JSON; apply via memory-store (enforce budget), mark candidates consumed (move to `candidates/archive/`), regenerate MEMORY.md index, git-commit via ConfigCommitter. Deterministic guards: max N ops, path-traversal guard exists in memory-store, never touch files outside the agent's memory dir.
- [ ] Weekly `system-retrospective` job: aggregate `agent_tasks` failures/error-rates + stuck trees over 7d into ONE system candidate for the default agent ("what kept failing"), same pipeline.
- [ ] Owner visibility: memory files are git-committed; add `GET /api/agents/:id/memory` (list files + content) and a simple read-only Memory tab/section on the agent page (web) — keep minimal (list + view).
- [ ] Tests: candidate parse/gating unit tests; consolidation applies ops within budget (fake agent backend returning scripted ops); E2E: interactive chat session → idle → retrospective → candidate file exists → consolidation job run → MEMORY.md updated + candidate archived.
- [ ] Commit: `feat(core): memory loop closed — interactive retrospectives write candidates; scheduled consolidation promotes them into agent memory`.

### Task 3: Self-test job + weekly canary

**Files:** Create `packages/core/src/services/system/self-test.ts` (pure functions + job handler), `projects/schedules/self-test.yaml` (nightly), `projects/schedules/weekly-canary.yaml` (weekly, fires the morning-digest template), extend `scheduler/core-jobs.ts`, health route, tests.

- [ ] Deterministic invariants (zero model calls): (1) no task tree in `running` >24h; (2) services loaded == services whose requiresEnv is satisfied; (3) every schedule's last fire reached a terminal status (check schedule_runs or equivalent — read what the engine records; add a lightweight `schedule_fires` log if none exists); (4) agent_tasks error rate over 24h below threshold (default 50%, config override); (5) pending approvals older than 48h (nag); (6) disk: data/ writable, DB integrity_check quick.
- [ ] Violations → ONE batched `notification` event (telegram) + stored in a `self_test_results` row + surfaced on `/api/health` (`selfTest: {lastRun, ok, violations[]}`) and the dashboard System Health card (red state + tooltip/section).
- [ ] Weekly canary: fire the morning-digest template via templateScheduler; a follow-up check (same job, delayed or next self-test run) asserts the tree reached `completed` — else violation alert.
- [ ] Tests: each invariant pure-function tested (seed a stuck tree in temp DB → violation; healthy state → ok); E2E: seeded stuck tree → self-test job run → notification event emitted + health shows violation.
- [ ] Commit: `feat(core): nightly self-test invariants + weekly canary — the system reports its own failures`.

### Task 4: Small-debt sweep (parked items)

**Files:** orchestrator.ts (write-only `capabilityLibrary` field — remove or use for the skill catalog line in prompts if trivially useful; decide by reading), config.ts (`RAVEN_SESSION_COMPACTION_THRESHOLD` dead — delete + fix mock configs), message-store (`archiveTranscript`/`replaceTranscript` dead exports — delete + their mocks), `packages/web/src/app/processes/page.tsx` (orphan page duplicating Agent Monitor — delete), `eslint.config.ts` dead glob `packages/skills/*/src/**` (remove).

- [ ] Verify each with grep before deleting. Commit: `chore: sweep parked dead code from phase reviews`. Push everything.

## Self-review notes
- Task 1's telegram topic→project naming needs the actual event payload inspected — if only a numeric topic id is available at ensureProject time, the inbox-project fallback is the correct behavior and the topic can be renamed/claimed later (Phase 4 territory).
- Task 2 keeps the knowledge-bubble write when Neo4j is up (additive), so nothing regresses in knowledge-enabled mode; candidates work in BOTH modes.
- Task 3 invariant (2): the services registry knows requiresEnv; loaded set comes from the runner — both exist post-Phase 2.
- Deliberately NOT here: intents table, heartbeat, scaffold-hot-reload MCP tools (Phase 4); Neo4j full retirement (separate decision).
