---
title: Project-local agent run history
type: refactor
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Intent

After the reviewed F2 checkpoint, replace `agent_tasks` SQL persistence through
the existing execution logger. Store one validated YAML record per agent attempt
at `projects/<resolved-fsPath>/tasks/runs/<agentTaskId>.yaml`. Projectless work uses
the system project. No legacy import or parallel SQL projection is required.

## Implementation and review

- Preserve the logger's query, detail and statistics interfaces. Use shared
  project record resolution and atomic writes; validate identity, ownership,
  status, timestamps and terminal transitions. Keep tree/node attempt IDs when
  present. A queued cancellation must create a terminal record even when no
  start record exists. Repeated terminal callbacks cannot rewrite another run.
- Await admitted start/completion persistence in AgentManager before dispatch or
  terminal events. Coordinate writes with project mutations and drain them before
  shutdown; do not hide persistence failures in best-effort logging. Reuse the
  F2 mutation coordination where appropriate rather than adding a second queue.
- Validate existing files before services start. Mark interrupted running records
  as interrupted with a truthful outcome; never restart model work from history.
  Manual file changes must be visible to reads and protected from stale writes.
- Replace direct SQL consumers in dashboard counts, heartbeat activity and
  proactive-intelligence data collection. Inject the existing logger through
  composition/service dependencies. Remove the `agent_tasks` project-reference
  query when containing run files provide deletion protection.
- Internal aggregates must query every relevant record, independently of the
  bounded HTTP page. Define explicit date/project filters and deterministic
  ordering. Existing `/agent-tasks`, session debug, SSE, metrics, health and
  knowledge lookups continue to use the same logger.
- Audit direct `runAgentTask` calls separately: heartbeat and retrospectives
  currently bypass AgentManager history. Record their actual coverage; do not
  imply that manager records account for every model call. F6 must enforce the
  global budget at a shared execution boundary across both paths.

## Acceptance

Exercise start, success, failure, blocking, cancellation before start, duplicate
completion, process restart and shutdown during a held project mutation using
temporary files and a fake backend. Reject invalid YAML, duplicate/foreign IDs,
unsafe paths and stale updates without damaging the previous document. Verify
queries, pagination and aggregates with more than fifty records. Prove that run
files protect project deletion and that API/history survive a compiled process
restart without `agent_tasks` rows. Run the required check and full default suite
before parent review, commit and push. Retired schema cleanup remains F9.

## Reviewed implementation

The six-method execution logger now reads validated YAML through shared project
resolution. State validation rejects missing lifecycle timestamps, contradictory
blocked/interrupted flags, duplicate IDs and foreign locations. Start/completion
identity includes the original attempt timestamps. Completion requires a recorded
start except for cancellation before admission. Whole-file atomic replacement
preserves previous bytes on injected write/rename failures; external edits are
readable but cannot be overwritten by an earlier in-memory attempt.

AgentManager awaits both persistence boundaries, retains the concurrency slot and
active visibility while finalizing, and drains queued cancellation writes during
stop. Persistence failure emits a blocked/cancelled result and health alert with
an explicitly unresolved durable outcome. It does not retry an action or replace
conflicting bytes. Restart marks unfinalized records failed/interrupted and says
the prior execution outcome is unknown. A stuck admitted project mutation keeps
shutdown pending and stores open; no bounded-shutdown guarantee is claimed.

Dashboard, heartbeat and activity summaries use current run files. HTTP filters
are bounded; internal statistics query all matching records. SSE preserves blocked,
cancelled and interrupted outcomes, subscribes without an asynchronous gap after
reading history, and cleans listeners when the response closes. Tests wait for
established streams and terminal events instead of fixed timing assumptions.

These records cover AgentManager attempts only. Direct heartbeat, session
retrospective, memory consolidation and knowledge consolidation model calls still
bypass Manager history. F6 must enforce daily budgets below both call paths.
Approved-action redispatch still omits its session's project ID and therefore uses
the system folder; F9 now explicitly owns that correlation and capability-fallback
cleanup, with an approval HTTP/YAML regression in the deferred ledger.
No real provider execution, cancellation or account delivery is claimed.

## Verification

- Full default suite: 196 files, 2,092 passed, six explicit live TickTick skips
  (`/tmp/raven-f3-full-verified.log`). The first pass exposed a synchronous
  queued-cancellation assertion; the next hit bulk-fixture timeouts under parallel
  production builds. Tests now await terminal events and seed read-only query
  fixtures directly. The final complete suite passed.
- Required check: `/tmp/raven-f3-check-verified.log`; core production build:
  `/tmp/raven-f3-build-core.log`; web production build:
  `/tmp/raven-f3-build-web-final.log`. Web build ran outside the restricted sandbox
  for Next's compiler subprocess and restored the owner's next-env file bytes.
- Fourteen real browser journeys passed (`/tmp/raven-f3-browser-final.log`),
  including mobile interrupted-tree resume, draft retention and reconnect.
- Packaged restart verification passed (`/tmp/raven-f3-compiled-final.log`): two
  naturally exiting processes, HTTP/chat history, exact YAML run bytes retained,
  and zero rows in the retired run table.
- Library/project validators passed. All 87 previously captured definition-file
  hashes remain unchanged; unrelated IDE files and project folders are excluded.
