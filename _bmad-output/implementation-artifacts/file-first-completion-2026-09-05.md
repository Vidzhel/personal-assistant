# File-based state and remaining reliability work

Continuation after 0244248. The owner confirmed the application has not been used:
legacy runtime data and compatibility paths may be discarded; no export, migration
or restoration work is needed. Preserve source definitions and unrelated local
work unless a specific code change requires updating them. The owner selected
task files inside Raven projects; YAML matches the existing editable definitions.
Use cheaper implementation agents and parent review. Commit and push each tested
checkpoint, as already authorized.

The earlier R0–R7 record is historical evidence. This is the active continuation
queue. The owner subsequently authorized workspaces after all postponed
improvements below. Finish F1–F9 first; moving task storage alone does not mount
external repositories.

| Order | Checkpoint                                                                                                       | State                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| F1    | Validated project-local YAML board tasks, atomic persistence and current file-owned project metadata             | Complete; reviewed, 2,014 tests and 12 browser journeys passed                                                           |
| F2    | Whole-tree YAML execution state, explicit board/run linkage, engine shutdown and restart interruption            | Complete; reviewed, 2,079 tests and 14 browser journeys passed                                                           |
| F3    | Project-local agent-run records and replacement of remaining task SQL readers                                    | Complete; reviewed, 2,092 tests and 14 browser journeys passed                                                           |
| F4    | Drain admitted MCP mutations before terminal task state and store shutdown                                       | Complete; reviewed, 2,105 tests and 14 browser journeys passed                                                           |
| F5    | File/graph reconciliation and changed-content derived-index refresh                                              | Complete; 2,138 default / 132 graph tests, 14 browser journeys                                                           |
| F6    | Enforced global daily budget through existing execution paths                                                    | Complete; 2,176 tests, 14 browser journeys and packaged restart                                                          |
| F7    | Ordinary schedule absence/staleness detection                                                                    | Complete; 2,200 tests, 14 browser journeys and packaged restart                                                          |
| F8    | Durable provider upload cleanup/retry after cancellation and restart                                             | Complete; 2,223 tests, 14 browser journeys and packaged restart                                                          |
| F9    | Remove obsolete storage compatibility/schema paths, reconcile docs, full/browser/compiled/container verification | Complete; 2,342 default / 148 graph tests, 16 browser journeys, builds, packaged restart and offline containers verified |
| W1    | Review dissertation/teaching and implement flexible repository workspaces with browser artifact access           | Complete; 2,466 default / 150 graph tests, 19 browser journeys, 10 initializer tests and offline containers verified     |

Legacy metadata migration and prior Neo4j restoration are closed by the owner's
explicit decision, not by a claim that data was restored. Future runtime writes
still need interruption-safe behavior; discarding pre-use data does not justify
losing new tasks. No live external messages or account canaries are authorized.

## Storage boundary

Use `projects/<resolved-project-path>/tasks/board/<id>.yaml`,
`tasks/trees/<id>.yaml`, and `tasks/runs/<id>.yaml`. A whole execution tree and its
nodes commit together. Projectless work uses the existing system project's
physical folder. Resolve project IDs through trusted definitions; never join a
client ID directly into a path. The existing stores and execution engine remain;
their old SQL persistence is removed as each file-backed replacement lands.

## Review and evidence

Recorded per checkpoint as implementation and verification finish.

F1 evidence and reviewed limitations are in
[tech-spec-f1-project-task-files.md](tech-spec-f1-project-task-files.md). The default
suite passed 189 files / 2,014 tests (six deliberate live skips); required check,
core build, twelve browser journeys and packaged process-restart tests passed.

F2 evidence and reviewed limits are in
[tech-spec-f2-execution-tree-files.md](tech-spec-f2-execution-tree-files.md). Whole
execution trees now live in YAML; interrupted work requires deliberate resume.
The default suite passed 194 files / 2,079 tests (six deliberate live skips),
required checks and both production builds passed, and fourteen browser journeys
plus packaged process-restart verification passed.

