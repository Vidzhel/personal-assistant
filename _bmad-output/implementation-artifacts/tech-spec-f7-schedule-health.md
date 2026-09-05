---
title: Ordinary schedule health through the existing engine
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Contract

Extend CronerScheduleEngine and the existing deterministic self-test. Detect current
enabled ordinary schedules that never fire, stop firing, fail, or cannot register.
Do not create another scheduler or require legacy data migration. Preserve the
weekly canary's additional task-tree completion checks.

The engine exposes `getHealth(): ScheduleHealth[]`, where ScheduleHealth extends
ScheduleInfo with `active: boolean`, `activatedAt: number | null` and
`inFlightSince: number | null`, and `activationId: string | null`. Activation is the current process start, a newly
added/materially changed definition, or an enable transition. Preserve it across
unchanged registry reloads. Each activation receives a UUID; fire admission captures
it in the existing `schedule_fires.activation_id` column. Health reads only current
activation records and in-flight calls, so an old definition finishing after reload
cannot make its replacement look healthy. Add this column to the fresh schema;
no runtime migration is needed. Track every cron/manual invocation by promise/name and
start timestamp before its handler executes; self-test must see its own invocation.
Stop closes manual/cron admission and drains admitted fires before returning.
Reload or enable changes while stopped do not restart jobs; start deliberately
reopens the engine. Enable overrides must work in memory even without SQLite prefs.
An optional `now()` clock is a test seam, not another time source in production.

Self-test uses current effective definitions and latest fire-log rows. A five-minute
activation grace and one-minute fire completion grace apply to absence/staleness.
Croner's installed `previousRuns(1, reference)` computes the most recent expected
window in each schedule's timezone, using now minus completion grace. Do not
expect runs predating activation. A current in-flight invocation gets up to one
hour; an older invocation is reported stuck, so it cannot hide a broken schedule
forever. Disabled/removed definitions are excluded from ordinary status checks.
Enabled definitions with missing handlers or invalid/unscheduled cron entries get
a clear registration/activation violation. Use stable messages so persistent
violations do not generate a new alert just because time advances.

Fire rows timestamp terminal completion, not provider side effects or task-tree
completion. A successful manual trigger can satisfy the current freshness window.
A template's `fired` row proves dispatch; the existing weekly canary additionally
checks its task tree. Do not infer execution completion from every template fire.
Rows from before current activation cannot prove the current definition fired.
Scanner-rejected malformed files are outside the engine's accepted definitions;
record this limitation and address definition reporting with F9 registry cleanup.

## Verification

Use real temporary SQLite and Croner with deterministic timestamps to cover never
fired, stale success, current success/failure, grace boundaries, disabled/removed,
recent/stuck in-flight and timezone/DST. Engine tests must cover unchanged/changed
reload, new/reenabled definitions, memory overrides without prefs, manual admission
before handler invocation, concurrent fires, stop draining and refusal after stop.
Extend the composed self-test HTTP journey to assert its own fire does not report
as missing. Required checks, full default suite, core build, browser and packaged
restart precede review/commit/push. No live accounts or owner data.

Croner's [documented DST behavior](https://croner.56k.guru/usage/pattern/) describes
skipping nonexistent times and using the first occurrence of overlapping times.
The installed 10.0.1 runtime uses that overlap behavior, but both `nextRuns` and
`previousRuns` move New York's 2026-03-08 02:30 gap occurrence to 03:30 instead of
skipping it. Parent tests follow actual forward/backward runtime behavior; this
is a recorded dependency discrepancy to recheck on upgrade. During that gap,
`previousRuns` can return a mapped instant later than its reference. Health refuses
to call that future instant overdue; freshness is evaluated once its completion
grace expires. There is no second calendar implementation.

Parent shutdown review also found scheduled knowledge work could block schedule
drain before its processor received abort. Raven now stops consolidation and
knowledge retrospective processors in its early cancellation phase, while shared
graph/store disposal remains after task/MCP/HTTP drains. Service shutdown also
begins before schedule drain; maintenance owns an abort-aware local wait around
held gathering/knowledge refresh, with late results observed but unable to publish.


The composed HTTP cancellation test also exposed a connection retained after an
admitted response completed during shutdown. The API marks such HTTP/1 responses
with `Connection: close`, preserving their response while allowing shutdown to
finish. The test holds an uncooperative fake provider until after graph/SQLite
close, verifies blocked fire and unknown budget state before graph disposal, and
rejects late graph or durable-state mutations.

## Review result

Parent review and verification passed: required `npm run check`; 211 default test
files / 2,200 passed tests and six explicit live skips; fresh core build; fourteen
isolated browser journeys; packaged core verification with two clean process
exits. The original 87 project/library definition files retain their hashes.

The current engine and existing fire log remain authoritative for scheduling.
Invalid files rejected before engine registration are explicitly assigned to F9,
along with the registered integration-service lifecycle fixes in the deferred
ledger. Neither limitation is represented as a passing schedule check.
