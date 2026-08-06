# Raven - Development Guide

## Project Structure

npm workspaces monorepo. All packages use TypeScript ESM (`"type": "module"`).

```
packages/shared/       → @raven/shared        (types, utils - built first)
packages/core/         → @raven/core          (orchestrator, agents, API, scheduler)
packages/web/          → @raven/web           (Next.js dashboard)
packages/mcp-ticktick/ → @raven/mcp-ticktick  (in-repo TickTick MCP server)
```

Definitions that live outside the npm workspaces, loaded from disk at runtime:

```
library/    → capability library: skills + MCP definitions (see "Extending Raven")
projects/   → named agents, task templates, schedules (YAML)
suites/     → deprecated background-service suites (see "Extending Raven")
config/     → JSON config (permissions, suite enablement, schedules, ...)
```

## Build & Run

```bash
npm install                  # install all workspaces
npm run build                # build shared + core
npm run dev:core             # dev mode with --watch
npm run dev:web              # Next.js dev server
docker-compose up --build    # full stack
```

## Coding Conventions

- TypeScript strict mode, ESM only (`import`/`export`, `.ts` extensions in imports)
- `rewriteRelativeImportExtensions` in tsconfig rewrites `.ts` → `.js` in compiled output
- Use `node:` prefix for Node.js builtins (`import { readFile } from 'node:fs/promises'`)
- Zod for all config/input validation
- Pino for logging (structured JSON)
- Prefer functions and composition over class hierarchies; core subsystems that hold state (`Orchestrator`, `EventBus`, `AgentManager`, `CapabilityLibrary`, `TaskExecutionEngine`, `SuiteRegistry`, ...) are implemented as classes — that's the established pattern, not an exception
- All async functions must handle errors - never swallow exceptions silently
- Use `crypto.randomUUID()` for ID generation

## Per-Agent Capability Scoping (Critical Rule)

**No agent session carries every capability — each gets only what its named agent and its role resolve to.**

- Named agents are defined in `projects/**/agents/*.yaml` (e.g. `projects/agents/gmail/agent.yaml`) with a `skills:` list of capability-library skill names. An agent with an empty `skills:` list and no legacy `suiteIds` (this includes the default agent, `isDefault: true`) resolves to every skill in the library.
- `createAgentResolver` (`packages/core/src/agent-registry/agent-resolver.ts`) turns that `skills:` list into concrete `mcpServers` + sub-agent definitions via `CapabilityLibrary`; agents still on the legacy path fall back to `SuiteRegistry`.
- Every agent session additionally gets the in-process **Raven MCP** (`packages/core/src/mcp-server/`) — task-lifecycle, session, knowledge, validation, escalation, and system tools — filtered per `ScopeContext.role` (`task` / `chat` / `system` / `validation` / `knowledge`) by `isToolAllowed()` in `mcp-server/scope.ts`. A task-scoped session can't call `create_task_tree`; a chat-scoped session can't call `complete_task`.
- Sub-agent definitions dispatched via the SDK's `Agent` tool can declare their own `mcpServers` subset (`SubAgentDefinition.mcpServers` in `packages/shared/src/types/events.ts`) — they don't inherit the full parent set by default.
- Carried over from v1: don't dump every capability into one context. The mechanism changed (per-agent skill lists + role-scoped Raven MCP, not "orchestrator has zero MCPs, only sub-agents do") — the spirit didn't.
- See `ARCHITECTURE.md` for the full wiring diagram.

## Key Interfaces

- `SkillConfig` / `LoadedSkill` (`packages/shared/src/types/library.ts`) - a capability library skill's `config.json` shape
- `NamedAgent` (`packages/shared/src/types/agents.ts`) - agent definition resolved from `projects/**/agents/*.yaml`
- `RavenEvent` (`packages/shared/src/types/events.ts`) - All events on the bus
- `AgentTask` (`packages/shared/src/types/agents.ts`) - Agent task lifecycle

## Extending Raven

Two ways to add capability today:

