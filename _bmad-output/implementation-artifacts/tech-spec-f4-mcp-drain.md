---
title: Drain admitted local MCP calls
type: fix
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Intent

After F3, complete the existing task cancellation lifetime by draining admitted
in-process MCP handlers before terminal task persistence and store shutdown.
The current guard rejects new calls and hides late results, while a handler
already running may still mutate storage after the backend abort race settles.

## Implementation

Use a small per-task admission tracker beside `mcp-server/guard-tool.ts`. Enter
synchronously before a handler starts, reject after admission closes, and release
in `finally` for both success and failure. Share that exact tracker between the
Raven and memory MCP servers created by one `runAgentTask` invocation. Close its
admission on abort and on backend completion; await all admitted calls in the
outer task cleanup before returning to AgentManager. Direct `runAgentTask`
callers receive the same protection. An abandoned backend remains observed and
its later tool requests must not be admitted after a normal or cancelled return.

Preserve handler-specific atomic commit/rollback behavior. Cancellation does not
roll back a mutation that already committed. Do not invent a timeout that closes
stores while a handler still owns them, or claim that remote provider work has
stopped. Release abort listeners and tracker references at the end of the task.

The tracker is per agent task, never global: `complete_task` may await a validation
agent with its own MCP lifetime. Preserve AgentManager's validator admission
headroom so `maxConcurrent=1` cannot deadlock a parent waiting for its validator.
Do not add a new execution engine or change capability/role filtering.

## Acceptance

Use held Raven and memory handlers to prove drain waits, new calls are refused,
errors release admission, and store mutations finish before a task returns. A
composed fake-backend/AgentManager shutdown test must hold a real local mutation,
abort the task, verify shutdown remains pending and resources remain usable, then
release it and verify one truthful terminal event and no post-stop writes.
Exercise normal backend completion with an outstanding handler as well as abort.
Retain uncooperative-backend cancellation coverage and add a single-concurrency
tree completion/validator regression. Run required checks and the full default
suite before parent review, commit and push.

## Reviewed result and evidence

The small per-task tracker closes admission synchronously, releases each admitted
handler in `finally`, and waits for every release. Raven and memory MCP servers
share that tracker. `runAgentTask` closes it on abort/backend settlement, suppresses
late SDK callbacks and permission results, drains before return, and removes its
abort listener. An abort during drain still yields cancellation. Already committed
mutations are retained; a stuck handler keeps its task and stores open rather
than triggering unsafe disposal.

The SDK availability tests now keep their fake query open while exercising real
MCP clients; invoking tools after the task ended is correctly refused. New tests
hold Raven and memory handlers independently, exercise exceptions, verify an
uncooperative backend's late callbacks, and use real MCP transports around a held
physical memory write. Composed shutdown retains DB access and withholds terminal
YAML/events until that write commits. The concurrency-one regression creates a
real tree through MCP, completes the worker through MCP, and observes evaluator
completion before worker completion without deadlock.

- Full default suite: 199 files, 2,105 passed, six explicit live TickTick skips
  (`/tmp/raven-f4-full.log`).
- Required checks: `/tmp/raven-f4-check-final.log`. The new composed test's unknown
  MCP response was narrowed with Zod after the first typecheck identified it;
  the final seven session/composed tests passed (`/tmp/raven-f4-reviewed-final.log`).
- Core production build: `/tmp/raven-f4-build-core.log`; packaged restart:
  `/tmp/raven-f4-compiled.log` (two clean process exits and persisted history).
- Fourteen browser journeys passed (`/tmp/raven-f4-browser.log`).
- All 87 captured definition-file hashes remain unchanged. Owner IDE/project
  folders and next-env bytes are preserved and excluded from the checkpoint.

This protects admitted in-process MCP handlers and task-owned callbacks. It does
not claim rollback or confirmed termination of remote provider work, external MCP
processes or SDK subprocess filesystem operations. Future graph/file interruption
recovery remains F5; provider upload cleanup remains F8.
