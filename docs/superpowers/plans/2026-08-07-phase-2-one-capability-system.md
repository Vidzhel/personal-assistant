# Phase 2 — One Capability System, Real Enforcement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One capability concept (library skills), permissions enforced BEFORE tool execution via the SDK's `canUseTool`, background services compiled and type-checked inside core, `suites/` deleted, approvals visible and resolvable from the dashboard.

**Context:** Phase 0 (dead strata deleted, MCP wired, green trunk, CI) and Phase 1 (composition root `packages/core/src/raven.ts`, Neo4j-optional boot, SDK-only backend with per-session serialized `resume`, explicit skill lists) are complete through commit `1ef8328`+. Trunk is green and pushed.

**Architecture:** The permission engine starts reading the library's 41 declared actions (16 green / 21 yellow / 4 red). A `canUseTool` policy replaces `bypassPermissions` so Bash and red-tier actions are gated pre-execution. Suite services move to `packages/core/src/services/` as compiled `ServiceDefinition`s with declarative `requiresEnv` gating; then SuiteRegistry/suites/ die. The web stops lying: `/api/skills` serves library skills (fixing the AgentFormModal suite-name bug), the dead config-approval surface is deleted, and pending approvals get a dashboard inbox.

## Global Constraints

- `npm run check`, `npm test`, `npm run build` exit 0 after every task; commit per task; push at the end of Tasks 3b, 5, 6.
- Migration Freeze Rule: every migration task deletes its predecessor in the same commit.
- No new eslint-disable. One shell command at a time (no `&&`/`;`).
- Suites being deleted still serve production Telegram/IMAP/sync — services must be moved, not dropped; env-gating must match today's behavior (services with missing env skip with a log line, never crash boot).

## Verified facts (fact-finder, 2026-08-07)

- SDK: `canUseTool(toolName, input, {signal, toolUseID, agentID...}) => Promise<PermissionResult>` where PermissionResult = `{behavior:'allow', updatedInput?...}` | `{behavior:'deny', message, interrupt?}` (sdk.d.ts:122-148, 1167-1177). `permissionMode: 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'`; `allowDangerouslySkipPermissions` must be true when bypassing (sdk.d.ts:940-953). PreToolUse hooks also exist. NONE of this is used today — `sdk-backend.ts:48` sets `bypassPermissions` without the required flag (breaks on SDK bump).
- Permission engine (`permission-engine.ts`): `resolveTier` = config override (`config/permissions.json`, currently `{}`) → `actionMap` from `suiteRegistry.collectActions()` (i.e. `suites/*/actions.json`) → fallback `'red'`. `CapabilityLibrary.collectActions()` exists (capability-library.ts:134-153) with ZERO callers. `enforcePermissionGate` is only invoked pre-`query()` when `actionName` is set (agent-session.ts:224) — effectively only the `executeApprovedAction` path.
- Red-tier flow that WORKS: `pendingApprovals.insert` → `permission:blocked` event → telegram-bot inline keyboard (`a:y/n/v:{id}`) → callback-handler resolve → `agentManager.executeApprovedAction` (resolves capabilities via suiteRegistry — must move to library in Task 3b). Parallel REST path `POST /api/approvals/:id/resolve` works. NO web UI consumes `/api/approvals` at all.
- Services inventory (suite → services → requiresEnv → jobRegistry):
  - `_orchestrator` → maintenance-runner → none → job `system-maintenance`
  - `notifications` → telegram-bot, delivery-scheduler, engagement-tracker, snooze-suggester, media-router → TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  - `email` → imap-watcher, reply-composer, email-triage, action-extractor → GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN
  - `task-management` → autonomous-manager, ticktick-sync → TICKTICK_CLIENT_ID/SECRET/ACCESS_TOKEN → job `ticktick-task-sync`
  - `daily-briefing` → briefing-formatter → none
  - `gemini-transcription` → voice-transcriber → GOOGLE_API_KEY
  - `google-workspace` → email-watcher, drive-watcher → GWS_PRIMARY_CREDENTIALS_FILE
  - `financial-tracking` → transaction-sync → YNAB_ACCESS_TOKEN
  - `proactive-intelligence` → data-collector, insight-processor, cross-domain-detector → none → job `pattern-analysis`
  - `file-processing` → no services (vendor plugins only)
- LIVE BUG: `AgentFormModal.tsx` multi-select submits SUITE names into `agent.skills`; `resolveFromLibrary` can't match them → UI-configured agents silently resolve to empty capabilities. `/api/skills` (routes/suites.ts:15) returns suite manifests; consumers: api-client `getSkills`, Skills page, agent-store `fetchSuites`, AgentFormModal.
- DEAD end-to-end: `config-changes` REST route 501s unconditionally (`configChangeResolver` never wired in raven.ts), `resolveConfigChange` has zero callers, telegram `c:a:/c:d:` buttons always fail, web `/config` page can never succeed. `config/skills.json` + `loadSkillsConfig` (config.ts:105-110) have zero callers; Settings page instructs editing that dead file. `/config-history` (git-based) is a SEPARATE working feature — keep it.

