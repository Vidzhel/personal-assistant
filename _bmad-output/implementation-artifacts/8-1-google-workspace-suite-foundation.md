# Story 8.1: Google Workspace Suite Foundation — Direct CLI Agent & Email Watcher

Status: done

## Story

As the system operator,
I want Raven to integrate the full Google Workspace via the `gws` CLI with direct Bash execution, multi-account support, and Pub/Sub email monitoring,
so that Calendar, Drive, Meet, Gmail, Docs, Tasks, People, and workflow helpers are all accessible through the orchestrator.

## Acceptance Criteria

1. **Given** the `gws` CLI (v0.18.1+) is installed and authenticated, **when** the google-workspace suite loads, **then** the gws-agent can execute any `gws` command directly via Bash with `--format json` for structured output.

2. **Given** the agent has Bash, Read, and Grep tools, **when** any Google Workspace operation is requested, **then** it constructs the correct `gws` CLI command from its prompt reference and skill docs, executes it, and parses the JSON result.

3. **Given** two credential files exist (primary + meet account), **when** the agent needs to use the meet account, **then** it prefixes the command with `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_MEET_CREDENTIALS_FILE` to switch contexts.

4. **Given** `GWS_GCP_PROJECT_ID` is configured, **when** the email watcher service starts, **then** it spawns `gws gmail +watch` as a child process, parses NDJSON stdout, and emits `email:new` events on the event bus.

5. **Given** the email watcher's child process exits unexpectedly, **when** 30 seconds elapse, **then** the service reconnects automatically (same pattern as IMAP watcher).

6. **Given** the gws-agent is wired into the productivity-coordinator, **when** a user asks "What's on my calendar today?", **then** the orchestrator delegates to gws-agent which runs `gws calendar +agenda --today --format json` and returns the result.

7. **Given** `scripts/update-gws-skills.sh` is run, **when** it fetches skill docs from the `gws` CLI GitHub repo, **then** all SKILL.md files are downloaded into `suites/google-workspace/skills-reference/` organized by type.

8. **Given** the gws-agent prompt references bundled skill docs, **when** it encounters an unfamiliar operation, **then** it can `Read` the skill reference files for exact command syntax, flags, and examples.

## Tasks / Subtasks

