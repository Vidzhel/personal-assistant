---
title: 'Replace GWS MCP Wrapper with Direct CLI Execution'
slug: 'gws-direct-cli'
created: '2026-03-19'
status: 'done'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['gws CLI', 'Claude Agent SDK', 'TypeScript ESM']
files_to_modify:
  - suites/google-workspace/agents/gws-agent.ts
  - suites/google-workspace/suite.ts
  - suites/google-workspace/mcp.json
  - packages/shared/src/suites/constants.ts
  - packages/shared/src/suites/index.ts
  - packages/mcp-google-workspace/ (delete)
  - package.json
  - vitest.config.ts
  - eslint.config.ts
code_patterns: ['defineAgent with Bash tool', 'skill-reference prompt injection']
test_patterns: ['email-watcher tests unchanged', 'gws-exec tests removed']
---

# Tech-Spec: Replace GWS MCP Wrapper with Direct CLI Execution

**Created:** 2026-03-19

## Overview

### Problem Statement

The `packages/mcp-google-workspace/` MCP server wraps ~40 `gws` CLI commands as individual MCP tools with hardcoded Zod schemas. Code review found 5 CLI flag mismatches that would cause runtime failures, and the approach only exposes ~30% of the CLI's flexibility. Every CLI update requires manual schema updates across 8 tool files. Meanwhile, the gws-agent already has `Read` access to comprehensive skill reference docs — the MCP layer is pure overhead.

### Solution