F3 evidence and reviewed limits are in
[tech-spec-f3-agent-run-files.md](tech-spec-f3-agent-run-files.md). The default suite
passed 196 files / 2,092 tests (six deliberate live skips); required checks,
production builds, fourteen browser journeys and packaged restart passed.

F4 evidence and external-work limits are in
[tech-spec-f4-mcp-drain.md](tech-spec-f4-mcp-drain.md). The default suite passed 199
files / 2,105 tests (six deliberate live skips); required checks, core build,
fourteen browser journeys and packaged restart passed.
F5 evidence and repair limits are in
[tech-spec-f5-knowledge-reconciliation.md](tech-spec-f5-knowledge-reconciliation.md).
Read-only reconciliation, recoverable file writes and revisioned derived refresh
are complete. The default suite passed 203 files / 2,138 tests (six deliberate
live skips), 132 disposable Neo4j tests, required checks, core build, fourteen
browser journeys and packaged restart.
F6 evidence and cost-accounting limits are in
[tech-spec-f6-model-budget.md](tech-spec-f6-model-budget.md). Shared admission,
known/unknown settlement and SDK query caps are complete across chat, tasks,
heartbeat and learning. The default suite passed 207 files / 2,176 tests (six
live skips); required checks, core build, fourteen browser journeys and packaged
restart passed.

F7 evidence and calendar/shutdown limits are in
[tech-spec-f7-schedule-health.md](tech-spec-f7-schedule-health.md). Current activation
health, ordinary absence/staleness checks and graceful scheduled-work cancellation
are complete. Required checks, 211 files / 2,200 tests (six live skips), fresh core
build, fourteen browser journeys and two clean packaged process exits passed.
F8 evidence and remote-outcome limits are in
[tech-spec-f8-provider-upload-cleanup.md](tech-spec-f8-provider-upload-cleanup.md).
Durable upload ownership, exact-file cleanup, bounded fair retries and truthful
maintenance/HTTP reports are complete. Required checks, 213 files / 2,223 tests
(six live skips), fresh core build, fourteen browser journeys and two clean
packaged process exits passed. F9a consolidated the current operational schema,
removed retired SQL consumers, and passed 2,225 tests, fourteen browser journeys,
required checks and packaged restart. F9b completes dispatch ownership/settings,
artifact validation and per-start service contracts; 2,259 tests, 15 browser
journeys, required checks, production builds and packaged restart pass. F9
storage/runtime cleanup continues in the ordered subcheckpoints from
[tech-spec-f9-storage-runtime-cleanup.md](tech-spec-f9-storage-runtime-cleanup.md).

Implementation remains ordered, with parent review and a tested commit/push for
each checkpoint.

## Workspace requirements accepted from the owner

The proposed directory layout is a default, not a fixed project schema. Preserve
small Raven-owned anchors such as `project.yaml` and required internal records;
let each project's agent evolve its working directories, scripts and pipelines.
Dissertation and teaching already have different, explicitly structured agent
workflows. Read `../disertation` and `../teaching` (verify actual paths first) before
designing attachments; understand their index files, practices and tooling rather
than treating them as unstructured document collections.

An attached repository is the agent's working directory for the task. Agents must
be able to run shell commands, create and edit files, evolve scripts/workflows,
commit and push with the owner's configured autonomy. Review the existing Claude
Agent SDK modes and enforce the selected runtime configuration. The intended
deployment is a separate machine; do not replace the requested capable workflow
with a read-only attachment model. Raven remains the central coordinator for
projects, agents and shared context.

No repository embedding pipeline is requested. Store links to the repositories'
existing overview/index, key instructions and practice files in Raven project
context; use ordinary agent inspection to refresh the overview. Review reusable
document/tool workflows in both repositories for Raven skills, while keeping
project-specific requirements scoped. Provide browser/mobile access to generated
files and previewable artifacts through Raven UI/services. Include the complete
direct-repository task journey in acceptance tests, including commands, files,
Git and viewing results; do not claim this from a file-list endpoint alone.

