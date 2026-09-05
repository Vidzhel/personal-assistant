# Phase 1 — Memory and One Runtime Implementation Plan

> **Historical plan — reconciled September 5, 2026.** The original instructions
> and checkboxes below are retained as history, not the current execution queue.
> See the [canonical reliability completion record](../../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
> for verified outcomes and remaining work. Reconciliation does not mean every
> implementation detail proposed here was adopted; do not recreate retired systems.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat turn remembers the conversation (SDK session `resume`), one agent backend (SDK) drives the `claude` binary under CLI/MAX auth, the process boots and serves without Neo4j, and a composition root makes all of it E2E-testable.

**Architecture:** Extract `createRaven()` from `main()` so wiring bugs are testable. Make Neo4j/knowledge optional at boot (degrade, don't die). Add `resume` to the backend seam, persist `sdk_session_id` per Raven session, delete the CLI backend and the hand-rolled compaction/references machinery that existed to compensate for cold prompts. Default agent gets an explicit skills list; `skills: []` stops meaning "everything".

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` ^0.2.71 (verified: `Options.resume`, `Options.env`, `Options.pathToClaudeCodeExecutable` all exist in sdk.d.ts), Vitest 4, better-sqlite3.

## Global Constraints

- `npm run check` and `npm test` must exit 0 at the end of every task.
- No new subsystems (Migration Freeze Rule in CLAUDE.md).
- Commit per task; push after the final task.
- One command at a time in shell work — never chain with `&&` or `;`.
- The owner runs MAX-plan CLI auth: `ANTHROPIC_API_KEY` is empty in production. The SDK spawns its bundled CLI and inherits `~/.claude` auth. Any env passed to `query()` must strip `CLAUDECODE` (the nesting guard) — the deleted cli-backend did this via `CLAUDECODE: undefined`; carry that trick over.

## Verified facts

- `BackendOptions`/`BackendResult` seam in `packages/core/src/agent-manager/agent-backend.ts`; `BackendResult.sessionId` already carries the SDK session id parsed from the `system/init` message (`sdk-backend.ts` ~line 50).
- `sdk-backend.ts` builds `queryOptions` (systemPrompt, allowedTools, permissionMode bypassPermissions, model, maxTurns, stderr, cwd, mcpServers+strictMcpConfig, agents, plugins) — no `resume`, no `env` today.
- `SessionManager` (`packages/core/src/session-manager/session-manager.ts`): `getOrCreateSession(projectId)` reads active row; `linkSdkSession(sessionId, sdkSessionId)` exists with ZERO callers; `sessions.sdk_session_id` column exists. There is no getter that returns `sdk_session_id` — the SELECT reads `*` but `rowToSession` may drop it (verify).
- Chat path: orchestrator resolves `session` via `sessionManager.getOrCreateSession`, puts `sessionId` on the `agent:task:request` payload; `agent-session.ts` `runAgentTask` has `task.sessionId`.
- Boot dies without Neo4j: `index.ts` awaits `neo4jClient.ensureSchema()` → `syncProjectNodes()` → `knowledgeStore.reindexAll()` unconditionally; `main().catch` → `process.exit(1)` before Fastify binds (proven on this machine, no Docker in this WSL distro).
- All knowledge fields on `RavenMcpDeps` are optional with "not available" tool guards; `ApiDeps` knowledge fields are optional and route registration is already conditional (`if (deps.knowledgeStore && deps.ingestionProcessor)`).
- `agent-resolver.ts`: `hasNoBindings` (empty `skills` + empty `suiteIds`) resolves the ENTIRE library for the default agent; agent YAMLs on disk (`projects/agents/{raven,gmail,ticktick,digest,...}/agent.yaml`) — raven has `skills: []` + `isDefault: true`.
- `session-compaction.ts` and `session-references.ts` summarize/link history for prompts that never include history; orchestrator computes `sessionReferencesContext`, `projectDataSourcesContext`, `skillCatalogContext` that no consumer reads (verify each before deleting).
- SDK `Options.env` "Defaults to process.env"; `pathToClaudeCodeExecutable` lets tests point at a fake executable.

---

### Task 1: Composition root — `createRaven()`

**Files:**
- Create: `packages/core/src/raven.ts`
- Modify: `packages/core/src/index.ts` (shrinks to: load config → `createRaven(config)` → `start()` → signal handlers)
- Test: `packages/core/src/__tests__/boot-smoke.test.ts`

**Interfaces:**
- Produces: `createRaven(config: RavenConfig, overrides?: RavenOverrides): Promise<RavenInstance>` where `RavenInstance = { start(): Promise<void>; stop(): Promise<void>; eventBus: EventBus; db: DatabaseInterface; port: number }` and `RavenOverrides = { agentBackend?: AgentBackend; dbPath?: string; projectRoot?: string; skipSuites?: boolean; clock?: ... }` — keep overrides MINIMAL: only `agentBackend`, `dbPath`, `dataDir`, `skipSuites` for now. True boundaries only.

- [ ] **Step 1:** Move the body of `main()` into `packages/core/src/raven.ts` `createRaven(config, overrides)`. Mechanical move — do NOT refactor logic in the same commit beyond: (a) paths derive from `overrides.dataDir ?? projectRoot`; (b) the agent backend comes from `overrides.agentBackend ?? initializeBackend(config.ANTHROPIC_API_KEY)` (make `initializeBackend` return the backend and accept an injected one — check `agent-session.ts` `activeBackend` module state and route the override through it, e.g. `setActiveBackend(backend)`); (c) `createApiServer(..., config.RAVEN_PORT)` port 0 must work for tests (Fastify supports port 0 — return the bound port on the instance); (d) `stop()` = current shutdown body without `process.exit`.
- [ ] **Step 2:** `index.ts` becomes ~25 lines: config, `createRaven`, `start()`, SIGINT/SIGTERM → `stop()` then exit, `main().catch` fatal handler. Keep the `unhandledRejection` guard.
- [ ] **Step 3:** Write `boot-smoke.test.ts`: `createRaven(testConfig, { dbPath: tmp, agentBackend: fakeBackend, skipSuites: false })` → `start()` → inject `GET /api/health` via the Fastify instance (expose `app` on RavenInstance for tests or use fetch against the bound port) → expect 200 and a body reporting suites/services counts → `stop()` terminates cleanly (no open handles; vitest will hang otherwise — that IS the assertion). NOTE: this test runs WITHOUT Neo4j and depends on Task 2 landing first if boot still dies — so implement Task 2's guard FIRST if the test can't pass, or write the test to tolerate it and tighten in Task 2. Preferred order in practice: Task 1 Steps 1-2, then Task 2, then this test. Keep them as separate commits anyway.
- [ ] **Step 4:** `npm run check` exit 0, `npm test` exit 0, commit `refactor(core): extract createRaven composition root; index.ts is now a thin main`.

### Task 2: Boot resilience — Neo4j optional, degrade don't die

**Files:**
- Modify: `packages/core/src/raven.ts` (the Neo4j/knowledge block), `packages/core/src/api/routes/health.ts`
- Test: extend `boot-smoke.test.ts`

- [ ] **Step 1:** Wrap the entire Neo4j/knowledge-engine init (neo4jClient → knowledgeStore → ingestion → embeddings → clustering → chunking → retrieval → contextInjector → lifecycle → retrospective → knowledgeConsolidation) in try/catch. On failure: log ONE warn (`Knowledge engine unavailable (Neo4j unreachable) — continuing without it`), leave all knowledge deps `undefined`. Everything downstream already tolerates undefined (ApiDeps optional, RavenMcpDeps optional, registerKnowledgeRoutes conditional) — VERIFY the remaining hard references: `sessionRetrospective` (takes knowledgeStore + neo4j — check whether it guards), `registerCoreJobs({ retrospective, knowledgeConsolidation })` (make those params optional or register no-op jobs that log-and-skip), `syncProjectNodes`, `chunkingEngine.backfillChunks`, and `shutdown`'s `neo4jClient.close()`. Each gets an undefined-guard, not a stub.
- [ ] **Step 2:** Health route: add `knowledge: 'ok' | 'unavailable'` and `services: { loaded: n, configured: m }` to the payload (configuredSuiteCount dep already exists; loaded count from serviceRunner or suiteRegistry — check what's available on the deps and thread the count through createRaven).
- [ ] **Step 3:** boot-smoke asserts: boots with no Neo4j, health 200, `knowledge: 'unavailable'`, services counts present. Commit `feat(core): boot survives Neo4j being unreachable; health reports knowledge + service status`.

### Task 3: SDK-only backend with session resume

**Files:**
- Modify: `packages/core/src/agent-manager/agent-backend.ts` (+`resume?: string` on BackendOptions), `packages/core/src/agent-manager/sdk-backend.ts`, `packages/core/src/agent-manager/agent-session.ts`, `packages/core/src/agent-manager/agent-manager.ts`, `packages/core/src/session-manager/session-manager.ts` (+`getSdkSessionId(sessionId): string | undefined`)
- Delete: `packages/core/src/agent-manager/cli-backend.ts` + its tests
- Test: `packages/core/src/__tests__/sdk-backend-contract.test.ts` (fake executable), extend `agent-manager.test.ts`

- [ ] **Step 1:** `sdk-backend.ts`: add to queryOptions — `resume: opts.resume` (only when set), and `env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined }` cast appropriately (the SDK types env as Record<string,string>; build with a delete instead of undefined values: `const env = { ...process.env } as Record<string,string>; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;`). Accept optional `pathToClaudeCodeExecutable` via a module-level test hook or an added BackendOptions field `executablePathOverride?: string` (test-only, documented).
- [ ] **Step 2:** `agent-session.ts` `runAgentTask`: before invoking the backend, if `task.sessionId` → `const resume = sessionManager.getSdkSessionId(task.sessionId)` (thread sessionManager in via RunOptions — check what agent-manager already passes; it has sessionManager as a dep). Pass `resume` in BackendOptions. After a successful run with `result.sessionId`: `sessionManager.linkSdkSession(task.sessionId, result.sessionId)` — ALWAYS update (the SDK may mint a new id per resume — verify against observed behavior: if resume continues the same id, updating is a no-op; if it forks, we track the latest).
- [ ] **Step 3:** `session-manager.ts`: add `getSdkSessionId(sessionId: string): string | undefined` (direct SELECT of sdk_session_id). New session via `createSession` (the "new chat" path) naturally has NULL → first turn runs cold, gets linked.
- [ ] **Step 4:** IMPORTANT INTERACTION — the system prompt and the resumed history now both carry instructions. `prompt-builder.ts` output is passed as `systemPrompt` every turn; with `resume`, prior turns' `[System: ...]` prompt-layer blocks (orchestrator prepends them to the USER prompt) will appear in history AND be prepended again fresh. Trim the orchestrator's per-turn prepends to what must be per-turn (topic context, media attachment); move the stable blocks (MCP instructions, tool-use instructions, system-access) into the systemPrompt via prompt-builder instead of user-prompt prepends. Verify by reading orchestrator.ts's prompt assembly and prompt-builder.ts — this consolidation must land in the SAME commit as resume, or every resumed turn re-teaches the same rules in the user message.
- [ ] **Step 5:** Delete `cli-backend.ts`; `initializeBackend` always creates the SDK backend (keep the function + `setActiveBackend` test seam). Grep for `createCliBackend`/`CLI mode` references (config docs, CLAUDE.md Environment section stays accurate: SDK uses CLI auth — reword if it names the CLI backend).
- [ ] **Step 6:** Contract test with a fake executable: a ~30-line node script (test fixture) that speaks the stream-json protocol — emits `{"type":"system","subtype":"init","session_id":"fake-123"}`, an assistant text message, `{"type":"result","subtype":"success","result":"ok"}` — and appends its argv to a file. Test: run the sdk backend with `executablePathOverride` → assert result parsed, session id captured; run again with `resume: 'fake-123'` → assert the argv file shows `--resume fake-123`. If the SDK's arg passing proves different (inspect what argv actually arrives), assert on whatever the real mechanism is — the point is: resume requested → resume reaches the subprocess. If `pathToClaudeCodeExecutable` can't be made to work with a plain script (the SDK may exec `node cli.js`), mock at the module boundary instead (vi.mock the SDK query fn asserting options.resume) and drop the fake-binary approach — report which path was taken.
- [ ] **Step 7:** Extend agent-manager tests: chat task with sessionId → backend received resume from getSdkSessionId; linkSdkSession called with the result's session id. Green trunk, commit `feat(core): SDK-only backend with session resume — every chat turn now remembers the conversation`.

### Task 4: Delete the cold-prompt compensation machinery

**Files:**
- Delete: `packages/core/src/session-manager/session-compaction.ts`, `packages/core/src/session-manager/session-references.ts`, their tests
- Modify: `packages/core/src/raven.ts` (unwire), `packages/core/src/orchestrator/orchestrator.ts` (drop compaction dep + the three unused context strings — VERIFY zero consumers first: grep `sessionReferencesContext|projectDataSourcesContext|skillCatalogContext` across packages/), `packages/shared/src/types/events.ts` (drop those payload fields if nothing reads them)

- [ ] **Step 1:** Verify each deletion target's consumers (grep). `session-retrospective.ts` is NOT in scope — it writes knowledge, keep it. The idle-detector stays (feeds retrospective).
- [ ] **Step 2:** Delete, unwire, fix tests. `message-store` remains as the dashboard/API mirror — no prompt-side consumers left.
- [ ] **Step 3:** Green trunk, commit `feat(core)!: delete session compaction + references — resume carries history now`.

### Task 5: Explicit capability scoping — `skills: []` means nothing

**Files:**
- Modify: `packages/core/src/agent-registry/agent-resolver.ts` (empty skills + empty suiteIds → resolve to `{mcpServers:{}, agentDefinitions:{}, plugins:[]}`; DELETE the default-agent-gets-everything branch), `projects/agents/raven/agent.yaml` (explicit `skills:` list — enumerate every library skill name currently relied on in chat: read `library/skills/**/config.json` for names; include at minimum the ticktick, gmail, calendar, digest, transcription-if-env'd set — list what exists, exclude skills whose env credentials are missing if the config marks them), also give `_agent-builder` and `system-admin` YAMLs explicit (possibly empty) lists deliberately
- Test: update `agent-resolver` tests; add one asserting empty-skills → empty capabilities

- [ ] **Step 1:** Read `agent-resolver.ts` fully; implement the inversion; keep the explicit-skills filter branch (it finally becomes reachable).
- [ ] **Step 2:** Update `projects/agents/*/agent.yaml` files. The raven default agent's list is a DATA decision: include all currently-working library skills (the library loads 15; transcription/financial ones missing credentials still resolve — listing them keeps behavior identical to today; do list them all EXCEPT any the validator flags). Behavior change target: zero for the default agent today, but the mechanism is now explicit and per-agent scoping is real for gmail/ticktick/digest agents (they already have 1-skill lists from Phase 0).
- [ ] **Step 3:** Green trunk, commit `feat(core): skills lists are explicit — empty means none, default agent enumerates its capabilities`.

### Task 6: E2E — chat-roundtrip and schedule-roundtrip

**Files:**
- Create: `packages/core/src/__tests__/e2e-chat-roundtrip.test.ts`, `packages/core/src/__tests__/e2e-schedule-roundtrip.test.ts`
- Modify: `packages/core/src/__tests__/e2e.test.ts` — DELETE it (hand-assembled parallel universe) once the new suites cover its assertions; verify what it covers first and port anything real.

- [ ] **Step 1:** chat-roundtrip over `createRaven` + fake backend: WS `chat:send` (or POST /api/chat) → reply event received; second turn → fake backend asserts `resume === 'fake-session-1'` (the id the fake returned on turn 1). Terminal state assertions only.
- [ ] **Step 2:** schedule-roundtrip over `createRaven` + fake backend + the real ScheduleEngine with a near-term cron or direct `fireTemplate` invocation (check scheduleEngine's API for a test-friendly trigger — `triggerTemplate` exists on templateScheduler): template instantiated → tree created → agent step runs (fake backend returns success) → tree `completed` → `notification` event emitted. This closes the loop the whole campaign was about.
- [ ] **Step 3:** Green trunk, commit, push everything: `test(core): E2E chat + schedule round-trips over the real composition root`.

## Self-review notes
- Task 3 Step 4 (prompt-layer consolidation) is the riskiest step — it changes what the model sees. Keep the text identical, only relocate it.
- Task 1/2 ordering: boot-smoke lands after resilience; steps say so.
- cli-backend deletion: CLAUDE.md Environment note "SDK uses claude CLI auth, NOT ANTHROPIC_API_KEY" stays true; config.ANTHROPIC_API_KEY becomes optional-but-honored (SDK uses it if set via env passthrough — do not delete the config field).
- Deliberately NOT in Phase 1: suites deletion, canUseTool permission enforcement, approvals unification, memory write path, intents (Phases 2-4).
