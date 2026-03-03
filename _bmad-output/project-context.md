---
project_name: 'personal-assistant'
user_name: 'User'
date: '2026-03-03'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'code_quality', 'workflow_rules', 'critical_rules']
status: 'complete'
rule_count: 62
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- **Runtime:** Node.js 22+ (ESM only, `"type": "module"` in all packages)
- **Language:** TypeScript ^5.7.0 — strict mode, ES2024 target, `NodeNext` module resolution
- **AI SDK:** `@anthropic-ai/claude-code` ^1.0.0 (Claude Agent SDK, uses `claude` CLI auth — no API key needed)
- **HTTP:** Fastify ^5.2.0 + `@fastify/websocket` ^11.0.0
- **Database:** better-sqlite3 ^11.7.0 (single file at `data/raven.db`)
- **Validation:** Zod ^3.23.0
- **Logging:** Pino ^9.6.0 + pino-pretty ^13.0.0
- **Scheduling:** Croner ^9.0.0
- **Frontend:** Next.js ^15.1.0, React ^19.0.0, Zustand ^5.0.0, Tailwind CSS ^4.0.0
- **Testing:** Vitest ^4.0.18 (root devDependency, `test.projects` config — not `workspace`)
- **Monorepo:** npm workspaces (`@raven/shared`, `@raven/core`, `@raven/web`, `@raven/skill-*`)

## Critical Implementation Rules

### Language-Specific Rules (TypeScript ESM)

- **`.ts` extensions required in all relative imports** — `import { foo } from './bar.ts'` (not `./bar` or `./bar.js`). Requires `allowImportingTsExtensions` in tsconfig. Node 22 `--experimental-strip-types` supports this natively
- **`node:` prefix required for Node.js builtins** — `import { readFile } from 'node:fs/promises'`, never bare `fs`
- **Cross-package imports use workspace names** — `import { createLogger } from '@raven/shared'`
- **Zod `safeParse()` at system boundaries** — config loading, user input, external API responses
- **Pino structured logging only** — never `console.log`; create loggers via `createLogger('component-name')`
- **No classes** except skills implementing `RavenSkill` / extending `BaseSkill` — prefer functions and composition
- **`crypto.randomUUID()` for all ID generation** — no external UUID libraries
- **All async functions must handle errors** — never swallow exceptions silently
- **Fatal config errors → `process.exit(1)`** — non-fatal skill load failures log a warning and continue
- **One concern per file, max 300 lines** — split if a file grows beyond this
- **Skills export a default factory function** — `export default function createSkill(): RavenSkill`

### Framework-Specific Rules

**MCP Isolation (Most Critical Rule):**
- The orchestrator agent has **zero MCP servers** — it delegates ALL tool use to skill sub-agents
- Sub-agents are spawned via `query()` from `@anthropic-ai/claude-code` with only that skill's MCPs
- Sub-agents must NEVER call other sub-agents — the orchestrator is the sole coordination point
- MCP tool naming convention in `tools` arrays: `mcp__<server-name>_<namespace>__*` (glob pattern)
- MCP tool glob mismatches fail silently — sub-agent launches with zero tools, no error thrown

**Event Bus:**
- The bus is for **async fire-and-forget events only** — `emit()` has no return value
- Synchronous request-response (API handlers, direct function calls) does NOT go through the bus
- Events are typed via `RavenEvent` / `RavenEventType` from `@raven/shared`
- Adding a new event type requires: type definition in shared → handler in the consuming component
- `emit()` with no registered handler silently drops the event — no error

**Fastify API:**
- Routes registered via factory function `createApiServer()` — dependencies injected, not imported as singletons
- REST endpoints under `/api/` prefix
- WebSocket at `/ws` — adding new message types requires handlers on BOTH server (Fastify) and client (Next.js)

**Skill Plugin System:**
- Each skill is an npm workspace: `packages/skills/skill-<name>/`
- Implements `RavenSkill` interface, exports default factory: `export default function createSkill(): RavenSkill`
- Enable/disable in `config/skills.json`
- Skills declare sub-agents in `getAgentDefinitions()` and MCPs in `getMcpServers()`
- Skills must NEVER import from or reference other skills directly
- Cross-skill data flows through the orchestrator (sub-agent composition) or event bus only
- Skills must ONLY access the database via `context.db` (`DatabaseInterface`) — never import `better-sqlite3` directly

**Build Order:**
- `@raven/shared` MUST build first — all packages depend on it
- `npm run build` handles the correct order (`shared` → `core`)
- After changing shared types, rebuild shared before consuming packages will see changes

**Next.js Web Dashboard:**
- Zustand for client state (not Redux, not Context)
- Tailwind CSS 4 for styling
- Connects to core via WebSocket + REST

**Concurrency & Non-Blocking:**
- The assistant must NEVER block — multiple sessions can run simultaneously
- Agent tasks execute concurrently (up to `RAVEN_MAX_CONCURRENT_AGENTS`, default 3)
- All I/O must be non-blocking — never use synchronous operations in request paths
- Event handlers must not block the event loop — long work should be delegated to agent tasks
- User chat in one session must not wait for agent completion in another session

**Open-Ended Task Execution:**
- The system has NO hard-coded or fixed workflows — the orchestrator dynamically decides how to fulfill any request
- Tasks are accomplished using all available skills and tools at hand, composed at runtime
- New integrations and skills are designed to be easily added without modifying core orchestration logic
- The orchestrator treats skills as a toolbox, not a pipeline — any combination of sub-agents can be invoked for any task

