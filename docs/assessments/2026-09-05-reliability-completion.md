# Raven reliability completion — September 5, 2026

The reliability pass is complete through R7: implementation, review, dependency
fixes, shared Claude/Codex guidance and final regression. Remaining issues have
explicit resolution plans below. The [current queue and detailed evidence](../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
is authoritative. Old March/August checkboxes are historical, and attached
repositories/project-memory redesign remain deferred at the owner's request.

## Architecture assessment

Raven's direction fits its philosophy: one owner's assistant, a small runtime
around the Claude Agent SDK, explicit capability grants, visible approvals,
file-based definitions and learning artifacts, and runtime-owned task outcomes.
The retired suite, pipeline, CLI-backend and custom compaction paths should stay
removed. The next useful work is to strengthen existing storage and cancellation
boundaries, rather than add another orchestration system.

Managed project identity/settings now persist in context.md and survive restart;
human context is preserved. SQLite still owns operational state such as tasks,
approvals and sessions. Legacy plain project definitions retain some metadata
in SQLite until a controlled migration or managed update. Therefore the database
is not disposable. Knowledge markdown owns content, while Neo4j contains durable
links, memberships and lifecycle metadata that cannot all be recovered from
files. Routine reindex now preserves these. Graph replacement needs a separate
export/restore and reader-migration plan.

Skills are explicit bindings: an empty list grants no capability-library bindings, missing
bindings fail before a turn starts, and unavailable knowledge tools are omitted.
Project/session ownership is enforced at HTTP, WebSocket and orchestration entry
points. These are useful boundaries for a single-owner assistant; they do not
establish a multi-tenant security model or repository filesystem sandbox.

Agent memory remains scoped by agent name under projects/agents. Existing data
sources are metadata, not repository mounts or an automatic retrieval system.
The global graph view still selects an implicit first project for chat. Project
selection, retrieval grants and project-owned memory should be resolved together
when the owner returns to workspace design. Neither ../disertation nor
../teaching has been attached or changed.

## Completed behavior

| Area                              | Result                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ownership and persistence | Foreign sessions/sources are rejected; managed settings persist; empty projects archive; known SQLite references and available graph memberships prevent deletion.               |
| Chat and dashboard                | Durable send acknowledgment, recoverable drafts, session switching, reconnect reconciliation, usable nested IDs, truthful failure/cancel/approval outcomes, and real graph chat. |
| Learning and background work      | Failed/partial consolidation retains candidates; local learning writes drain; service/task shutdown suppresses late callbacks and new work.                                      |
| Capabilities and knowledge        | Explicit grants and role-scoped tools; graph truly optional; relationship-preserving reindex and guarded disposal.                                                               |
| Build and deployment              | Packaged migrations, standalone dashboard, persistent definition/memory/Git roots, recoverable seed initialization, tested compiled and container restarts.                      |
| Development agents                | Shared AGENTS.md, reconciled Claude entry, preserved Claude skills/settings, Codex browser skills and optional custom agent. Raven's runtime provider is unchanged.              |

When Neo4j is unavailable, an otherwise empty project can archive while reporting
`knowledgeReferencesChecked: false`. Its graph memberships were not checked; the
archive outcome does not establish their absence.

## Verification and limits

Final verification used Node 22.23.2/npm 10.9.8 on the R6 code and lockfile:

| Check                                    | Result                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default suite                            | 184 files; 1,971 passed; six explicit live TickTick skips.                                                                                                 |
| Headless browser journeys                | All 11 passed; fixture files, processes and listeners cleaned up.                                                                                          |
| Required check and definition validators | Formatting, lint, types, strip-types, dependency guard, library and project validation passed.                                                             |
| Production builds                        | Shared/core, packaged 33 migrations, and standalone dashboard passed.                                                                                      |
| Compiled restart                         | Six real services, fake chat, persistent definitions/memory/Git history and two natural process exits passed.                                              |
| Deployment initializer                   | Nine real temporary Git/bootstrap/recovery tests passed.                                                                                                   |
| Fresh Docker images                      | Both built from the lockfile; 368 allowlisted context inputs; offline restart/page/static-asset smoke passed with no leftover smoke containers or volumes. |
| Native embedding dependency              | Core image loaded Transformers with Sharp 0.35.4/libvips 8.18.6 and passed synthetic image adapter checks without network.                                 |
| R6 real model and advisory checks        | Online and separate offline BGE fp32/384-value embedding checks passed in disposable storage; zero npm audit advisories.                                   |
| Earlier disposable Neo4j proof           | R3 passed 30 knowledge-store tests, including durable relationship preservation.                                                                           |

The final spec records commands and local log paths. The
[dependency review](2026-09-05-dependency-review.md) explains the scoped override
and its removal criteria. The Docker tags are local verification artifacts;
production was not deployed.

Default tests use temporary roots and fake model execution, and block real SDK
and Neo4j factories. Browser checks use their own services and temporary frontend
copy. These checks prove local behavior, not live Claude authentication or
account delivery. Reviews used existing independent agents and parent review;
fresh blind reviewer contexts were unavailable. No production deployment or
outbound owner-account message was performed.

The initial verification did contact the owner's local Neo4j before the R0 guard
was complete. Later review established that the old startup issued a destructive
reindex query. The exact affected data is unknown without a prior snapshot;
no restoration is claimed. The [incident record](2026-09-05-codex-verification.md#local-graph-contact-during-verification)
preserves the correction and the [resolution ledger](../../_bmad-output/implementation-artifacts/deferred-work.md)
requires comparison with a prior backup before any repair.

## Remaining work and proposed order

The [resolution ledger](../../_bmad-output/implementation-artifacts/deferred-work.md)
contains concrete file boundaries and verification requirements for each item.

1. Drain already admitted MCP mutations across cancellation/shutdown. Current
   guards reject new calls and suppress late success; an admitted handler can
   still finish its storage mutation. Add per-task tracking and commit-boundary
   tests using held file, SQLite and graph writes.
2. Add read-only reconciliation and explicit recovery for interrupted project
   file/SQLite and knowledge file/graph mutations. Back up first; never silently
   prune unmatched graph records. Export legacy project metadata before treating
   the project cache as rebuildable.
3. Refresh embeddings/chunks after external file edits using content hashes and
   retryable existing processors, preserving graph relationships.
4. Track provider file cleanup across cancellation/restart; local abort does not
   prove remote inference cancellation or uploaded-file deletion. Validate the
   retry path with a fake provider before an explicitly authorized live canary.
5. Enforce a real global daily budget and detect ordinary schedules that never
   fire or become stale. The old budget setting has no consumer, and current
   schedule status checks do not establish freshness. The ledger specifies
   existing SQLite/cron paths and concurrency, restart and fake-clock tests.
6. Resume the workspace proposal: explicit project selection, source grants,
   retrieval, structured project memory and a separately proven graph migration.

All original owner definition files and unrelated local changes are preserved
and excluded from task commits. Reviewed checkpoints are committed and pushed
to origin/master as requested; the current queue records their evidence.
