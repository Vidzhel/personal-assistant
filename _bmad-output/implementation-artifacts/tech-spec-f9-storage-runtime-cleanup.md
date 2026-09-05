---
title: Finish storage and runtime contracts before repository workspaces
created: '2026-09-05'
status: in-progress
execution_mode: plan-code-review
---

## Delivery order

F1–F8 are complete; F8 was pushed as cdc7276. Finish the following reviewable
subcheckpoints, testing and committing/pushing each before the next. These are
parts of the already authorized F9 cleanup, not a new feature program. W1 starts
after F9. Use existing stores, processors, job registry, dispatch and health
routes; remove each obsolete path when its replacement is complete.

1. **F9a: fresh operational schema.** Consolidate the 33 historical SQL scripts
   into one current schema. Remove obsolete SQL task/run/tree/pipeline/schedule
   and unused pending-config tables, old library/default preference seeds, and
   pipeline annotations from audit/approval contracts. Remove the proactive
   pipeline snapshot reader. Keep operational sessions, permissions, events,
   notifications, integrations, intents, model budgets, Gemini uploads and the
   project cache. Keep only required built-in seed rows. Delete legacy migration
   mapping and partial-ALTER success fallbacks; no old-data migration/export or
   restoration. Preserve fresh initialization, atomic failure and restart.
2. **F9b: dispatch and service contracts.** Resolve approved-action ownership from
   its trusted session and reject invalid configured capability bindings before
   admission. Respect validated named-agent model/max-turn settings in dispatch;
   reject unsupported values consistently. Make `requireArtifacts` mean that
   artifacts are required, and explicitly configure summary-only workflows.
   Registered autonomous/TickTick/proactive services release their jobs, own
   per-start admission/cancellation, and suppress post-stop writes/redispatch.
3. **F9c: canonical knowledge mutations and operation outcomes.** Consolidation
   reads current Markdown, validates all planned IDs/project scope before writes,
   uses shared file-owned merge/delete operations, and actually persists digests.
   Shared manual/consolidation merge preserves durable link properties and project
   memberships while regenerating derived data. Deletion intents prevent source
   resurrection after reindex. Failures/cancellation stay truthful and retain
   recoverable sources. Ingestion, clustering and hub routes expose correlated
   durable runs or awaited results rather than invented untracked task IDs.
4. **F9d: definition and project recovery diagnostics.** Preserve current scanner
   parse/validation diagnostics and surface rejected definitions through existing
   health/self-test; valid siblings still load and fixed diagnostics clear on
   reload. Detect interrupted project definition/archive/cache changes before
   discarding evidence, expose deterministic repair, and verify actual process
   interruption at mutation boundaries. This concerns new runtime interruption,
   not restoration of pre-use legacy data.
5. **F9e: final review and verification.** Reconcile current architecture, setup,
   assessment and developer instructions with the implementation. Run required
   checks, full default and disposable Neo4j tests, production builds, browser,
   packaged restart and isolated deployment/container checks. Document precise
   remaining external-account/dependency limits. Then review the actual teaching
   and dissertation repositories and implement W1's accepted flexible workspace
   contract.

## F9a acceptance

Fresh temporary SQLite contains only current tables/columns and required seed
rows. Current run/tree/board APIs continue reading project YAML; no retired
pipeline SQL reader remains. The schema installer rejects bad SQL atomically
and does not silently mark partial scripts applied. Restart preserves current
operational state and does not seed old skills/schedules/configuration. Update
fresh-schema expectations and stale test fixtures instead of retaining obsolete
production tables for tests. Required check and default suite must pass; fresh
core/package/browser checks verify the bundled schema actually initializes.
Preserve unrelated owner files and source definitions.

## F9a completion evidence

Fresh initialization now uses one atomic current schema, with 24 retained
operational tables and the required meta-project seed. Review compared retained
column types/defaults and foreign keys against a temporary reconstruction of the
previous committed schema; only the planned pipeline annotations were removed.
No existing owner database was opened or reset. Unsupported migration history
fails explicitly, duplicate-column failures roll back, and failed initialization
closes its candidate handle without exposing a half-initialized singleton.

Retired pipeline consumers and SQL task assertions were removed. Notification,
schedule and compiled fixtures now use the fresh-schema contract. The upload
cleanup fixture uses production WAL/foreign-key settings and atomic installation,
eliminating its parallel-load timeout without increasing the test timeout.