**1. Capability library skills (primary path).** Add `library/skills/<domain>/<sub>/<name>/config.json` + `skill.md`:
- `config.json` — `name`, `description`, `mcps` (references into `library/mcps/*.json`), `vendorSkills`, `tools`, `model`, `maxTurns`, `actions` (each with a permission `defaultTier`)
- `skill.md` — the prompt/instructions text for the skill
- Loaded at boot by `CapabilityLibrary.load()` (`packages/core/src/capability-library/`) from the `library/` directory
- Bind it to an agent by adding the skill name to that agent's `skills:` list in `projects/**/agents/*.yaml`
- Validate with `npm run validate:library`

**2. Suites — background services (DEPRECATED, do not add new ones).** `suites/<name>/suite.ts` + `services/` — long-running background services (IMAP watchers, proactive intelligence, financial tracking, etc.), enabled via `config/suites.json`. Suites are scheduled for removal in Phase 2 — see `docs/assessments/2026-08-06-architecture-assessment.md`. Do not create a new suite; add a capability library skill instead.

## File Naming

- `kebab-case.ts` for all files
- Types in `packages/shared/src/types/`
- One concern per file - keep files focused and under 300 lines

## Git Workflow

- Claude manages this project: track changes, commit, and push to repository
- Always commit meaningful changes with descriptive messages
- Push to remote to persist work across sessions

## Debugging

Structured logs are written to `data/logs/raven` (NDJSON, daily rotation, 7-day retention).
- Read logs: `cat data/logs/raven.1.log | python3 -c "import sys,json; [print(json.loads(l).get('msg','')) for l in sys.stdin if l.strip()]"`
- Filter by component: grep for `"component":"telegram-bot"` (or any subsystem name)
- API: `GET /api/logs?level=error&component=service-runner&lines=100`
- Frontend: `/logs` page with level/component/search filtering
- Always check logs first when a service silently fails to start

## Testing

Run core standalone to verify infrastructure boots:
```bash
RAVEN_PORT=4001 node packages/core/dist/index.js
curl http://localhost:4001/api/health
```

- `npm test` runs the full Vitest suite (`vitest run`) and must exit 0.
- Knowledge-engine tests (`knowledge-api`, `knowledge-chunking`, `knowledge-clustering`, `knowledge-embeddings`, `knowledge-retrieval`, `knowledge-store`) need a real Neo4j and are opt-in — they're excluded from the default run and only discovered when `RAVEN_TEST_KNOWLEDGE=1` is set. Run them with `npm run test:knowledge`.

## Linting & Formatting

- ESLint 9 (flat config) with `typescript-eslint` strict rules + Prettier
- `npm run check` must pass after every task (runs `format:check` + `lint` + `check:strip-types`)
- `npm run lint` — ESLint + TypeScript type-check
- `npm run format` — Prettier write mode
- `no-restricted-syntax` rule bans `.js` import extensions (use `.ts` only)
- `no-console` enforced — use `createLogger()` from `@raven/shared`
- AI guardrail rules (all `error`): `max-lines-per-function` (50), `complexity` (10), `max-params` (3), `no-magic-numbers`, `explicit-function-return-type`, `consistent-type-imports` — existing disables must carry a `-- ` justification; do not add new ones
- Test files (`__tests__/**`) have relaxed rules: `any`, `non-null-assertion`, `console`, guardrails off
- React `.tsx` files exempt from `explicit-function-return-type`

## Documentation

See `docs/` for additional context (setup guides, API references, etc.).

## Migration Freeze Rule (Phase 0, 2026-08-06)

No new subsystem, engine, or definition directory may land unless the same
PR deletes the predecessor it replaces. Extension happens through library
skills and projects/ definitions — never through new core strata.
See docs/assessments/2026-08-06-architecture-assessment.md for the roadmap.

## Environment

- Runtime: Node.js 22+ on WSL2 (Linux), Windows host accessible
- Docker available for containerized deployment
- SQLite for persistence (single file at `data/raven.db`)
- User has MAX plan for Claude - SDK uses `claude` CLI auth, NOT ANTHROPIC_API_KEY
- Telegram and TickTick desktop apps installed on Windows side
