# Raven — Shared Development Guide

Raven is a personal assistant for one owner: reduce coordination work, remember
useful context, and act autonomously within enforced permission boundaries.
Keep the custom runtime small; use the existing agent SDK for model execution.

## Start here

- This is the canonical development guide for both Claude and Codex. `CLAUDE.md`
  loads it for Claude; `_bmad-output/project-context.md` points BMAD workflows here.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for current wiring. The
  [completion record](_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
  is the current task queue and verification record; the
  [deferred ledger](_bmad-output/implementation-artifacts/deferred-work.md)
  gives concrete remaining fixes and their acceptance plans.
- The [current assessment](docs/assessments/2026-09-05-reliability-completion.md)
  relates the completed reliability work to Raven's philosophy and storage limits.
- March BMAD artifacts and the August 6 assessment are historical requirements
  and snapshots, not a reliable inventory of unfinished code. Check the current
  implementation and subsequent commits before reviving old work.
- Codex development support does not change Raven's runtime provider: it still
  uses `@anthropic-ai/claude-agent-sdk` and the owner's Claude CLI authentication.
- Repository attachments, project-owned memory and graph replacement remain
  deferred. The [workspace proposal](docs/superpowers/specs/2026-09-05-project-workspaces-design.md)
  describes proposed behavior, not an available feature.

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
  Preserve human context and legacy IDs. Plain legacy
  definitions may still depend on SQLite settings/IDs until their controlled
  migration; the database cannot yet be discarded as a wholly rebuildable cache.
- SQLite owns operational state, including sessions, tasks, approvals and intents.
  Knowledge bodies are Markdown; durable links and project membership still live
  in Neo4j. Routine reindexing must preserve those relationships and graph metadata.
- Agent memory currently lives at `projects/agents/<name>/memory/`, globally by
  name. Project memory and attached repositories are **proposed**, not available
  simply by putting paths in a data-source row or `context.md`.
- Preserve knowledge links and project membership before changing graph storage.
  Permission checks must be enforced in tools/runtime, not only prompt text.
- Stop admission and own listeners, timers and in-flight local work across
  stop/restart. Use abort signals and post-await checks around side effects.
  Client cancellation does not prove remote work stopped, and already admitted
  MCP mutation draining remains a specific deferred task.
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
