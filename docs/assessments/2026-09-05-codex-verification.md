# Codex setup and review verification

September 5, 2026. Baseline: `e7e0ed5` plus the owner's existing working tree.

This is the **initial migration/baseline record**, retained for its evidence and
the graph-contact incident below. The current result is in the
[reliability completion assessment](2026-09-05-reliability-completion.md) and
[current queue](../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md).
R0–R5 subsequently passed production builds, isolated browser journeys, compiled
and Docker restart checks, and a disposable Neo4j regression. Those later results
supersede the initial blocked/not-run entries below.

R6 makes AGENTS.md the shared guide and reconciles CLAUDE.md with it. All Claude
skills/settings are preserved. The two migrated browser skills have been used
for actual headless CLI inspection; the optional browser-tester TOML has static
validation only and was not invoked as a custom role. The CLI reports version
0.153.4; its local installation contains a standalone binary, so artifact paths
and schema were also checked against the linked official documentation below.

## Initial changes made

- Added `AGENTS.md` with current architecture rules, commands, scope boundaries,
  and links to the assessment. It is a real file, not a temporary-path symlink.
- Preserved the 64 existing BMAD skills in `.agents/skills/`. Migrated the two
  missing browser skills and the nested Claude browser agent, correcting paths,
  Claude-specific delegation syntax, stale examples, and shared-browser cleanup.
- Preserved `CLAUDE.md`, `.claude/`, and local Claude settings. No project-level
  development MCP configuration or hooks existed to port; runtime `library/mcps`
  definitions were not imported as development tools. No model or global Codex
  settings were changed.
- Updated `README.md` and `ARCHITECTURE.md`, and wrote the assessment and proposed
  repository/memory design. No external project was attached or changed.
- Isolated Neo4j in default tests with `__tests__/setup/neo4j-guard.ts`, registered
  only by core's default Vitest project. Updated the boot test's explanation to
  describe this boundary honestly. The opt-in Neo4j suite remains separate.

Codex discovers repository instructions through `AGENTS.md` and skills through
`.agents/skills`, as described in the official
[instruction guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [skill guide](https://learn.chatgpt.com/docs/build-skills). The browser agent
uses the project TOML format documented for
[custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Initial migration report

| Status | Item | Notes |
| --- | --- | --- |
| `Check before using` | `Skill` browser-testing | Converted for Codex; Claude tool restrictions are guidance, not sandbox permissions. |
| `Check before using` | `Skill` playwright-cli | Converted for Codex; active sandbox permissions still apply. |
| `Check before using` | `Subagent` browser-tester | Added as a Codex agent; reads the browser skills explicitly and inherits active permissions. |

The migrator was scanned/planned/diagnosed before writing. A selected temporary
source tree contained only the missing skills, a flattened copy of the nested
agent (the scanner otherwise missed it), and Claude instructions. Generation ran
in `/tmp`, followed by manual adaptation and installation of the reviewed files.
Python 3.10 lacked `tomllib`; a temporary wrapper supplied pip's bundled TOML
parser without changing the installed skill or Python environment.

Target validation passes for all 66 project skills, the agent TOML, and the
5.2 KB root instruction file. The validator notes that `.codex/config.toml` is
absent; no config is needed for these artifacts. A final source dry-run still
reports the original Claude metadata differences and would overwrite the manual
adaptations. Do not blindly rerun it over the reviewed target. Browser helper
scripts pass `bash -n`; no interactive browser journey was run during this review.

## Initial verification results

| Check | Result |
| --- | --- |
| `npm run check` after changes | Passed: source formatting, lint, shared/core type checks, strip-types compatibility. |
| `npm test -- --maxWorkers=2` with local socket access, after isolation fix | Passed: 155 files; 1,713 tests passed, six skipped, zero failures. |
| `npm run validate:library` | Passed. |
| `npm run validate:projects` | Passed. |
| Shared/core builds in `npm run build` | Passed. |
| Web production build | Blocked: Turbopack failed creating a process/binding a port with `Operation not permitted`, including the escalated retry. No successful production web build is claimed. |
| Codex target validation | Passed; no required model/MCP configuration. |
| Browser helper syntax and changed test formatting | Passed. |
| Live knowledge/testcontainers, Docker build/deploy, authenticated model, Telegram, browser journeys | Not run. Docker has independently identified stale paths; see the assessment. |

The initial restricted suite had local-port failures and one SDK subprocess
assertion failure. With socket access, the subprocess test passed but full
concurrency produced seven timeout failures and three logger shutdown errors.
Reducing to two workers isolated a single real test assumption failure: the boot
test expected Neo4j to be absent. After the test-isolation fix, the complete suite
passed with two workers. The unrestricted/default-concurrency command was not
rerun after that passing result; no permanent worker-limit change was made.

## Local graph contact during verification

Before the isolation fix, tests reached the running Neo4j at the default local
address using literal connection settings from their test configurations. Logs
show successful schema setup and project synchronization, and the boot test's
knowledge status was `ok` rather than `unavailable`. The existing environment
credential guard did not prevent these code-supplied settings.

These runs reached the successful knowledge startup path. The subsequent R3
reliability audit established that its `reindexAll()` implementation executed
`MATCH (b:Bubble) DETACH DELETE b` before rebuilding files. Therefore the earlier
statement that no graph records were deleted was not supported: the startup
issued a deletion query that could remove existing bubbles and their relationships.
No pre-run graph snapshot exists from this review, so the affected contents and
exact delta cannot be established. No manual cleanup or restoration has been
attempted; ownership cannot safely be inferred. The default-suite boundary now
stops connections before any graph request. The R3 implementation replaces
destructive routine reindexing with relationship-preserving updates. A separately
opt-in disposable Neo4j regression passed 30 tests, including retained relationships
and rejection of stale file identity claims. Final verification and review status
belong in the reliability completion record, not this earlier baseline.

## Existing work preserved

The initial working tree contained a changed `packages/web/next-env.d.ts`, three
untracked `.idea` files, and untracked `projects/tasks-manager/` and
`projects/telegram-default/`. These were not selected for this task. No commit or
push was made during that initial review. The owner subsequently requested
commits and pushes throughout the reliability work; those checkpoints are in
the current completion record. The proposal does not modify `../disertation`
or `../teaching`.
