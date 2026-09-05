---
title: Project-local agent run history
type: refactor
created: '2026-09-05'
status: planned
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
