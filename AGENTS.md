# Raven — Shared Development Guide

Raven is a personal assistant for one owner: reduce coordination work, remember
useful context, and act autonomously within enforced permission boundaries.
Keep the custom runtime small; use the existing agent SDK for model execution.

## Start here

- This is the canonical development guide for both Claude and Codex. `CLAUDE.md`
  loads it for Claude; `_bmad-output/project-context.md` points BMAD workflows here.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for current wiring. The
  [file-based continuation queue](_bmad-output/implementation-artifacts/file-first-completion-2026-09-05.md)
  is the active work plan; the earlier
  [completion record](_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
  records R0–R7 verification. The
  [deferred ledger](_bmad-output/implementation-artifacts/deferred-work.md)
  gives concrete remaining fixes and their acceptance plans.
- The [current assessment](docs/assessments/2026-09-05-reliability-completion.md)
  relates the completed reliability work to Raven's philosophy and storage limits.
- March BMAD artifacts and the August 6 assessment are historical requirements
  and snapshots, not a reliable inventory of unfinished code. Check the current
  implementation and subsequent commits before reviving old work.
- Codex development support does not change Raven's runtime provider: it still
  uses `@anthropic-ai/claude-agent-sdk` and the owner's Claude CLI authentication.
- Repository workspaces are authorized after F1–F9 in the active queue. Read the
  owner's flexible-layout, direct-repository execution and mobile artifact
  requirements there before designing them. The
  [W1 specification](_bmad-output/implementation-artifacts/tech-spec-w1-project-workspaces.md)
  is the current implementation plan; the earlier workspace proposal is superseded.
- Updated owner decision: Raven has not been used; legacy runtime data may be
  discarded. Do not build legacy exports, migrations or restoration flows.
  Task state is moving to validated YAML inside each project. Use cheaper
  implementation agents when delegated work is appropriate; the parent reviews.
- The sole `migrations/001-initial-schema.sql` initializes current operational
  SQLite atomically. Retired task/tree/run/pipeline/definition tables and old
  default seeds are removed. Unsupported historical migration histories fail
  explicitly; never silently apply part of a SQL script or reset an existing DB.

## Repository and conventions

This is an npm workspaces monorepo: `packages/shared` (types, built first),
`packages/core` (Fastify, orchestration, agents, services), `packages/web`
(Next.js), and `packages/mcp-ticktick` (in-repo MCP server).
Use Node.js 22.22.0 or newer and npm 10.9.8. Package manifests and the lockfile specify dependency
versions; do not copy versions from historical planning documents.

- TypeScript strict mode and ESM; use `node:` for builtins. Core/shared use
  `.ts` relative imports. Web value imports use its `@/` alias without `.ts`
  extensions, matching Next's TypeScript configuration.
- Zod validates inputs/configuration; Pino via `createLogger()` handles logging.
- Prefer functions and composition; preserve established stateful subsystem
  classes. Use `crypto.randomUUID()` for new IDs.
- Use kebab-case filenames, focused modules, and explicit error handling.
- Follow the installed ESLint/Prettier configuration. Do not add guardrail
  disables to make a change pass; existing justified exceptions are historical.
- Keep credentials, live databases, session transcripts, and unrelated local
  project data out of changes and tool output.

## Architectural rules

- `library/skills/**/config.json` + `skill.md` and `library/mcps/*.json` are the
  capability definitions. Named agents live under `projects/**/agents/`, normally
  as `<name>/agent.yaml`; legacy flat YAML is also supported.
- `skills: []` means **no capability bindings**. The default agent enumerates
  its skills explicitly. Preserve per-agent MCP scope and role-filtered Raven
  MCP tools. Missing skill, MCP or vendor definition references fail dispatch
  before turn mutations; they must never grant the full library as a fallback.
- Default-chat and execution-tree dispatch resolve named-agent model tiers and
  turn limits before admission. Queue those settings with the task; budget and
  backend options must use the same effective model. YAML/API turn limits are
  integers from 1 through 100; null API patches reset to YAML defaults. Invalid
  internal dispatch settings emit a correlated blocked result without model work.
  Approved actions derive project ownership from their stored session, validate
  capability bindings and use global model/turn defaults. A saved approval can
  still have a failed execution; expose that failure in HTTP, UI and audit logs.
- Raven MCP tools are filtered by role and available dependencies. Nested SDK
  agents receive scoped capabilities and the same permission boundaries.
  Knowledge tools and instructions must reflect actual graph availability.
- Suites, the old pipeline engine, and the CLI backend were deleted. Background
  services now compile under `packages/core/src/services/`. Do not recreate them.
- `createRaven()` in `packages/core/src/raven.ts` is the composition root;
  `index.ts` is the entry point. Chat resumes SDK sessions; execution-bridge owns
  task completion independently of model tool calls.
- Extend behavior through the existing scaffold-and-activate path: write
  definitions, reload the registry, and commit the specific definition files.
  Intents use the existing SQLite store with budgets, cooldowns and expiry;
  creating an intent does not create a definition file. Background services
  belong in the existing compiled service registry.
- Migration freeze: a new subsystem, engine, or replacement definition directory
  must remove the predecessor it replaces in the same change. Complete existing
  paths before adding another abstraction.
- Managed project identity/settings live in `context.md` metadata; update/delete
  use the existing lifecycle and cache synchronization. System projects and
  projects with known SQLite references cannot be deleted. Graph memberships
  prevent deletion when Neo4j is available; an otherwise empty project can archive
  without that check when unavailable, reporting `knowledgeReferencesChecked: false`.
  Preserve human context. Plain definitions use their relative path as identity;
  managed definitions use their explicit metadata ID. Missing settings take file
  defaults. Referenced missing definitions remain inactive historical rows and
  cannot be recreated from cache settings.
- Current definition errors belong in registry diagnostics and health/self-test.
  Skip malformed definitions while keeping valid siblings; retain cache evidence
  for unavailable project subtrees and pending mutation paths. A failed root scan
  must not become an empty successful index. Reload the capability library before
  checking project references. Project create/update/archive records current YAML
  intentions under `.project-mutations`; recover only verified hashes and safe
  paths before cache sync, preserving conflicts. Do not add compensation that
  overwrites canonical files after an uncertain cache operation. Actual SIGKILL
  tests exercise interruption; they do not establish cross-store power-loss
  atomicity or restore pre-use legacy data.
- Board tasks live in validated YAML at `projects/<fsPath>/tasks/board/<id>.yaml`.
  Resolve project IDs through current definitions; projectless tasks use `system`.
  Execution trees and their nodes commit together at `tasks/trees/<id>.yaml`.
  Interrupted trees require deliberate resume through the board detail panel/API.
  AgentManager run history lives at `tasks/runs/<agentTaskId>.yaml`; admission and
  terminal writes precede model dispatch and completion events. Restart marks
  unfinalized runs failed/interrupted with an unknown prior execution outcome;
  history never replays model work. SQLite still owns sessions, approvals,
  intents and model-budget leases. All Raven Claude queries, including direct
  heartbeat/learning calls that bypass Manager history, share budget admission.
  Reserve before dispatch, settle before returning, and retain missing usage or
  interrupted reservations as unknown. The configured local day is fixed at
  admission. `GET /api/budget` exposes known/reserved/unknown estimates; zero
  budget blocks queries. SDK query estimates include nested agents but are not
  subscription billing or a strict spending cap, and exclude Gemini/external
  commands. Keep evaluator admission headroom while its parent awaits validation.
  Knowledge bodies are Markdown; durable links and project membership still live
  in Neo4j. Routine reindexing must preserve those relationships and graph metadata.
  Reconciliation is read-only; explicit reindex and system maintenance retry stale
  source/embedding/chunk revisions. Keep old derived data until replacement commits.
  Pending knowledge deletion YAML blocks reindex resurrection and requires explicit
  delete retry or conflict resolution; never infer permission to prune graph-only
  records from missing Markdown. File/graph writes are not one atomic transaction.
- Knowledge merge/consolidation must use the shared `KnowledgeStore.mergeOwned`
  path and canonical source revisions. Never redispatch an invalid, failed or
  overlapping consolidation plan into direct graph deletion. Merges create a new
  identity and preserve originals until known graph success; pending merge records
  block ordinary update/delete/reindex. Explicit merge recovery verifies source
  and target state and file hashes before completing or rolling back preparation.
  Digests are actual project-linked Markdown. Ingestion, clustering and hub HTTP
  routes await completed operations; do not invent untracked task IDs or report
  an agent completion as proof that subsequent storage work completed.
- Workspace execution settings and labeled data sources live in each project's
  optional `project.yaml`; missing manifests on existing source projects take
  defaults, malformed manifests make the project unavailable. Source CRUD resolves
  current file identity, serializes mutations with the lifecycle and uses bounded,
  flushed atomic replacement. Folder input resolves against the configured Raven
  root and stores a canonical absolute path. There is no SQL source table/import.
  Configuration alone does not provide direct execution; W1 tracks that wiring.
- Named agents resolve through the current project's ancestor chain. Global IDs
  remain names; local IDs are `<projectId>::<name>`. Local definitions override
  ancestor names; unrelated projects never provide implicit fallbacks. Re-read
  bounded current YAML and project identity before lookup. New definitions require
  registry reload. Agent CRUD preserves extra files and commits both rename paths.
- Memory belongs to projects at `<managed-home>/memory/`, shared by their agents.
  `project.yaml` owns its budget (defaults: 30 files, 64 KiB). Notes may use nested
  Markdown paths; ordinary tools cannot touch candidates/internal paths or follow
  symlinks. Serial writes enforce budgets and compare prior bytes. Learning uses
  explicit snapshots across model calls and retains rejected/changed candidates.
  The browser's memory access selects a project explicitly. Internal validators
  have no memory tools. Direct repository execution remains a later W1 checkpoint.
- Preserve knowledge links and project membership before changing graph storage.
  Permission checks must be enforced in tools/runtime, not only prompt text.
- Stop admission and own listeners, timers and in-flight local work across
  stop/restart. Use abort signals and post-await checks around side effects.
  Keep the release callback returned by `JobRegistry.register()` and invoke it
  on service stop so restart can register the same job in the same registry.
  Start services only after their dependencies and event listeners exist, and
  register service jobs before starting cron. Capture dependencies from service
  context; never revive the removed task-store/AgentManager global lookups.
  Each model task closes local MCP admission on abort/completion and drains
  admitted Raven/memory handlers before returning. Keep stores alive during that
  drain. Cancellation does not roll back committed mutations or prove remote work
  stopped.
- Schedule health uses current effective definitions and activation IDs in the
  existing fire log. Preserve activation on unchanged reloads; replace it when
  definitions change or become enabled. Track manual and cron invocations before
  starting handlers. Cancel job-owning services/knowledge processors before waiting
  for schedule drain, while keeping shared graph/SQLite stores open. Self-test
  grants startup/completion grace and distinguishes current in-flight work from
  missing, stale, failed or unregistered schedules; old activations cannot satisfy
  current health. Croner defines calendar behavior, including its tested DST edges.
- File transcription records a Gemini upload attempt before dispatch in
  operational SQLite. The Raven-owned cleanup coordinator captures exact returned
  IDs, keeps active files out of cleanup, retries known pending deletions at startup
  and maintenance, and records unknown outcomes without guessing IDs. Local cleanup
  has its own bounded signal. Stop closes coordinator admission and local waits
  before SQLite disposal; late callbacks cannot write. The read-only
  `/api/provider-uploads` report and deterministic maintenance section expose
  unresolved attempts. Client cancellation does not prove remote inference stopped.
- Learning uses interactive retrospectives, candidate files and consolidation.
  Rejected, failed or partial consolidation must retain pending candidates; archive
  only after successful application and index generation. Heartbeat is disabled
  by default and its silence sentinel must not reach the owner.

## Build, validation, and debugging

```bash
npm install
npm run build
npm run dev:core
npm run dev:web
npm run check
npm test
npm run validate:library
npm run validate:projects
```

`npm run build` builds shared/core, the TickTick workspace and the production
dashboard. The dev commands start the actual assistant; choose configuration
deliberately rather than using them as test isolation.

`npm run check` is required after each task. Run relevant behavioral tests for
code changes; the default test suite must pass before claiming a green baseline.
Neo4j integration tests are opt-in with `npm run test:knowledge` and need Docker.
Keep test credentials fake and test files/databases in temporary directories;
preserve the environment, Neo4j and composition guards under
`packages/core/src/__tests__/setup/`. Composed tests must supply explicit isolated
project/library/config/data roots and a fake backend. The real SDK contract test
uses a fake executable; it does not authenticate with an owner account.

Use `npm run test:e2e` for the isolated Playwright journeys, `npm run test:compiled`
after `npm run build:core` for packaged-core restart verification, and
`npm run test:deployment` for real Git initializer tests. See
[docs/deployment.md](docs/deployment.md) for offline container checks and setup.
Live TickTick tests require `npm run test:mcp:live` plus deliberate credentials;
they are separate from default verification. Local socket failures in a restricted
runner are environment limitations, not passing tests. Do not claim account
delivery or remote cancellation from a fake backend or emitted notification.

Inspect `data/logs/raven*.log`, `/api/logs`, and `/api/health` when diagnosing
services. Do not start the live assistant merely to validate documentation.
R5's recorded checkpoint passed 1971 tests (6 explicit skips), 11 browser journeys,
the required check, production builds and compiled restart verification. This is
dated evidence in the completion record, not a substitute for checking a new change.

## Development skills and changes

Codex skills live in `.agents/skills/`; the existing BMAD skills are already
installed there. Browser workflows are in `.agents/skills/browser-testing/` and
`.agents/skills/playwright-cli/`; the optional browser specialist is
`.codex/agents/browser-tester.toml`. Preserve Claude's existing `.claude/` skills,
agents and local settings. Raven runtime skills in `library/` are a separate
concept and are not development-agent MCP configuration.

Preserve the user's uncommitted work. Keep changes reviewable and scope any git
staging to the files changed for the task. Commit/push when requested by the user
or the established session workflow. A read-only review or delegated no-Git task
does not authorize publication. Keep task-specific restrictions and the user's
current instructions ahead of historical workflow text.
