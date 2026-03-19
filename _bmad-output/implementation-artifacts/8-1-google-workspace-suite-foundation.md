# Story 8.1: Google Workspace Suite Foundation — MCP Server, Agent & Email Watcher

Status: review

## Story

As the system operator,
I want Raven to integrate the full Google Workspace via the `gws` CLI with a custom MCP server, multi-account support, and Pub/Sub email monitoring,
so that Calendar, Drive, Meet, Gmail, Docs, Tasks, People, and workflow helpers are all accessible through the orchestrator.

## Acceptance Criteria

1. **Given** the `gws` CLI (v0.18.1+) is installed and authenticated, **when** the google-workspace suite loads, **then** a custom MCP server (`@raven/mcp-google-workspace`) wraps `gws` commands as MCP tools via `execFile` (no shell injection).

2. **Given** the MCP server starts with `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` set, **when** any tool is invoked (e.g. `calendar_agenda`), **then** it spawns `gws` with the correct args, returns parsed JSON, and handles errors with structured error messages.

3. **Given** two credential files exist (primary + meet account), **when** the suite's `mcp.json` declares two MCP instances (`gws-primary` and `gws-meet`), **then** each instance uses its own credential file and the agent can access both simultaneously.

4. **Given** `GWS_GCP_PROJECT_ID` is configured, **when** the email watcher service starts, **then** it spawns `gws gmail +watch` as a child process, parses NDJSON stdout, and emits `email:new` events on the event bus.

5. **Given** the email watcher's child process exits unexpectedly, **when** 30 seconds elapse, **then** the service reconnects automatically (same pattern as IMAP watcher).

6. **Given** the gws-agent is wired into the productivity-coordinator, **when** a user asks "What's on my calendar today?", **then** the orchestrator delegates to gws-agent which calls `calendar_agenda` and returns the result.

7. **Given** `scripts/update-gws-skills.sh` is run, **when** it fetches skill docs from the `gws` CLI GitHub repo, **then** all SKILL.md files are downloaded into `suites/google-workspace/skills-reference/` organized by type.

8. **Given** the gws-agent prompt references bundled skill docs, **when** it encounters an unfamiliar operation, **then** it can `Read` the skill reference files for exact command syntax, flags, and examples.

## Tasks / Subtasks

