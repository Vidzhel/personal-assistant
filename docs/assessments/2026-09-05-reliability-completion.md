# Raven reliability assessment — September 5–6, 2026

This document is the current assessment of the F1–F9 continuation work. The
[R0–R7 completion record](../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
remains the historical evidence for the earlier reliability checkpoint; it is
not a status report for F9. The [active continuation queue](../../_bmad-output/implementation-artifacts/file-first-completion-2026-09-05.md)
and its linked specifications record the detailed implementation evidence.

The owner confirmed that Raven has not been used and authorized discarding
legacy runtime data. No legacy export, migration or restoration path is being
built. New runtime state still receives interruption-safe handling because
unused historical data does not justify losing work created now. The owner
also authorized flexible repository workspaces after F1–F9; that work is W1 and
is now in progress in the [W1 specification](../../_bmad-output/implementation-artifacts/tech-spec-w1-project-workspaces.md).

## Current architecture

Raven remains a small runtime around the Claude Agent SDK for one owner. The
composition root wires the existing agent manager, services, scheduler,
permission checks, file-backed definitions and operational stores. Capability
bindings are explicit: `skills: []` grants no library capability, and missing
skill, MCP or vendor definitions fail dispatch before a model turn or tool
mutation. HTTP, WebSocket and orchestration entry points enforce current
project and session ownership.

Authoritative state now has clear boundaries:

- Project settings and identity come from `context.md` metadata. Agent,
  schedule and template definitions remain filesystem records.
- Board tasks, execution trees and agent runs use canonical YAML under the
  resolved project directory: `tasks/board/<id>.yaml`,
  `tasks/trees/<id>.yaml`, and `tasks/runs/<id>.yaml`. A projectless task uses
  the system project's physical directory.
- The F9 checkpoint verified a fresh 24-table operational schema for sessions,
  approvals, events, notifications, integrations, intents, model budgets,
  provider uploads and the project cache. Retired SQL task, run, tree and
  pipeline readers are removed. SQLite remains an operational store, not a
  source of project definition settings.
- Knowledge bodies are canonical Markdown files. Neo4j stores durable links,
  project membership and graph lifecycle metadata. Reindex and derived-index
  refresh preserve those relationships, but Markdown cannot recreate graph
  metadata after an unknown graph loss.

Cancellation closes admission and suppresses late callbacks across model,
service, file and graph paths. Already admitted mutations drain at their own
commit boundaries; cancellation does not roll back a committed write. Local
abort also cannot prove that an external Claude, provider or remote service
operation stopped.

## F1–F9 status

| Checkpoint                                                  | Current status and evidence                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — project-local task files and current project authority | Complete. Validated project-local board YAML, atomic persistence, current file-owned project identity/settings and inactive-project guards passed the F1 suite, required checks, core build, browser journeys and packaged restart. See [F1 specification](../../_bmad-output/implementation-artifacts/tech-spec-f1-project-task-files.md).                                            |
| F2 — execution trees and bounded validation                 | Complete. Whole trees and nodes persist in YAML, validation is fail-closed, and execution shutdown/restart interruption is covered. The reviewed F2 checkpoint passed its recorded default, browser, build and packaged restart checks. See [F2 specification](../../_bmad-output/implementation-artifacts/tech-spec-f2-execution-tree-files.md).                                      |
| F3 — agent-run files and direct history consumers           | Complete. Agent-run records and service/dashboard history queries use the execution logger; retired SQL task history consumers are removed. The reviewed checkpoint passed 2,092 tests and 14 browser journeys. See [F3 specification](../../_bmad-output/implementation-artifacts/tech-spec-f3-agent-run-files.md).                                                                   |
| F4 — admitted MCP mutation drain                            | Complete. Per-task Raven and memory MCP admission closes on abort/backend settlement, drains admitted handlers before terminal state, and refuses late callbacks. The reviewed checkpoint passed 2,105 tests and 14 browser journeys. See [F4 specification](../../_bmad-output/implementation-artifacts/tech-spec-f4-mcp-drain.md).                                                   |
| F5 — knowledge reconciliation and derived refresh           | Complete. Read-only reconciliation, recoverable Markdown mutations, durable deletion intents, revisioned embeddings/chunks and relationship-preserving graph updates are implemented. The reviewed checkpoint passed 2,138 default tests and 132 disposable Neo4j tests. See [F5 specification](../../_bmad-output/implementation-artifacts/tech-spec-f5-knowledge-reconciliation.md). |
| F6 — global model budget                                    | Complete. Existing execution paths share SQLite budget admission, model estimates, reservations, query caps and truthful unknown-cost handling. The reviewed checkpoint passed 2,176 tests and 14 browser journeys. See [F6 specification](../../_bmad-output/implementation-artifacts/tech-spec-f6-model-budget.md).                                                                  |
| F7 — schedule health and shutdown                           | Complete. Current activation IDs, cron absence/staleness checks, in-flight grace and scheduled-work cancellation are wired through the existing scheduler and self-test. The reviewed checkpoint passed 2,200 tests, 14 browser journeys and packaged restart checks. See [F7 specification](../../_bmad-output/implementation-artifacts/tech-spec-f7-schedule-health.md).             |
| F8 — provider upload cleanup                                | Complete. Upload ownership, remote IDs, bounded deletion retries, restart recovery and truthful unresolved reports use the existing maintenance path. The reviewed checkpoint passed 2,223 tests, 14 browser journeys and packaged restart checks. See [F8 specification](../../_bmad-output/implementation-artifacts/tech-spec-f8-provider-upload-cleanup.md).                        |
| F9a — fresh operational schema                              | Verified. The fresh schema retains the current operational tables and removes obsolete pipeline/task compatibility paths; fresh initialization and restart checks passed.                                                                                                                                                                                                              |
| F9b — dispatch, artifact and service contracts              | Verified. Current capability ownership, artifact requirements, named-agent settings and per-start autonomous service lifetimes passed 2,259 tests, 15 browser journeys, required checks, production builds and packaged restart.                                                                                                                                                       |
| F9c — canonical knowledge outcomes and recovery             | Verified in the previous checkpoint. File-owned ingestion, consolidation, cluster/hub outcomes, merge intents and explicit recovery passed 2,296 default tests, 148 disposable graph checks across the verified runs, 15 browser journeys, required checks, core build and packaged restart.                                                                                           |
| F9d — definition diagnostics and project recovery           | Verified and pushed as `b7d3b35`. Current definition diagnostics, cache-safe mutation journals, actual SIGKILL recovery and mobile correction passed 2,342 default tests, 16 browser journeys, required checks, production builds and packaged restart.                                                                                                                                |
| F9e — final review and verification                         | Complete. All 148 disposable Neo4j tests, nine deployment initializer tests, Compose/context validation, current image builds and offline persistence/static-asset/native-adapter checks pass. Current audit reports zero advisories. The F9d full, browser, build and compiled checks remain the verified code baseline.                                                              |

F9a–F9e evidence, limits and exact log paths are recorded in the [F9 storage
and runtime specification](../../_bmad-output/implementation-artifacts/tech-spec-f9-storage-runtime-cleanup.md).
F1–F9 are complete; W1 implementation is in progress.

## Reliability limits that remain explicit

Project mutation journals now detect interrupted create, update and archive
boundaries. Startup can complete a published mutation or cancel a mutation
that never published; a changed file remains a conflict for deliberate repair.
This is recovery for new journaled runtime work. It is not restoration of
discarded legacy state, and filesystem publication plus SQLite or graph changes
are not one cross-store transaction.

Knowledge recovery preserves source files, intents and graph evidence through
partial or unknown outcomes. It cannot infer deleted or changed graph
relationships from Markdown alone. A future graph replacement must move relationship ownership and switch readers
together, with behavioral parity tests. Legacy import remains waived.

The F6 budget is a local execution estimate and admission policy, not a
subscription billing guarantee. Gemini and arbitrary external commands remain
outside that budget. F8 records local knowledge of provider upload outcomes;
unknown remote IDs and local cancellation do not establish remote deletion or
inference cancellation. No live Claude, Gemini, TickTick or other account
canary was run, and no outbound owner message or production deployment was
performed.

Croner behavior is pinned by the installed dependency and tested through the
actual dispatch path, including timezone and DST cases. A future Croner
upgrade must rerun the gap/overlap checks together with schedule-health policy.

The initial R0–R7 verification contacted the owner's local Neo4j before the
graph guard was complete and the old startup issued a destructive reindex
query. The exact prior data delta is unknown because there was no pre-run
snapshot. The [incident record](2026-09-05-codex-verification.md#local-graph-contact-during-verification)
preserves that fact and its correction. The owner later confirmed Raven was
unused and waived legacy restoration, so this assessment makes no claim that
the prior graph state was restored.

## Remaining work and boundaries

All postponed F1–F9 improvements are complete. Remaining dependency/account
limits have explicit resolution criteria in the deferred ledger; they do not
stand in for missing local implementation or tests.

W1 is now in progress. Read-only inspection of the actual dissertation and teaching
repositories confirmed different, explicit agent workflows and repository-owned
scripts. Workspace configuration, local agent selection and project-owned memory
are implemented. The remaining plan implements flexible direct shell/file/Git
work, linked context indexes, reusable runtime skills and mobile artifact access. The agent may evolve each repository's scripts and structure
under the owner's configured autonomy. No private repository content is copied
into Raven's public source. No repository embedding pipeline or graph replacement
is required for this implementation.

The original definitions retain their recorded hashes except for the explicit
summary-only maintenance template change in F9b. Unrelated owner work is preserved.
The owner decision waiving legacy migration/restoration is retained here as a
scope decision, while new task, project, knowledge and provider records remain
subject to the current persistence and recovery contracts.

The September 6 W1b execution checkpoint extends the existing SDK runtime with
project cwd, default/auto/full modes and revision-checked grants/session resume.
Parent review narrowed capability invalidation to actual bindings so creating and
reloading unrelated skills remains useful. Actual temporary command/file/Git push
and restart tests complement the SDK subprocess option contract; 2,431 default
tests pass. Full native access is trusted host execution, while Raven integration
permissions remain enforced through pre-tool hooks. Repository overview links,
shared file skills, mobile artifacts and project-scoped graph views remain in
ordered W1c/d work; final deployment verification is W1e.
