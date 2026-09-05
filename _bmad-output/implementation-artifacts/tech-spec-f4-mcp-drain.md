---
title: Drain admitted local MCP calls
type: fix
created: '2026-09-05'
status: planned
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
