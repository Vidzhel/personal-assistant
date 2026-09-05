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

| Order | Checkpoint | State |
| --- | --- | --- |
| F1 | Validated project-local YAML board tasks, atomic persistence and current file-owned project metadata | Complete; reviewed, 2,014 tests and 12 browser journeys passed |
| F2 | Whole-tree YAML execution state, explicit board/run linkage, engine shutdown and restart interruption | Complete; reviewed, 2,079 tests and 14 browser journeys passed |
| F3 | Project-local agent-run records and replacement of remaining task SQL readers | Complete; reviewed, 2,092 tests and 14 browser journeys passed |
| F4 | Drain admitted MCP mutations before terminal task state and store shutdown | Complete; reviewed, 2,105 tests and 14 browser journeys passed |
| F5 | File/graph reconciliation and changed-content derived-index refresh | Complete; 2,138 default / 132 graph tests, 14 browser journeys |
| F6 | Enforced global daily budget through existing execution paths | Pending |
| F7 | Ordinary schedule absence/staleness detection | Pending |
| F8 | Durable provider upload cleanup/retry after cancellation and restart | Pending |
| F9 | Remove obsolete storage compatibility/schema paths, reconcile docs, full/browser/compiled/container verification | Pending |
| W1 | Review dissertation/teaching and implement flexible repository workspaces with browser artifact access | Authorized after F1–F9 |

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
browser journeys and packaged restart. F6 is the next checkpoint.

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