---

### Task 1: Permission engine reads the library; tiers become real

**Files:** `packages/core/src/permission-engine/permission-engine.ts` (+deps type), `packages/core/src/raven.ts` (pass capabilityLibrary), tests.

- [ ] `refreshActionMap()` merges `suiteRegistry.collectActions()` (during migration) + `capabilityLibrary.collectActions()` — library wins on name conflicts (16 byte-identical dupes exist). Keep `config/permissions.json` overrides on top. Keep fallback `'red'`.
- [ ] Add `getActionCatalog(): Array<{name, tier, source}>` for the dashboard (Task 5 uses it).
- [ ] Tests: library-action tier resolution, override precedence, conflict rule. Commit: `feat(core): permission tiers resolve from the capability library`.

### Task 2: `canUseTool` policy — enforcement before execution

**Files:** Create `packages/core/src/permission-engine/tool-policy.ts` + test; modify `sdk-backend.ts`, `agent-backend.ts`, `agent-session.ts`, `agent-manager.ts` (thread deps), `bash-gate` stays as the analyzer but stops being "observational".

- [ ] `createToolPolicy(deps: {permissionEngine, pendingApprovals, auditLog, bashGate-fns, task metadata}) => CanUseTool`:
  - `Bash` → `checkBashAccess(parseCommand(input.command), task.bashAccess)`: allowed → allow (audit); denied → deny with the gate's reason. This makes bash PRE-execution enforced (today agent-session audits AFTER the SDK ran it — remove that observational block in the same commit, agent-session.ts ~352).
  - Raven MCP tools (`mcp__raven__*`, `mcp__memory__*`) → allow (already role-scoped).
  - Integration MCP tools (`mcp__<server>__<tool>`): map to action name via the library's action metadata when a mapping exists (actions are named like `gmail:send-email` — read how action names relate to MCP tool names in library configs; if no reliable mapping exists, tier by SERVER: resolveTier on `<server>:<tool>` with fallback to per-server default from the skill's actions; document the mapping rule in the module docstring). Green/yellow → allow + audit (yellow also emits `permission:approved` event as today's gate does); red → `pendingApprovals.insert` + emit `permission:blocked` + deny with message "Queued for approval (id …) — the owner has been asked on Telegram".
  - Everything else (Read/Glob/Grep/WebSearch/WebFetch/Agent/TodoWrite…) → allow.
- [ ] `sdk-backend.ts`: `permissionMode: 'default'`, drop `bypassPermissions`, pass `canUseTool: opts.canUseTool` (new optional BackendOptions field). agent-session builds the policy per task (it has task.bashAccess + permissionDeps already) and threads it.
- [ ] Keep `enforcePermissionGate` for the `executeApprovedAction` explicit-action path (it pre-approves a known action) — but have the canUseTool policy allow when `task.approvedActionName === toolAction` (thread the approved action name onto the task so the re-run isn't re-blocked). VERIFY how executeApprovedAction marks the task and close that loop.
- [ ] Unit-test the policy directly (each branch). Integration: fake backend can't exercise canUseTool (SDK-internal); assert agent-session passes the callback and that policy denials audit correctly.
- [ ] Commit: `feat(core): pre-execution tool policy via SDK canUseTool — bash gate and tiers enforce, not observe`.

### Task 3a: Services move into core (compiled, env-gated)

**Files:** Create `packages/core/src/services/` (one file per service, moved from `suites/*/services/*.ts` with imports fixed), `packages/core/src/services/registry.ts` (`ServiceDefinition {name, description, requiresEnv: string[], start(ctx), stop()}` + `SERVICE_DEFINITIONS` list), modify `raven.ts` (replace serviceRunner.startServices(suites) with the new registry runner; keep the same `baseContext`), health route counts from the new registry.

- [ ] Move ALL services listed in Verified facts (they currently import from suites/ paths and `@raven/shared` — fix imports; they become part of the `tsc` build and ESLint globs: expect and fix type/lint errors surfaced by first-time compilation, WITHOUT behavior change; where a guardrail rule forces refactors keep them mechanical).
- [ ] `requiresEnv` gating in the runner: all listed vars present → start; else log skip (same message shape ServiceRunner uses today). jobRegistry handlers: the 4 registrant services register via ctx exactly as today.
- [ ] Move each suite's `__tests__` alongside (packages/core/src/__tests__/services/ or existing pattern); they enter the default vitest project.
- [ ] suites/ stays in place this commit (loader still runs, but `raven.ts` no longer starts suite services — ONLY the new registry starts them; verify no double-start).
- [ ] Commit: `feat(core): background services compiled into core with declarative env gating`.

### Task 3b: Delete the suite machinery

**Files:** Delete `suites/` (entire tree), `packages/core/src/suite-registry/` (registry, loader, service-runner, suite-scaffolder), `config/suites.json`, `config/skills.json` + `loadSkillsConfig` + `SuitesConfig`/`loadSuitesConfig` (config.ts), `scripts/test-suite.ts` + package.json entries. Modify every consumer: `raven.ts`, `permission-engine.ts` (drop suiteRegistry source), `agent-resolver.ts` (delete legacy suiteIds branch + `suiteIds` from NamedAgent), `agent-manager.ts` `executeApprovedAction` (resolve via capabilityLibrary + namedAgentStore instead), `mcp-manager/` (check: it wraps suiteRegistry — likely deletable whole), `api/routes/suites.ts` (rewrite: `/api/skills` serves library skills — new shape `{name, description, domain, mcps, actions:[{name,tier}], model?}`; keep `/api/suites` returning 410 or drop it), api/server.ts deps, health route `skills` field, `yaml-named-agent-store.ts` (drop suiteIds hardcode), events.ts ConfigResourceType 'suite' member and related zod enums (becomes 'agent'|'schedule'), tests throughout.

- [ ] Grep-driven: `grep -rln "suiteRegistry\|SuiteRegistry\|suites.json\|suiteIds\|skills.json"` packages/ scripts/ and clean every hit. Delete tests of deleted code; port tests that covered moved behavior.
- [ ] `npm run check && npm test && npm run build` green (separately, no chaining); commit `feat(core)!: delete suites stratum — library is the only capability system`; push.

### Task 4: Web truth — skills UI, dead config surface

**Files:** `packages/web/src/lib/api-client.ts` (Skill type → library shape), `app/skills/page.tsx` (render library skills: name, description, domain, action tiers), `stores/agent-store.ts`, `components/agents/AgentFormModal.tsx` (multi-select now lists library skill names — FIXES the silent-empty-capabilities bug), `app/settings/page.tsx` (drop the config/skills.json instruction; describe library/ + projects/ as the extension surfaces). DELETE: `app/config/page.tsx` (+nav entry), `api/routes/config-changes.ts` + registration + `ConfigChangeResolver` type, `suites`-era `config-approval-handler`/`config-applier`/`config-presenter`/`config-manager` files (they died with suites/ in 3b — verify gone), `pending_config_changes` writes (leave the table; migrations append-only), telegram callback-handler `c:*` branch (goes with suites in 3b — verify).

- [ ] Keep `/config-history` (working git-based feature).
- [ ] Component/unit tests per repo pattern (pure logic, no jsdom). Commit: `feat(web): skills UI serves the capability library; dead config-approval surface removed`.

### Task 5: Approvals inbox on the dashboard

**Files:** Create `packages/web/src/components/approvals/ApprovalsInbox.tsx` (+ helpers), wire into `app/page.tsx` (dashboard section) and/or a compact bell in the layout; api-client `getPendingApprovals`/`resolveApproval` (routes exist: GET /api/approvals/pending, POST /api/approvals/:id/resolve — verify exact paths in routes/approvals.ts).

- [ ] List pending approvals (action, skill, age, details), Approve/Deny buttons (in-house Button, hover affordances, confirm on approve of red actions), optimistic update + refetch, badge count on the dashboard summary card row (replace or extend the existing "Pending Approvals" card which today links to /settings — point it at the inbox instead).
- [ ] Also surface `getActionCatalog` (Task 1) on the Settings page: read-only table of action → tier → source, so the owner can SEE the permission surface (edits still via config/permissions.json — document inline).
- [ ] Pure-logic tests. Commit: `feat(web): approvals inbox — see and resolve pending actions from the dashboard`; push.

### Task 6: E2E — approval flow and email triage

**Files:** `packages/core/src/__tests__/e2e-approval-flow.test.ts`, `packages/core/src/__tests__/e2e-email-triage.test.ts` (follow e2e-chat-roundtrip.test.ts harness pattern).

- [ ] approval-flow: createRaven + fake backend; dispatch a task carrying a red-tier actionName (the executeApprovedAction/enforcePermissionGate path) → pending approval row + `permission:blocked` emitted → REST resolve approve → executeApprovedAction re-dispatch observed at the fake backend → audit rows correct. (canUseTool inner path stays unit-tested; this E2E covers the queue/resolve/re-run loop.)
- [ ] email-triage: emit `email:new` on the bus (as imap-watcher would) → triage service reacts → agent task dispatched → notification event emitted. Uses the moved (core) services with fake env.
- [ ] Both suites assert clean stop(). Commit: `test(core): approval-flow + email-triage E2E round-trips`; push.

## Self-review notes
- Task 2's MCP-tool→action mapping is the least-specified part: the implementer must read 2-3 library skill configs and the actual MCP tool names to derive the rule, and document it. If tool names don't map cleanly, tier-by-server with skill-level defaults is acceptable for Phase 2 (red overrides still enforced via explicit action names on the approved path).
- Task 3a/3b are deliberately separate commits: move-and-verify, then delete-and-rewire.
- proactive-intelligence's cross-domain-detector needs Neo4j — it must respect the degraded mode (skip when knowledge deps absent) — verify during the move.
- After 3b, `_orchestrator`'s maintenance-runner is a core service; its convention-auditor references suites conventions — trim to what still exists.
