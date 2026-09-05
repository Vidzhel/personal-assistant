---
title: Shared daily budget for Raven model execution
type: fix
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Contract

Enforce the existing daily USD setting at Raven's shared Claude backend boundary.
Every managed query, including direct heartbeat and learning calls, uses the same
operational SQLite budget store. Do not add another scheduler or execution
engine. YAML run history remains unchanged. No legacy runtime migration is
required; add the table to the fresh schema and reconcile obsolete schema in F9.

The budget measures the SDK's estimated query cost, including its nested agents.
It is not the owner's subscription bill or a hard provider billing ceiling.
The SDK checks its estimate between work steps; one request can cross the cap.
Gemini transcription and arbitrary external commands/tools are outside this
Claude-query accounting contract; do not advertise a cross-provider billing cap.

The installed SDK declares `maxBudgetUsd`, `total_cost_usd`, and per-model
`modelUsage.costUSD`. Both cost fields include query-pipeline subagents; `usage`
is main-loop-only. Prefer validated per-model totals; keep the latest cumulative
result for a query rather than summing repeated results. Resumed calls start new
query totals. Missing/invalid cost and crash results with zeroed usage are unknown.

Primary reference: [Anthropic SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
Use that reference together with the installed SDK declarations. The SDK estimate
can drift from billing and excludes helpers outside its query pipeline.

## Minimal implementation

- `model-budget.ts`: a synchronous store using the existing SQLite connection.
  Store integer micro-USD values, query/task correlation, model, configured local
  date/timezone, reservation, actual estimate, status, reason and timestamps.
  Aggregate reserved, known and unknown costs atomically before admission.
  Use SQLite immediate transactions; no await inside transactions.
- Expose `reserve({taskId, model}) -> {id, maxBudgetUsd} | undefined`,
  `settle(id, {costUsd?, reason?})`, `releaseBeforeStart(id)`,
  `recoverInterrupted()` and `getSummary()`.
  Missing cost settles unknown and consumes the full reservation. Actual usage
  can exceed a reservation and must be recorded honestly. Repeated settlement
  must not erase unknown or already settled records. A cancelled-before-start
  lease consumes zero. Recovery marks remaining reserved rows unknown and never
  refunds them. A query stays charged to its admission date through rollover.
- A query's ceiling is the smaller of daily limit / max(2, concurrency + 1)
  and half of currently available budget, rounded down to micro-USD. This retains
  admission headroom while a parent query is waiting inside `complete_task` for
  an evaluator. Exhaustion rejects promptly with a clear budget result; never
  wait indefinitely for another query's lease. Zero daily budget permits no query.
- `createBudgetedBackend({backend, budget})` reserves immediately before actual
  dispatch and owns the existing cancellable backend wait. It passes the lease's
  `maxBudgetUsd` to the SDK, settles synchronously before returning and observes
  abandoned late promises without late ledger writes. Pre-aborted calls consume
  nothing; post-dispatch cancellation without reliable usage stays unknown.
- `initializeBackend` / `setActiveBackend` install a single shared wrapped
  backend. Standalone unit-test injection without a budget still owns the same
  cancellation behavior. Composition constructs the budget after opening SQLite,
  recovers interrupted leases, and installs the budgeted wrapper for real and
  injected backends. Remove the redundant outer cancellable wait from
  `runAgentTask`; it continues to drain admitted MCP handlers in its finally.
  Add task correlation to backend options. Permission rejection occurs before
  this boundary and consumes no budget.
- SDK result parsing preserves estimated usage on error results and cooperative
  cancellation. Invalid or absent usage is never silently converted to zero.
  SDK iteration errors must preserve a previously observed trustworthy result's
  cost while reporting failure. Tests and browser/compiled fake backends report
  their deliberately simulated zero cost explicitly.
- Expose a read-only aggregate budget endpoint through the current API so the
  owner can distinguish known estimates, outstanding reservations and unknown
  usage. Validate finite nonnegative daily limits and valid timezone/concurrency
  at configuration boundaries. Document actual scope and blocked behavior.

## Verification

Test concurrent reservations with real temporary SQLite; known/unknown settlement,
pre-dispatch release, exhausted/zero limits, idempotence, process restart and local
calendar rollover. Verify SDK cap forwarding and cost accounting across nested
model usage, result failures, invalid payloads and cancellation. Exercise the
shared boundary from Manager and direct heartbeat/learning paths, plus the real
worker/evaluator task flow at concurrency one. Full default/check/core build,
compiled restart and isolated browser journeys precede parent review, commit/push.

## Reviewed implementation and evidence

The shared backend boundary and read-only budget API are wired through Raven's
composition root for injected and SDK backends. Knowledge consolidation now passes
its lifecycle signal and refuses failed model output before graph mutations. Its
existing graph-only merge/prune/digest implementation is explicitly assigned to
F9 in the deferred ledger; F6 does not claim to repair that file-authority gap.

Parent review corrected zeroed crash usage and invalid later cumulative results,
verified settlement precedes shutdown/database disposal, and removed redundant
wrapper type casts. The worker/evaluator regression now explicitly configures
concurrency one and proves the evaluator enters while the worker awaits its MCP
completion call. Heartbeat and chat→retrospective→memory consolidation share the
same ledger. Composed restart verifies known/unknown costs persist and late
abandoned results cannot mutate the reopened store. Two SQLite connections,
actual usage overshoot, non-UTC rollover and DST have deterministic coverage.

- Required `npm run check`: passed (`/tmp/raven-f6-check-verified.log`).
- Full default suite: 207 files / 2,176 passed, six deliberate live skips
  (`/tmp/raven-f6-full-verified.log`). Real SDK subprocess tests passed in this
  escalated isolated run; restricted-shell spawn failures are not counted as
  evidence of SDK failure or success.
- Core build: passed (`/tmp/raven-f6-core-build.log`).
- Browser: fourteen journeys passed (`/tmp/raven-f6-browser.log`).
- Packaged core: HTTP/chat and two fresh-process exits passed
  (`/tmp/raven-f6-compiled.log`).
- All 87 original project/library definition files retain their prior hashes;
  unrelated IDE files, owner project folders and `next-env.d.ts` are preserved.

There were no live provider calls. Query estimates and SDK caps do not establish
actual account charges, remote cancellation or a strict external spending cap.
