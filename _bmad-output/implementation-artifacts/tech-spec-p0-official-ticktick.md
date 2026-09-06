---
title: Official TickTick MCP with usable runtime instructions
type: feature
created: 2026-09-06
status: complete
context:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - personal-assistant-next-steps-2026-09-06.md
---

# Official TickTick MCP with usable runtime instructions

## Intent

The owner approved replacing the problematic local TickTick MCP with its official
service and suitable skills. Keep TickTick authoritative for personal/work
planning. Make the integration capable of inspecting the actual workload and
performing requested task operations correctly; do not reorganize the live account
or implement broader planning/memory features in this slice.

## Verified upstream contract

The public guide was rendered using an isolated Playwright CLI browser on
September 6. It lists 47 tools at `https://mcp.ticktick.com` using Streamable HTTP.
Bearer tokens can be created in TickTick web Settings → Account → API Token.
Use a dedicated MCP token variable, not an assumed-compatible Open API token.
OAuth is another provider option; the Claude Agent SDK does not itself open an
interactive OAuth flow. Bearer setup avoids introducing a new OAuth subsystem.
[Official TickTick guide](https://help.ticktick.com/articles/7438129581631995904),
[Agent SDK MCP authentication](https://code.claude.com/docs/en/agent-sdk/mcp).

## Boundaries

Retain one active TickTick MCP backend per connection. Remote tool permissions
must match actual tool names and existing owner tiers, including nested agents.
No blanket tool approval or hidden downgrade to the local server on failure.
Use environment/secret references, never literal committed credentials. Readiness
must distinguish configured credentials from verified tools. No live mutations
during tests. Account-level verification and any unavailable capability are
reported explicitly. Retiring the local runtime adapter must update its consumers,
build/deployment/test commands and documentation coherently; no legacy migration.

## Code map and execution

- [x] `packages/shared/src/library/schemas.ts` and `types/events.ts`: discriminate
      stdio versus HTTP MCP definitions/configs. Validate endpoint/header definitions,
      disallow ambiguous transports and preserve existing stdio services.
- [x] `packages/core/src/capability-library/capability-library.ts`, loader/validator
      and SDK adapter: resolve secret placeholders consistently; expose missing HTTP
      credentials as unconfigured without sending literal placeholders or empty
      Bearer credentials. A disconnected optional integration must not disable
      unrelated conversation capabilities. Forward only selected servers and no raw secret
      values to diagnostics or run-history files. Test nested scope and revisions.
- [x] `library/mcps/ticktick.json`: select the official HTTP service. Update shipped
      seeds if this capability is supplied there. Supply a safe setup script for the
      dedicated token and wire its environment value into Compose explicitly.
- [x] `library/skills/productivity/task-management/ticktick/skill.md` and config:
      replace generic three-line instructions with concrete discovery, workload,
      dates/timezone, list-ID resolution, mutation/read-back and error workflows.
      Enumerate the official tool-to-action permission mapping; unknown new tools
      retain conservative fallback behavior.
- [x] Task management service consumers: preserve their documented result shape
      or adapt them explicitly to the selected official tools; do not imply that a
      partial task query represents the whole workload. Keep planning data in TickTick.
- [x] Connection readiness: a bounded tools-list check through the official MCP
      client transport, using runtime credentials without model inference or task
      writes; expose count/status and sanitized failure. Use a fake local HTTP MCP
      server for protocol, authentication failure and tool-list tests.
- [x] Setup/docs/config examples: give the exact token location and safe setup
      action; preserve existing unrelated environment values, reject newline/control
      input and never print the token. No manual browser-console instructions.
      Existing deployment libraries are durable and seeds do not overwrite them:
      provide a deliberate install/activate action for the updated TickTick capability,
      not an assumption that rebuilding the image replaces a volume's old definition.

## Skill behavior

Start by inspecting actual available schemas. `list_projects` discovers lists;
`get_project_with_undone_tasks` helps inspect list workload; `search_task`,
`filter_tasks` and `get_task_by_id` find and inspect exact records. Do not invent
legacy names such as `get_task_details`. Handle due dates and scheduled time
according to the tool schema and owner's timezone, including all-day and recurring
tasks. Date-bounded undone queries have a documented 14-day maximum; account-wide
workload needs list coverage and undated tasks, not only a Today query.

Preserve IDs and authoritative links. Before changing an ambiguous task, resolve
the target. Apply requested field changes without overwriting unrelated fields.
Read back changes; on uncertain success, check the account before retrying.
Batch only within documented limits and distinguish partial results. Do not
claim a task was scheduled, completed or deleted merely because a call was sent.
Keep internal service JSON expectations separate from conversational summaries.

## Initial action catalog

Use the actual MCP names below, converted by the existing policy to
`ticktick:<kebab-case-tool-name>`. These are permission categories, not preapproval
for live changes. Confirm the live schema before constructing arguments.

| Tier                     | Official tools                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Green: read              | `search_task`, `get_task_by_id`, `list_undone_tasks_by_time_query`, `list_undone_tasks_by_date`, `list_completed_tasks_by_date`, `filter_tasks`, `list_projects`, `get_project_by_id`, `get_project_with_undone_tasks`, `get_task_in_project`, `list_columns`, `list_project_groups`, `get_comment`, `list_project_members`, `list_tags`, `list_habits`, `list_habit_sections`, `get_habit`, `get_habit_checkins`, `get_focuses_by_time`, `get_focus`, `list_countdowns` |
| Yellow: ordinary changes | `create_project`, `update_project`, `create_column`, `update_column`, `create_project_group`, `update_project_group`, `create_task`, `batch_add_tasks`, `complete_task`, `complete_tasks_in_project`, `update_task`, `move_task`, `batch_update_tasks`, `add_comment`, `assign_task`, `unassign_task`, `create_tag`, `create_habit`, `update_habit`, `upsert_habit_checkins`, `create_focus`                                                                       |
| Red: destructive         | `delete_project_group`, `delete_task`, `delete_comment`, `delete_focus`                                                                                                                                                                                                                                                                                                                                                                                            |

The documented catalog totals 47 tools. Tests should detect missing permission
entries and preserve the conservative policy for an unknown newly advertised tool.

## Acceptance and verification

- Given selected HTTP MCP skills, when a run is admitted, then the real SDK
  receives the correct transport and only the intended scoped tools.
- Given missing/revoked credentials or failed discovery, when readiness runs,
  then it reports a clear failed/unconfigured state without leaking a token.
- Given the official tool catalog, when permissions are resolved, then reads,
  ordinary edits and destructive operations receive their declared effective tiers.
- Given ambiguous lists, undated/overdue tasks, recurring dates or a partial query,
  when the workflow is exercised with fixtures, then it preserves identity and
  states coverage limitations instead of inventing a complete workload.
- Given a temporary fake HTTP server, when responses fail, time out or partially
  succeed, then errors remain visible and mutations are not blindly duplicated.

Run schema/library/policy/SDK/HTTP-protocol/script/service tests, `npm run check`,
default suite and relevant production builds. A live read-only connection check
requires the owner's configured official token; do not substitute default suite
success for account verification. Commit and push the reviewed slice.

## Implementation review decisions

The official connector replaces the local package and board mirror together.
TickTick remains the planning authority; unrelated Raven tasks remain available
when this optional connector is unconfigured. Explicit integration work is blocked
without its credentials. No legacy runtime data migration is introduced.

Provider echoes of resolved MCP secrets are scrubbed from successful callbacks,
raw SDK JSON, events, transcripts and run results as well as diagnostics. Static
configuration is distinct from read-only connection/authentication/tool evidence.
Missing expected or empty tool catalogs fail readiness; network errors do not
claim the token was rejected.

Existing TickTick consumers use strict bounded workload and mutation envelopes.
Partial or conflicting recommendations cannot trigger a valid-looking subset of
changes. The verification envelope is an agent report, not an independent audit
of the provider. Live schema and account behavior remain an operator canary.
Telegram task buttons receive a terminal result, with abort/restart guards.
Email unknown outcomes are not blindly retried; durable restart reconciliation
is explicitly tracked in the deferred ledger.

See [review and verification evidence](p0-official-ticktick-review.md).

## Completion evidence

- Full default suite: 266 files, 2,671 tests passed, no skips. Retired local-adapter
  tests and its separate live-test command are removed with that adapter.
- Required `npm run check` passed, including TypeScript, formatting, lint,
  dependency override verification and 268 production strip-types checks.
- Production shared/core/web build passed; packaged-core smoke passed two clean
  process exits, HTTP/chat, persisted definitions/memory/history and explicit resume.
- All 25 isolated browser journeys passed, including mobile MCP authentication
  failure/recovery, tool count and stable diagnostic rows. Two old fixtures were
  corrected to select the global agent explicitly once project agents were added.
- Deployment/real-Git installer suite: 18 passed. Launcher/token setup: 22 passed.
  Library and project validators passed. No owner account was used.
- Review defects were repaired before this checkpoint. Durable email creation
  reconciliation remains a concrete follow-up in the deferred ledger.

Docker is unavailable in this runner. Container startup and live TickTick account
authentication remain operator verification after deliberate token setup, not
claims established by these fake-provider tests.