F9c completes shared file-owned knowledge merges, validated consolidation and
truthful ingestion/cluster/hub outcomes. Parent-reviewed interruption recovery,
2,296 default tests, 148 graph checks across full/focused runs, 15 browser journeys,
required checks, core build and packaged restart pass. See the F9 spec for evidence
and the corrected test-fixture failures. F9d completes current definition diagnostics,
cache-safe project interruption recovery and mobile correction. Required checks,
2,342 default tests, 16 browser journeys, production builds and packaged restart
pass. F9e completes the current assessment, all 148 disposable graph tests, nine
deployment initializer tests, both current container images, offline persistence
and standalone static-asset checks. The required check and definition validators
pass; the current audit reports no advisories. F1–F9 are complete. The subsequent W1 checkpoints below are also complete.
Both actual sibling repositories were inspected read-only;
the [W1 specification](tech-spec-w1-project-workspaces.md) records the implementation
order, direct-execution boundaries and acceptance plan.

W1a completes file-owned workspace/source configuration and paired project anchors
with reviewed create/archive recovery. The required check, 2,384 default tests,
16 browser journeys, core build and compiled restart pass. Direct repository
execution continues in W1b; this checkpoint does not claim that stored settings
already change SDK cwd or permissions. See the W1 specification for evidence.

W1b's first runtime checkpoint completes project-local agent identity/defaults and
project-owned memory together. Parent review covered cross-project lookup, current
file identity, atomic note/agent writes, candidate/index conflicts, partial learning
failures, validator scope, mobile selection and commit shutdown drain. Required
checks, 2,397 default tests, 17 browser journeys across full/focused runs, production
builds and compiled restart pass. See
[project context checkpoint](tech-spec-w1b-project-context.md). Direct SDK cwd,
permission modes and session revisions are the next W1b checkpoint; W1c then adds
repository overviews/skills, followed by W1d mobile workspace/artifact access.

W1b direct execution is complete. The
[execution checkpoint](tech-spec-w1b-workspace-execution.md) verifies selected cwd,
SDK default/auto/full modes, current workspace/agent/capability grants, scoped
integration hooks and persisted resume revisions. Parent review preserved successful
creation/reload of unrelated skills while rejecting stale bound definitions.
The required check, 2,431 default tests, real SDK subprocess contracts, actual
temporary shell/file/commit/push, core build and compiled restart pass. W1c adds
repository context links/shared skills and flexible managed layouts; W1d adds
mobile artifacts and explicit graph project selection/filtering.

W1c is complete. [Current context and repository workflows](tech-spec-w1c-workspace-context.md)
replaces stale chat-only context with current shared project instructions and bounded
links to existing repository entrypoints. Explicit nested anchors leave ordinary
working folders flexible. Shared document/media skills follow repository pipelines
and output conventions. Parent review, required checks, definition validation,
2,443 default tests, 17 browser journeys, core build and compiled restart pass.
W1d now implements browser workspace/artifact access and explicit graph project
selection with server-side filtering.

W1d is complete. [Browser workspaces and project graphs](tech-spec-w1d-browser-workspaces.md)
records file registration/serving, mobile previews, direct navigation and explicit
graph ownership. The actual shell→file→Git push→browser journey passes, including
rendered PDFs and Unicode downloads. All 2,466 default tests, 19 browser journeys,
40 disposable graph route tests, required checks, validators, production builds
and packaged restart pass.

W1e is complete. [Deployment and final verification](tech-spec-w1e-workspace-deployment.md)
records public native capability seeds, runtime tools and an optional explicit
repository mount. All 150 disposable graph tests, ten initializer tests, required
checks, definition validators, the context allowlist and both image builds pass.
Offline container replacement preserves attached artifacts, project memory/settings
and actual Git history after native commands and a local push; standalone PDF
worker serving also passes. F1–F9 and W1 are complete. Live provider canaries,
repository-specific tool installation and optional transcription integration have
explicit follow-up criteria in the deferred ledger and deployment guide.