- [x] Task 1: Shared constants (AC: #1, #6)
  - [x] Add `SUITE_GOOGLE_WORKSPACE`, `MCP_GWS_PRIMARY`, `MCP_GWS_MEET`, `AGENT_GWS` to `packages/shared/src/suites/constants.ts`
  - [x] Export from `packages/shared/src/suites/index.ts`

- [x] Task 2: MCP server package `packages/mcp-google-workspace/` (AC: #1, #2)
  - [x] Create `package.json` (deps: `@modelcontextprotocol/sdk`, `zod`)
  - [x] Create `tsconfig.json` extending `../../tsconfig.base.json`
  - [x] Implement `src/gws-exec.ts` — `execFile` wrapper for `gws` CLI
  - [x] Implement `src/index.ts` — McpServer + StdioServerTransport entry point
  - [x] Implement tool files: `src/tools/gmail.ts`, `calendar.ts`, `drive.ts`, `meet.ts`, `tasks.ts`, `docs.ts`, `people.ts`, `workflow.ts`
  - [x] Implement `src/register-all.ts` — imports and registers all tool modules
  - [x] Add `"packages/mcp-google-workspace"` to root `package.json` workspaces

- [x] Task 3: Download & bundle gws skill reference docs (AC: #7, #8)
  - [x] Create `scripts/update-gws-skills.sh` — fetches skills index from GitHub, downloads SKILL.md files into `suites/google-workspace/skills-reference/{services,helpers,recipes}/`
  - [x] Add `"update:gws": "bash scripts/update-gws-skills.sh"` to root `package.json` scripts
  - [x] Run the script to populate initial skill docs

- [x] Task 4: Suite definition `suites/google-workspace/` (AC: #1, #3)
  - [x] Create `suite.ts` with `defineSuite()`
  - [x] Create `mcp.json` with two MCP entries: `gws-primary` and `gws-meet`
  - [x] Create `agents/gws-agent.ts` with `defineAgent()` — both MCPs, skill doc references in prompt
  - [x] Create `actions.json` — green/yellow/red tiered actions
  - [x] Create `schedules.json` — empty array

- [x] Task 5: Email watcher service (AC: #4, #5)
  - [x] Implement `suites/google-workspace/services/email-watcher.ts` — SuiteService that spawns `gws gmail +watch`
  - [x] NDJSON line parsing, `email:new` event emission (same payload shape as IMAP watcher)
  - [x] Reconnect logic on child exit (30s delay, same pattern as IMAP watcher)

- [x] Task 6: Orchestrator wiring (AC: #6)
  - [x] Update `suites/_orchestrator/agents/productivity-coordinator.ts` — add `AGENT_GWS` to tools and prompt

- [x] Task 7: Configuration (AC: #1)
  - [x] Add `google-workspace` entry to `config/suites.json`
  - [x] Add `GWS_PRIMARY_CREDENTIALS_FILE`, `GWS_MEET_CREDENTIALS_FILE`, `GWS_GCP_PROJECT_ID` to `.env.example`

- [x] Task 8: Documentation (AC: #7)
  - [x] Create `docs/GOOGLE_WORKSPACE_SETUP.md` — install, auth, multi-account, Pub/Sub, env vars, verification, troubleshooting
  - [x] Update `README.md` — add GWS to features, env vars table, link to setup doc

- [x] Task 9: Tests (AC: #1, #2, #4, #5)
  - [x] `packages/mcp-google-workspace/src/__tests__/gws-exec.test.ts` — mock `execFile`, test args/env/JSON parsing/errors/timeout (9 tests)
  - [x] `suites/google-workspace/__tests__/email-watcher.test.ts` — mock `spawn`, test NDJSON parsing/event emission/reconnect (8 tests)

## Dev Notes

### Critical Architecture Rules

- **MCP Isolation**: Orchestrator has ZERO MCPs. Only `gws-agent` sub-agent carries the gws MCP servers.
- **`execFile` only**: Never use `exec` or `execSync` — prevents shell injection. Import from `node:child_process`.
- **Two MCP instances, one binary**: Both `gws-primary` and `gws-meet` run the same `packages/mcp-google-workspace/src/index.ts` but with different `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env vars.
- **Email event compatibility**: The email watcher must emit `email:new` events with the same payload shape as the existing IMAP watcher in `suites/email/services/imap-watcher.ts` so the orchestrator and email-triage service work unchanged.

### gws CLI Quick Reference

- **Installed at**: `/home/user/.nvm/versions/node/v22.14.0/bin/gws` (v0.18.1, Rust binary)
- **Auth status**: OAuth2, user `partyskytime@gmail.com`, token valid, 32 APIs enabled
- **`gws mcp` NOT available** in v0.18.1 — that's why we build a custom MCP server wrapping CLI commands
- **Command pattern**: `gws <service> <resource> <method> --params '{}' --json '{}' --format json`
- **Helper pattern**: `gws <service> +<helper> --flag value --format json`
- **Gmail +watch**: `gws gmail +watch --project <GCP_PROJECT_ID> --label-ids INBOX --msg-format metadata --format json` — outputs NDJSON, requires Pub/Sub
- **Multi-account**: `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/creds.json gws ...` — CLI uses this file for auth

### MCP Server Pattern (follow `packages/mcp-ticktick/`)

**Entry point** (`src/index.ts`):
```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './register-all.ts';

const credFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
if (!credFile) {
  process.stderr.write('Error: GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is required\n');
  process.exit(1);
}

const server = new McpServer({ name: 'raven-mcp-google-workspace', version: '0.1.0' });
registerAllTools(server, credFile);
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Tool registration** (`src/tools/*.ts`):
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

export function registerCalendarTools(server: McpServer, credFile: string): void {
  server.registerTool('calendar_agenda', {
    description: 'Show upcoming calendar events',
    inputSchema: {
      today: z.boolean().optional().describe('Show only today'),
      days: z.number().optional().describe('Number of days to show'),
      timezone: z.string().optional().describe('IANA timezone'),
    },
  }, async (input) => {
    const args = ['calendar', '+agenda', '--format', 'json'];
    if (input.today) args.push('--today');
    if (input.days) args.push('--days', String(input.days));
    if (input.timezone) args.push('--timezone', input.timezone);
    const result = await gwsExec(args, { credentialsFile: credFile });
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  });
}
```

**gws-exec** (`src/gws-exec.ts`):
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT = 30_000;

interface GwsResult { data: unknown; stderr: string }

export async function gwsExec(
  args: string[],
  opts?: { credentialsFile?: string; timeout?: number },
): Promise<GwsResult> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts?.credentialsFile) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = opts.credentialsFile;
  }
  const { stdout, stderr } = await execFileAsync('gws', args, {
    env,
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
  });
  const data = stdout.trim() ? JSON.parse(stdout) : null;
  return { data, stderr };
}
```

### Suite Definition Pattern (follow `suites/task-management/`)

**`suite.ts`**: `defineSuite()` with name, capabilities, requiresEnv, services array
**`mcp.json`**: MCP server entries with `"${ENV_VAR}"` syntax for env interpolation
**`agents/*.ts`**: `defineAgent()` with name, tools (`buildMcpToolPattern()`), mcpServers, prompt
**`actions.json`**: Array of `{ name: "gws:action-name", description, defaultTier, reversible }`

### Email Watcher Service Pattern (follow `suites/email/services/imap-watcher.ts`)

- Export default `SuiteService` object with `start(context)` and `stop()`
- `start()`: read config from `context.config`, spawn child process, listen to stdout
- NDJSON parsing: buffer chunks, split on `\n`, parse complete lines as JSON
- Emit events: `context.eventBus.emit({ id: generateId(), timestamp: Date.now(), source: SOURCE_GMAIL, type: 'email:new', payload: { from, subject, snippet, messageId, receivedAt } })`
- Reconnect: `setTimeout(() => spawn(), 30_000)` on child exit while `running === true`
- `stop()`: set `running = false`, kill child process, clear reconnect timer

### Tool Files Structure (~35 tools across 8 files)

| File | Tool count | Key gws commands |
|------|-----------|-----------------|
| `gmail.ts` | 9 | `+triage`, `+read`, `+send`, `+reply`, `+reply-all`, `+forward`, `users messages list/modify` |
| `calendar.ts` | 6 | `+agenda`, `+insert`, `events get/patch/delete`, `calendarList list` |
| `drive.ts` | 5 | `files list/get/create/delete`, `+upload` |
| `meet.ts` | 8 | `conferenceRecords list/get`, `recordings list/get`, `transcripts list/entries`, `participants list`, `smartNotes list` |
| `tasks.ts` | 6 | `tasklists list`, `tasks list/insert/patch/delete` + complete helper |
| `docs.ts` | 2 | `documents get/create` |
| `people.ts` | 2 | `people searchContacts`, `people connections list` |
| `workflow.ts` | 4 | `+standup-report`, `+meeting-prep`, `+email-to-task`, `+weekly-digest` |

### Agent Prompt Design

The `gws-agent` prompt should:
1. Explain it has two MCP server connections (primary + meet)
2. List which tools come from which MCP (meet tools = Meet recordings/transcripts)
3. Include a condensed quick-reference of common helper commands with key flags
4. Tell the agent it has `Read` tool access to `suites/google-workspace/skills-reference/` for detailed docs
5. List all available recipe names so it knows what multi-step workflows exist

### Update Script (`scripts/update-gws-skills.sh`)

The script should:
1. Fetch `https://raw.githubusercontent.com/googleworkspace/cli/main/docs/skills-index.md`
2. Parse skill names from the markdown table links (format: `[gws-*](../skills/gws-*/SKILL.md)`)
3. Categorize: `gws-<service>` → services/, `gws-<service>-<helper>` → helpers/, `recipe-*` → recipes/, `persona-*` → skip
4. Download each to the correct subdir
5. Update `gws` CLI: `npm update -g @googleworkspace/cli`
6. Print summary

Wire into root `package.json`: `"update:gws": "bash scripts/update-gws-skills.sh"`

### ESLint Notes

- `.ts` extensions in all imports (enforced)
- `no-console` — use `process.stderr.write()` in MCP server entry points (not `createLogger` since MCP stdio uses stdout)
- `max-lines-per-function: 50` — split tool registration into per-domain files
- `max-params: 3` — use config objects
- `explicit-function-return-type` — required on all functions
- Suppress `max-lines-per-function` on `register-all.ts` with eslint comment if needed

### Project Structure Notes

- `packages/mcp-google-workspace/` — new workspace, add to root `package.json` workspaces array
- `suites/google-workspace/` — new suite directory (auto-discovered by suite-loader)
- `scripts/update-gws-skills.sh` — new script, add npm script alias
- `suites/google-workspace/skills-reference/` — gitignored or committed (user choice)
- Constants in `packages/shared/src/suites/constants.ts` — triggers rebuild of shared package

### References

- [Source: packages/mcp-ticktick/src/index.ts] — MCP server entry point pattern
- [Source: packages/mcp-ticktick/src/tools.ts] — Tool registration with Zod schemas
- [Source: packages/mcp-ticktick/src/client.ts] — API client wrapper pattern
- [Source: packages/shared/src/suites/define.ts] — defineSuite(), defineAgent(), buildMcpToolPattern()
- [Source: packages/shared/src/suites/constants.ts] — Constants to extend
- [Source: packages/shared/src/suites/mcp-naming.ts] — MCP namespacing (suite_localKey)
- [Source: suites/email/services/imap-watcher.ts] — Email watcher service pattern
- [Source: suites/task-management/agents/ticktick-agent.ts] — Agent definition pattern
- [Source: suites/_orchestrator/agents/productivity-coordinator.ts] — Orchestrator to wire into
- [Source: packages/core/src/suite-registry/suite-loader.ts] — Suite validation rules
- [Source: packages/core/src/suite-registry/service-runner.ts] — SuiteService interface
- [Source: config/suites.json] — Suite config format
- [Source: .env.example] — Env var documentation format
- [Source: .claude/plans/mighty-sauteeing-minsky.md] — Full implementation plan

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- gws-exec uses manual Promise wrapper instead of `promisify(execFile)` to enable proper mocking in tests (Node's `execFile` has a custom promisify symbol that breaks when mocked)
- email-watcher `stop()` guards `logger?.info()` because reimported modules may not have `start()` called

### Completion Notes List
- Task 1: Added `SUITE_GOOGLE_WORKSPACE`, `MCP_GWS_PRIMARY`, `MCP_GWS_MEET`, `AGENT_GWS`, `SOURCE_GWS_GMAIL` constants + exports
- Task 2: Created full MCP server package with 42 tools across 8 files (gmail:9, calendar:6, drive:5, meet:8, tasks:6, docs:2, people:2, workflow:4), gws-exec wrapper using execFile (no shell injection), McpServer + StdioServerTransport entry point
- Task 3: Created `scripts/update-gws-skills.sh` to fetch skill docs from GitHub, added `update:gws` npm script, created directory structure
- Task 4: Created suite definition with `defineSuite()`, `mcp.json` (two MCP instances: gws-primary + gws-meet), `gws-agent.ts` with `defineAgent()` + `buildPrompt()`, `actions.json` (16 tiered actions), `schedules.json` (empty)
- Task 5: Implemented email watcher service spawning `gws gmail +watch`, NDJSON parsing, `email:new` event emission (compatible payload shape with IMAP watcher), 30s reconnect on exit
- Task 6: Wired `AGENT_GWS` into productivity-coordinator tools and prompt
- Task 7: Added `google-workspace` to `config/suites.json`, added env vars to `.env.example`
- Task 8: Created `docs/GOOGLE_WORKSPACE_SETUP.md`, updated `README.md` with GWS feature, env vars, and setup doc link
- Task 9: 17 tests total — 9 gws-exec tests (args, env, timeout, JSON parsing, error handling) + 8 email-watcher tests (spawn args, NDJSON parsing, event emission, reconnect, stop, missing config)
- ESLint: Added mcp-google-workspace to node globals, no-deprecated exemption, eslint-disable for max-lines-per-function on tool registration functions

### Change Log
- 2026-03-19: Story 8.1 implemented — full Google Workspace MCP server, suite, agent, email watcher, orchestrator wiring, config, docs, and tests
- 2026-03-19: Code review fixes — corrected CLI flag mismatches (gmail_triage --max, gmail_read --id, drive_upload positional arg, calendar_insert --attendee repeatable), merged gmail_list params into single --params call, removed duplicate gmail_search tool (8→7 gmail tools), added missing CLI flags (--html, --from, --attach on send/reply/forward, --headers on read, --tomorrow/--week/--calendar/--meet on calendar, --page-all on list operations)

### File List
- packages/shared/src/suites/constants.ts (modified)
- packages/shared/src/suites/index.ts (modified)
- packages/mcp-google-workspace/package.json (new)
- packages/mcp-google-workspace/tsconfig.json (new)
- packages/mcp-google-workspace/vitest.config.ts (new)
- packages/mcp-google-workspace/src/index.ts (new)
- packages/mcp-google-workspace/src/gws-exec.ts (new)
- packages/mcp-google-workspace/src/register-all.ts (new)
- packages/mcp-google-workspace/src/tools/gmail.ts (new)
- packages/mcp-google-workspace/src/tools/calendar.ts (new)
- packages/mcp-google-workspace/src/tools/drive.ts (new)
- packages/mcp-google-workspace/src/tools/meet.ts (new)
- packages/mcp-google-workspace/src/tools/tasks.ts (new)
- packages/mcp-google-workspace/src/tools/docs.ts (new)
- packages/mcp-google-workspace/src/tools/people.ts (new)
- packages/mcp-google-workspace/src/tools/workflow.ts (new)
- packages/mcp-google-workspace/src/__tests__/gws-exec.test.ts (new)
- scripts/update-gws-skills.sh (new)
- suites/google-workspace/suite.ts (new)
- suites/google-workspace/mcp.json (new)
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
- vitest.config.ts (modified)
- eslint.config.ts (modified)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)