**No Hardcoded Environment Values:**
- All ports, paths, credentials, and URLs must come from env vars or config files
- Never hardcode `localhost:3001` or file paths — use `getConfig()` values

**Graceful Degradation:**
- Individual skill load failures must never crash the process — log warning, continue
- Individual agent task errors must be caught and reported, never bubble up to crash the event loop

### Testing Rules

- **Framework:** Vitest 4 with `test.projects` in root config (NOT the deprecated `workspace` config)
- **Test location:** `packages/*/src/__tests__/*.test.ts`
- **Always mock `@anthropic-ai/claude-code`** — never spawn real Claude subprocesses in tests
- **Mock pattern:** `vi.mock()` with async generator yielding `system` → `assistant` → `result` messages
- **Mock config module** to avoid env var dependencies: `vi.mock('../config.ts', () => ({...}))`
- **Temp SQLite DBs** via `mkdtempSync()` for database isolation — clean up in `afterEach`
- **No shared state between tests** — each test gets its own fresh DB
- **Prefer E2E/integration tests** that exercise real flows (boot → chat → event → completion)
- **Unit tests only for complex/reused logic** — config parsing, event bus, skill registry, prompt building
- **Keep tests sane and high-value** — no micro-detail or cosmetic tests

### Code Quality & Style Rules

**File & Folder Structure:**
- `kebab-case.ts` for all file names
- Types centralized in `packages/shared/src/types/`
- One concern per file — max 300 lines
- Skills in `packages/skills/skill-<name>/src/index.ts`
- Core subsystems each get their own directory: `agent-manager/`, `event-bus/`, `orchestrator/`, etc.

**Naming Conventions:**
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase` (`RavenSkill`, `SkillManifest`, `AgentTaskPayload`)
- Functions: `camelCase` (`createSkill`, `loadConfig`, `createApiServer`)
- Constants: `UPPER_SNAKE_CASE` for env vars (`RAVEN_PORT`, `CLAUDE_MODEL`)
- Event types: `colon-separated` lowercase (`email:new`, `schedule:triggered`, `agent:task:complete`)

**Linting & Formatting:**
- ESLint 9 (flat config) with `typescript-eslint` strict rules enforced
- Prettier configured (2-space indent, single quotes, trailing commas, 100 char width)
- `npm run check` runs format check + ESLint + TypeScript type-check — must pass after every task
- `no-restricted-syntax` rule bans `.js` import extensions (use `.ts` only)
- `no-console` enforced — use `createLogger()` from `@raven/shared`
- Test files (`__tests__/**`) have relaxed rules: `any`, `non-null-assertion`, `console` allowed

**Documentation:**
- No docstrings or JSDoc required — code should be self-explanatory
- Only add comments where logic isn't self-evident
- `ARCHITECTURE.md` and `CLAUDE.md` serve as project-level documentation

### Development Workflow Rules

**Git:**
- Claude manages this project — commits, pushes, and tracks changes
- Always commit meaningful changes with descriptive messages
- Push to remote to persist work across sessions
- Single `master` branch

**Build & Run:**
- `npm run build` — builds shared → core (correct dependency order)
- `npm run build:all` — builds all packages including skills
- `npm run dev:core` — watch mode with `--experimental-strip-types`
- `npm run dev:web` — Next.js dev server on port 3000
- `npm test` — Vitest run (all tests)
- `docker-compose up --build` — full stack deployment

**Deployment:**
- Two Docker containers: `raven-core` (port 3001) + `raven-web` (port 3000)
- Volumes: `./data` (SQLite DB + sessions), `./config` (skill/schedule configuration)

**Environment:**
- Runtime on WSL2 Linux, Windows host accessible
- Telegram + TickTick desktop apps on Windows side
- Docker available for containerized deployment

### Critical Don't-Miss Rules

**Anti-Patterns — NEVER Do These:**
- NEVER load MCP servers into the orchestrator agent — delegate ALL tool use to skill sub-agents
- NEVER import `better-sqlite3` directly in a skill — use `context.db` (`DatabaseInterface`)
- NEVER use `console.log` — always Pino via `createLogger()`
- NEVER use bare `fs` imports — always `node:` prefix (`node:fs`, `node:path`, etc.)
- NEVER omit extensions in relative imports — always use `.ts` extensions
- NEVER hardcode ports, paths, or credentials — use config/env vars via `getConfig()`
- NEVER have sub-agents call other sub-agents — orchestrator is the sole coordinator
- NEVER import from or reference other skills directly — cross-skill flows go through orchestrator/event bus

**Silent Failures to Watch For:**
- MCP tool glob mismatches — sub-agent launches with zero tools, no error thrown
- Event bus `emit()` with no registered handler — event silently dropped
- Missing skill registration (any of: workspaces array, `skillModules` map, `config/skills.json`) — skill silently not loaded

**Security:**
- Never commit `.env` files or credentials to git
- Skill configs in `config/skills.json` must not contain secrets — use env vars
- Validate all external input with Zod at API boundaries

**Performance:**
- `better-sqlite3` is synchronous — keep DB queries small and fast to avoid blocking
- `handleScheduledTask()` must return promptly — delegate heavy work to agent tasks via event bus
- Never perform long-running I/O synchronously in request paths or event handlers

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Update this file if new patterns emerge

**For Humans:**
- Keep this file lean and focused on agent needs
- Update when technology stack changes
- Review quarterly for outdated rules
- Remove rules that become obvious over time

Last Updated: 2026-03-03
