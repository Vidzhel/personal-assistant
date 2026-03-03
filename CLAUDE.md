# Raven - Development Guide

## Project Structure

npm workspaces monorepo. All packages use TypeScript ESM (`"type": "module"`).

```
packages/shared/     → @raven/shared   (types, utils - built first)
packages/core/       → @raven/core     (orchestrator, agents, API, scheduler)
packages/web/        → @raven/web      (Next.js dashboard)
packages/skills/     → @raven/skill-*  (plugin skills)
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
- No classes except for skills implementing `RavenSkill` and the `BaseSkill` abstract class
- Prefer functions and composition over class hierarchies
- All async functions must handle errors - never swallow exceptions silently
- Use `crypto.randomUUID()` for ID generation

## MCP Isolation (Critical Rule)

**MCPs are NEVER loaded into the main orchestrator agent context.**

- Each skill declares sub-agents that carry only that skill's MCPs
- The orchestrator agent has zero MCP servers - it delegates to skill sub-agents
- Sub-agents are spawned on-demand with `query()` from `@anthropic-ai/claude-code`
- This keeps context windows small and prevents tool namespace pollution
- See `ARCHITECTURE.md` for the full sub-agent delegation model

## Key Interfaces

- `RavenSkill` (`packages/shared/src/types/skills.ts`) - Every skill implements this
- `RavenEvent` (`packages/shared/src/types/events.ts`) - All events on the bus
- `AgentTask` (`packages/shared/src/types/agents.ts`) - Agent task lifecycle

## Adding a New Skill

1. Create `packages/skills/skill-<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`
2. Implement `RavenSkill` interface (extend `BaseSkill` for defaults)
3. Declare MCP servers in `getMcpServers()` (lazy - only spawned with sub-agents)
4. Declare sub-agent definitions in `getAgentDefinitions()`
5. Add to `config/skills.json` with `enabled: true`
6. Add workspace to root `package.json` workspaces array

## File Naming

- `kebab-case.ts` for all files
- Types in `packages/shared/src/types/`
- One concern per file - keep files focused and under 300 lines

## Git Workflow

- Claude manages this project: track changes, commit, and push to repository
- Always commit meaningful changes with descriptive messages
- Push to remote to persist work across sessions

## Testing

Run core without skills to verify infrastructure:
```bash
RAVEN_PORT=3001 node packages/core/dist/index.js
curl http://localhost:3001/api/health
```

## Linting & Formatting

- ESLint 9 (flat config) with `typescript-eslint` strict rules + Prettier
- `npm run check` must pass after every task (runs `format:check` + `lint`)
- `npm run lint` — ESLint + TypeScript type-check
- `npm run format` — Prettier write mode
- `no-restricted-syntax` rule bans `.js` import extensions (use `.ts` only)
- `no-console` enforced — use `createLogger()` from `@raven/shared`
- AI guardrail rules (warn): `max-lines-per-function` (50), `complexity` (10), `no-magic-numbers`
- AI guardrail rules (error): `max-params` (3), `explicit-function-return-type`, `consistent-type-imports`
- Test files (`__tests__/**`) have relaxed rules: `any`, `non-null-assertion`, `console`, guardrails off
- React `.tsx` files exempt from `explicit-function-return-type`

## Environment

- Runtime: Node.js 22+ on WSL2 (Linux), Windows host accessible
- Docker available for containerized deployment
- SQLite for persistence (single file at `data/raven.db`)
- User has MAX plan for Claude - SDK uses `claude` CLI auth, NOT ANTHROPIC_API_KEY
- Telegram and TickTick desktop apps installed on Windows side
