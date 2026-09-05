---
title: Direct project workspace execution
status: complete
baseline: 45eb76e
date: 2026-09-06
---

# Direct project workspace execution

Ordinary project tasks must run in the selected attached repository, or the
managed project home when no source is selected. Extend AgentManager and the
existing Claude Agent SDK backend. Auxiliary learning and validators do not
inherit a project's autonomous native execution grant.

## Contract

- Resolve current project identity, workspace configuration, visible named-agent
  revision and canonical directory identities at admission. Preserve this revision
  while queued. Reject changed or unavailable grants before backend invocation,
  before tools, and before recording successful completion or resumable lineage.
- `default` retains Raven's native-tool access policy; `auto` uses SDK `auto` and
  `full` uses `bypassPermissions` with its required dangerous-skip flag. Auto/full
  authorize native shell/file work. Full is trusted host execution, not a path
  sandbox. Integration permissions and Raven MCP role boundaries remain enforced.
- PreToolUse checks run even when SDK permission callbacks are skipped. Avoid
  duplicate integration approvals/audits when the normal callback follows a hook.
- Attached cwd loads SDK project/local settings, instructions, skills and hooks.
  Managed homes explicitly disable filesystem settings to avoid inheriting Raven's
  development configuration. Strict MCP configuration applies even with no servers.
- Additional directories comprise the managed home and other attached folders.
  Missing/replaced granted directories fail explicitly; source metadata remains
  editable through the configuration API. Ordinary work-file and memory edits do
  not change the execution grant.
- Persist a resume revision with the SDK session ID in the initial operational
  schema. Reuse only an exact workspace/agent/capability match; changed context
  starts cold. No legacy migration or fallback lineage.
- Revocation is checked at local dispatch/tool boundaries. Already executing
  commands or remote operations may finish; this is not an OS isolation boundary
  or rollback mechanism.

## Verification

- Real temporary definitions and folders: cwd/default/auto/full, additional roots,
  local agent revisions, malformed configuration, missing/replaced directories.
- Queue/running tasks: changed grants block dispatch/tools and resume linkage;
  cancellation closes tool admission; normal workspace edits remain usable.
- Integration red-tier permissions survive full mode, including nested calls;
  hook and callback do not duplicate side effects.
- Fake SDK executable validates option transport without owner credentials.
  Composed fake-provider execution runs an actual command, writes files, commits
  and pushes to a temporary bare Git remote; restart verifies cold/matching resume.
- Required check, default tests, production core build and compiled restart smoke.
  Browser artifact acceptance and final container/graph verification remain W1d/e.

## Review and evidence

Parent review fixed cwd identity omission, stable project-ID/path collisions,
removed ancestor metadata, missing library-root reloads and auxiliary permission
fallback. Capability revisions cover bound skills/MCP definitions; creating an
unrelated skill and reloading the library remains a successful normal workflow.
Changed bound agent settings now reject queued dispatch before budget reservation.
The initial regression run exposed old expectations for queued settings and the
unrelated-skill invalidation bug; both are corrected and retested.

SDK behavior was checked against installed 0.3.224 declarations and official
[permission](https://code.claude.com/docs/en/agent-sdk/permissions) and
[configuration](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
documentation. Tests use local fake executable/provider boundaries, never owner
model credentials. Verification:

- Required `npm run check`: passed (`/tmp/raven-w1b-execution-check-final.log`).
- Default regression: 237 files, 2,431 passed, six explicit live skips
  (`/tmp/raven-w1b-execution-full-final.log`).
- Three composed workspace journeys include actual temporary shell/file/Git push,
  restart/resume, stale-tool/session rejection and integration approval enforcement;
  final focused assertions passed (`/tmp/raven-w1b-execution-final-focused.log`).
- Nine real SDK fake-executable contract tests passed, including cwd, settings,
  additional directories, auto/full flags and disabled automatic memory.
  Restricted standalone probes were inconclusive; root escalated verification
  passed without changing the fixture protocol (`/tmp/raven-sdk-contract-final.log`).
- Fresh production shared/core build and compiled restart smoke passed, with two
  clean exits (`/tmp/raven-w1b-execution-build-core-final.log`,
  `/tmp/raven-w1b-execution-compiled.log`).
- Browser regression: all 17 journeys passed (`/tmp/raven-w1b-execution-browser.log`).
- Preserved all 87 baseline source definitions except the previously authorized
  F9b maintenance-template change, and preserved owner next-env bytes.

W1c next: current repository overview/index links and shared file skills, flexible
managed layouts. W1d delivers browser attachment controls, file/artifact previews
and explicit graph project filtering. W1e repeats deployment/container/graph checks
against the completed workspace feature. No live model quality or account delivery
is claimed by fake-provider tests.