Remove the MCP server package entirely. Give the gws-agent `Bash` tool access to run `gws` commands directly. The agent reads skill reference docs for command syntax, uses `--format json` for structured output, and sets `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var for multi-account support. This gives 100% CLI flexibility with zero hardcoded schemas.

### Scope

**In Scope:**
- Delete `packages/mcp-google-workspace/` package
- Update gws-agent to use Bash instead of MCP tools
- Update suite definition (remove mcp-server capability)
- Remove or empty `mcp.json`
- Remove MCP constants (`MCP_GWS_PRIMARY`, `MCP_GWS_MEET`)
- Clean up root configs (workspaces, vitest, eslint)
- Update productivity-coordinator prompt (minor — agent name unchanged)

**Out of Scope:**
- Email watcher service (stays as-is — it's a service, not MCP)
- Email watcher tests (unchanged)
- Skill reference docs (unchanged — now primary tool documentation)
- Action tiering (`actions.json` — unchanged)
- Other suites' MCP patterns (this is GWS-specific)

## Context for Development

### Codebase Patterns

- Suite loader (`suite-loader.ts:102`): `mcp.json` is optional — returns `{}` if missing
- `validateAgentMcpRefs()` checks agent `mcpServers` entries against `mcp.json` keys — no MCPs = no validation needed
- Agent `tools` array is `z.array(z.string())` — can include `'Bash'`, `'Read'`, `'Grep'`
- `defineAgent()` `mcpServers` field is optional — omit it entirely
- `buildMcpToolPattern()` generates `mcp__<key>__*` glob — no longer needed for GWS

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `suites/google-workspace/agents/gws-agent.ts` | Agent definition to rewrite |
| `suites/google-workspace/suite.ts` | Suite manifest — remove `mcp-server` capability |
| `suites/google-workspace/mcp.json` | Delete or empty |
| `packages/shared/src/suites/constants.ts` | Remove `MCP_GWS_PRIMARY`, `MCP_GWS_MEET` |
| `packages/shared/src/suites/index.ts` | Remove MCP constant exports |
| `packages/mcp-google-workspace/` | Entire package to delete |
| `package.json` | Remove workspace entry |
| `vitest.config.ts` | Remove test project entry |
| `eslint.config.ts` | Remove lint glob entries |
| `suites/google-workspace/skills-reference/` | Agent reads these for CLI syntax |

### Technical Decisions

1. **Bash over MCP**: The agent gets `Bash` tool, constructs `gws` commands from skill reference docs. No schemas to maintain.
2. **Multi-account via env var**: Agent sets `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` in Bash commands: `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/meet-creds.json gws meet ...`
3. **Delete mcp.json** (not empty it): Suite loader handles missing file gracefully. Cleaner than empty object.
4. **Keep gws-exec tests**: No — delete with the package. Email watcher tests stay.
5. **Agent prompt strategy**: Include condensed CLI reference + tell agent where to `Read` full docs.

## Implementation Plan

### Tasks

- [ ] Task 1: Delete MCP server package
  - [ ] Delete entire `packages/mcp-google-workspace/` directory
  - [ ] Remove `"packages/mcp-google-workspace"` from root `package.json` workspaces
  - [ ] Remove `packages/mcp-google-workspace/vitest.config.ts` entry from root `vitest.config.ts`
  - [ ] Remove `packages/mcp-google-workspace/src/**/*.ts` globs from `eslint.config.ts`
  - [ ] Run `npm install` to update lockfile

- [ ] Task 2: Remove MCP constants from shared
  - [ ] Remove `MCP_GWS_PRIMARY` and `MCP_GWS_MEET` from `packages/shared/src/suites/constants.ts`
  - [ ] Remove their exports from `packages/shared/src/suites/index.ts`
  - [ ] Rebuild shared: `npm run build -w packages/shared`

- [ ] Task 3: Update suite definition
  - [ ] Delete `suites/google-workspace/mcp.json`
  - [ ] Update `suites/google-workspace/suite.ts`: remove `'mcp-server'` from capabilities array

- [ ] Task 4: Rewrite gws-agent to use Bash + skill docs
  - [ ] Update `suites/google-workspace/agents/gws-agent.ts`:
    - Remove MCP imports (`buildMcpToolPattern`, `MCP_GWS_PRIMARY`, `MCP_GWS_MEET`)
    - Set `tools: ['Bash', 'Read', 'Grep']` (no MCP patterns)
    - Remove `mcpServers` field entirely
    - Rewrite prompt to explain direct CLI usage, multi-account env var pattern, and skill doc locations
  - [ ] Ensure prompt includes: CLI command syntax pattern, multi-account setup, `--format json` convention, reference to skills-reference/ docs

- [ ] Task 5: Verify and clean up
  - [ ] Run `npm run build` (shared + core)
  - [ ] Run `npm run check` (format + lint + tsc)
  - [ ] Run GWS email-watcher tests: `npx vitest run suites/google-workspace/__tests__/email-watcher.test.ts`
  - [ ] Run full test suite to confirm no regressions

### Acceptance Criteria

1. **Given** the MCP server package is removed, **when** `npm run build` runs, **then** it succeeds with no errors referencing `mcp-google-workspace`.

2. **Given** the gws-agent definition has `tools: ['Bash', 'Read', 'Grep']` and no `mcpServers`, **when** the suite loader loads `google-workspace`, **then** it loads successfully without MCP validation errors.

3. **Given** `mcp.json` is deleted, **when** the suite loader processes the google-workspace suite, **then** it returns empty MCP config and proceeds normally.

4. **Given** the gws-agent prompt explains CLI syntax and multi-account env var pattern, **when** the agent handles "What's on my calendar today?", **then** it can construct and execute `gws calendar +agenda --today --format json` via Bash.

5. **Given** the email watcher service is unchanged, **when** its tests run, **then** all 8 tests pass.

6. **Given** `npm run check` runs after all changes, **then** format, lint, and tsc all pass with 0 warnings.

## Additional Context

### Dependencies

- `@raven/shared` must rebuild before `@raven/core` (build order)
- No new dependencies introduced — this is purely a removal

### Testing Strategy

- Email watcher tests unchanged (8 tests)
- gws-exec tests deleted with the package (9 tests)
- Net test count change: -9
- Full suite run to confirm no regressions from constant removals

### Notes

- The `gws` CLI already has `--format json` on every command, `--help` for self-documentation, and `--dry-run` for safety
- The skill reference docs in `suites/google-workspace/skills-reference/` become the primary tool documentation
- Future CLI updates require zero code changes — the agent adapts by reading updated skill docs
- This pattern could be applied to other CLI-wrapper MCPs in the future