Parent-reviewed validation: required `npm run check`; 213 default test files /
2,225 passing tests (six explicit live skips); fresh core build packaging one
SQL asset; all 14 isolated browser journeys; compiled HTTP/chat and persisted
state across two clean process exits. All 87 original definition-file hashes
remain unchanged. Logs: `/tmp/raven-f9a-check-verified.log`,
`/tmp/raven-f9a-full-verified.log`, `/tmp/raven-f9a-build-core.log`,
`/tmp/raven-f9a-browser.log`, `/tmp/raven-f9a-compiled-verified.log`.

F9b completion is recorded below; F9 remains in progress. Final production web/container and disposable
Neo4j verification remains assigned to F9e after runtime/knowledge changes.

## F9b acceptance and review scope

F9a is pushed as `e1b42bd`. F9b is complete. Approved-action admission derives
Raven project ownership from the stored session and rejects unavailable projects,
sessions, skills, MCP definitions and vendor bindings before model/turn mutations.
Exact prior approval still prevents a second permission loop. HTTP and browser
responses distinguish saved approval from failed action execution; failed actions
remain in the audit log. Approved actions use global execution defaults because
approval rows do not identify an originating named agent.

Named-agent model tiers and turn limits must reach the queued task and the same
backend options used for budget reservation. YAML and API validation agree;
explicit named-agent selection must not change tiers merely because the global
model differs. Nullable API resets clear previous overrides. Heartbeat's explicit
turn limit and other deliberate internal overrides remain effective.

Artifact validation requires registered artifact metadata when configured.
Summary-only maintenance is explicit; completion prompts explain registering
metadata through `complete_task`. This does not certify a physical file's contents
or implement W1's browser artifact serving.

Autonomous management, TickTick sync and pattern analysis own job registrations,
per-start cancellation and local work. Stop releases registrations and local
waits; retained callbacks/late success or failure cannot write, notify or dispatch
through a restarted service. Scheduler outcomes must expose failure/cancellation.
TickTick's remote project IDs are not Raven project identity; without an explicit
mapping, imported tasks use system storage. Validate the entire fetched list before
local writes, and prevent duplicate imported IDs in a single response.
Parent composition review also found service startup preceding AgentManager
construction. Services now start after dependency/listener setup and register
jobs before cron starts. TaskStore/AgentManager are passed in service context;
their former process-global lookups are removed. A composed fake-provider test
executes both task services and verifies system YAML imports and repeated-sync
deduplication through the actual scheduler and task store.

Verify focused deferred-operation tests, real approval HTTP/YAML ownership,
browser failure presentation, required checks and the full default suite before
commit/push. No live external accounts are used.

## F9b completion evidence

Parent review caught and fixed task services starting before AgentManager existed,
partial autonomous failures being reported as successful schedule fires, stale
within-response TickTick completion snapshots, and malformed duplicate dispatches
potentially producing a false terminal result for an admitted run. Configuration
now validates effective global defaults as well as named-agent overrides; no
production fallback exists solely to accommodate unloaded test configuration.

Validation: required `npm run check`; 216 default files / 2,259 passing tests
(six explicit live skips); production core and dashboard builds; 15 isolated
browser journeys; and compiled HTTP/chat, persisted state and two clean process
exits. Composed tests exercise real approval HTTP/YAML ownership, queued model
settings versus hot edits, identical budget/backend model IDs, and both real task
services through the scheduler with fake provider results. Held-result tests cover
stop/restart and rejected callbacks. The only changed original definition is the
explicit summary-only maintenance template; the other 86 original hashes match.

Logs: `/tmp/raven-f9b-check-final.log`, `/tmp/raven-f9b-full-final.log`,
`/tmp/raven-f9b-build-core.log`, `/tmp/raven-f9b-build-web.log`,
`/tmp/raven-f9b-browser.log`, `/tmp/raven-f9b-compiled.log`.
F9c canonical knowledge mutations and truthful operation outcomes are next.

## Remaining constraints

Knowledge links/project membership remain Neo4j-owned through F9. Graph
replacement and project-owned memory belong to W1's workspace/context design.
No live account message or provider retention canary is included. Keep unknown
remote outcomes explicit. The pinned Croner DST documentation discrepancy stays
assigned to the next dependency review, with regression tests preserved.