- [x] Task 1: Shared constants (AC: #1, #6)
  - [x] Add `SUITE_GOOGLE_WORKSPACE`, `AGENT_GWS`, `SOURCE_GWS_GMAIL` to `packages/shared/src/suites/constants.ts`
  - [x] Export from `packages/shared/src/suites/index.ts`

- [x] Task 2: Suite definition `suites/google-workspace/` (AC: #1, #3)
  - [x] Create `suite.ts` with `defineSuite()` — capabilities: agent-definition, event-source, services
  - [x] Create `agents/gws-agent.ts` with `defineAgent()` — tools: [Bash, Read, Grep], prompt with CLI reference
  - [x] Create `actions.json` — green/yellow/red tiered actions (16 actions)
  - [x] Create `schedules.json` — empty array

- [x] Task 3: Download & bundle gws skill reference docs (AC: #7, #8)
  - [x] Create `scripts/update-gws-skills.sh` — fetches skills index from GitHub, downloads SKILL.md files into `suites/google-workspace/skills-reference/{services,helpers,recipes}/`
  - [x] Add `"update:gws": "bash scripts/update-gws-skills.sh"` to root `package.json` scripts

- [x] Task 4: Email watcher service (AC: #4, #5)
  - [x] Implement `suites/google-workspace/services/email-watcher.ts` — SuiteService that spawns `gws gmail +watch`
  - [x] NDJSON line parsing, `email:new` event emission (same payload shape as IMAP watcher)
  - [x] Reconnect logic on child exit (30s delay, same pattern as IMAP watcher)

- [x] Task 5: Orchestrator wiring (AC: #6)
  - [x] Update `suites/_orchestrator/agents/productivity-coordinator.ts` — add `AGENT_GWS` to tools and prompt

- [x] Task 6: Configuration (AC: #1)
  - [x] Add `google-workspace` entry to `config/suites.json`
  - [x] Add `GWS_PRIMARY_CREDENTIALS_FILE`, `GWS_MEET_CREDENTIALS_FILE`, `GWS_GCP_PROJECT_ID` to `.env.example`

- [x] Task 7: Documentation (AC: #7)
  - [x] Create `docs/GOOGLE_WORKSPACE_SETUP.md` — install, auth, multi-account, Pub/Sub, env vars, verification, troubleshooting
  - [x] Update `README.md` — add GWS to features, env vars table, link to setup doc

- [x] Task 8: Tests (AC: #4, #5)
  - [x] `suites/google-workspace/__tests__/email-watcher.test.ts` — mock `spawn`, test NDJSON parsing/event emission/reconnect (8 tests)

## Dev Notes

### Architecture: Direct CLI Execution (no MCP)

The gws-agent uses **direct CLI execution** instead of an MCP server wrapper. This was a deliberate architectural choice after code review found that:

1. The MCP approach had 5 CLI flag mismatches that would cause runtime failures
2. Typed Zod schemas only exposed ~30% of CLI flexibility
3. Every CLI update required manual schema changes across 8 tool files
4. The agent already has Read access to skill reference docs, making MCP tool discovery redundant

The agent has `tools: ['Bash', 'Read', 'Grep']` and its prompt contains:
- Complete CLI command syntax reference (helpers + API commands)
- Service/capability table for all 14+ gws services
- Multi-account env var pattern
- Common command examples
- Pointers to skill-reference docs for detailed flag info

### Multi-Account Support

Primary account: default (no env var prefix needed).
Meet account: `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_MEET_CREDENTIALS_FILE gws meet ...`

### Email Watcher Service Pattern (follow `suites/email/services/imap-watcher.ts`)

- Export default `SuiteService` object with `start(context)` and `stop()`
- `start()`: read config from env vars, spawn child process, listen to stdout
- NDJSON parsing: buffer chunks, split on `\n`, parse complete lines as JSON
- Emit events: `eventBus.emit({ id, timestamp, source: SOURCE_GWS_GMAIL, type: 'email:new', payload: { from, subject, snippet, messageId, receivedAt } })`
- Reconnect: `setTimeout(() => spawn(), 30_000)` on child exit while `running === true`
- `stop()`: set `running = false`, kill child process, clear reconnect timer

### gws CLI Quick Reference

- **Installed at**: `/home/user/.nvm/versions/node/v22.14.0/bin/gws` (v0.18.1, Rust binary)
- **Auth status**: OAuth2, user `partyskytime@gmail.com`, token valid, 32 APIs enabled
- **Command pattern**: `gws <service> <resource> <method> --params '{}' --json '{}' --format json`
- **Helper pattern**: `gws <service> +<helper> --flag value --format json`
- **Services**: gmail, calendar, drive, meet, tasks, docs, people, sheets, slides, chat, classroom, forms, keep, admin-reports

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- email-watcher `stop()` guards `logger?.info()` because reimported modules may not have `start()` called
- Originally implemented as MCP server package, refactored to direct CLI execution after code review

### Completion Notes List
- Task 1: Added `SUITE_GOOGLE_WORKSPACE`, `AGENT_GWS`, `SOURCE_GWS_GMAIL` constants + exports
- Task 2: Created suite definition with `defineSuite()`, `gws-agent.ts` with `defineAgent()` + `buildPrompt()` (Bash/Read/Grep tools, CLI reference prompt), `actions.json` (16 tiered actions), `schedules.json` (empty)
- Task 3: Created `scripts/update-gws-skills.sh` to fetch skill docs from GitHub, added `update:gws` npm script, created directory structure
- Task 4: Implemented email watcher service spawning `gws gmail +watch`, NDJSON parsing, `email:new` event emission (compatible payload shape with IMAP watcher), 30s reconnect on exit
- Task 5: Wired `AGENT_GWS` into productivity-coordinator tools and prompt
- Task 6: Added `google-workspace` to `config/suites.json`, added env vars to `.env.example`
- Task 7: Created `docs/GOOGLE_WORKSPACE_SETUP.md`, updated `README.md` with GWS feature, env vars, and setup doc link
- Task 8: 8 email-watcher tests (spawn args, NDJSON parsing, event emission, reconnect, stop, missing config)
- Refactor: Removed MCP server package (packages/mcp-google-workspace/) after code review — replaced with direct CLI execution via Bash tool. Deleted 1,462 lines of MCP wrapper code.

### Change Log
- 2026-03-19: Story 8.1 implemented — initial MCP server approach with 42 typed tools
- 2026-03-19: Code review — found 5 CLI flag mismatches, missing flags, duplicate tools
- 2026-03-19: Refactored to direct CLI execution — deleted MCP package, rewrote agent to use Bash+Read+Grep
- 2026-03-19: Code review (adversarial) — fixed stale MCP references in GOOGLE_WORKSPACE_SETUP.md, removed false vitest.config.ts/eslint.config.ts from File List

### File List
- packages/shared/src/suites/constants.ts (modified)
- packages/shared/src/suites/index.ts (modified)
- scripts/update-gws-skills.sh (new)
- suites/google-workspace/suite.ts (new)
- suites/google-workspace/actions.json (new)
- suites/google-workspace/schedules.json (new)
- suites/google-workspace/agents/gws-agent.ts (new)
- suites/google-workspace/services/email-watcher.ts (new)
- suites/google-workspace/__tests__/email-watcher.test.ts (new)
- suites/_orchestrator/agents/productivity-coordinator.ts (modified)
- config/suites.json (modified)
- .env.example (modified)
- docs/GOOGLE_WORKSPACE_SETUP.md (new)
- README.md (modified)
- package.json (modified)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)
