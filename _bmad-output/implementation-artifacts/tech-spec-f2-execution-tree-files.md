---
title: Durable project-local execution trees
type: refactor
created: '2026-09-05'
status: planned
execution_mode: plan-code-review
context: ['AGENTS.md', 'ARCHITECTURE.md', 'tech-spec-f1-project-task-files.md']
---

## Intent

Continue the owner's approved project-local YAML task storage after F1. Keep the
existing execution engine and public task-tree API; replace SQL persistence and
fix its missing shutdown/restart lifetime. No legacy tree import, export or
migration. A tree and all execution nodes belong to one validated YAML document
under `projects/<resolved-fsPath>/tasks/trees/<treeId>.yaml`. Projectless trees use
the built-in system project. Use the reviewed F1 record path/write helpers.

## Implementation boundaries

- `task-execution/task-execution-engine.ts`: keep its current class API and task
  types, replace row readers/writers, and own timers, code children and asynchronous
  validation. Extract focused persistence/transition helpers where needed to obey
  existing lint rules. Do not add another engine or SQL projection.
- Add a tree document schema using existing `TaskTreeNodeSchema`, artifact and
  status contracts. Encode the runtime Map as an array of execution records.
  Validate unique IDs, matching node/execution IDs and parent tree ownership,
  valid dependencies, condition targets, cycles and current project membership
  before any durable write or dispatch.
- `execution-bridge.ts`: keep exact agentTaskId attempt correlation, clear pending
  entries on stop, make repeated start/stop safe, and reject late completions after
  cancellation or a newer attempt. Do not let an unknown named agent silently use
  another agent's capabilities.
- `raven.ts`: inject the same trusted project provider as board tasks. Stop new
  execution admission before draining agents; keep completion handling available
  while admitted work settles, then drain/dispose the engine before stores close.
- Replace SQL tree readers in `services/system/self-test.ts` and
  `agent-memory/system-retrospective.ts` with engine/store queries. Remove the
  obsolete task_trees project-reference query; files protect containing projects.
  Agent-run SQL remains for F3.
- Remove `task-manager/task-lifecycle.ts`'s implicit newest-task-by-agent matching.
  No current producer dispatches board tasks through this bridge: scheduled jobs
  complete their explicitly created board task directly, and execution trees have
  the separate runtime bridge. Prefer removing the unused heuristic and its Raven
  wiring over introducing an unpopulated correlation field. If inspection finds
  a real board dispatch producer, carry and validate exact board ID, project and
  attempt instead; document that evidence before implementation.

## State and durability

Persist the complete candidate tree before publishing state or dispatch events.
In particular, cancellation and its affected node states commit together. A
failed write cannot leave a mutated cache claiming success. Queries must return
detached snapshots; callers cannot mutate engine state through a returned Map.
Read current files after restart; missing means absent, invalid means actionable
failure, and file changes must not be silently overwritten by an older attempt.
Serialize a tree's transitions and coordinate with project mutations using the
existing root lock. Do not lose a terminal update merely because a definition
reload briefly holds the lock; drain/retry admitted transitions appropriately.

Track every delay timer and code subprocess by exact tree/node identity. Abort
code execution on cancellation/stop and await its settlement. Track validation
promises; after each await verify active lifetime, tree status, task status and
attempt identity before persisting or scheduling another attempt. A cancelled
task must remain cancelled even if validation later succeeds or fails. Runtime
completion cannot override a newer dispatch or restart.

Startup must identify previously running or validating work as interrupted and
persist a visible blocked state with a reason. Do not automatically replay code
or remote actions that might already have happened. Preserve completed nodes and
artifacts. Pending approval trees remain pending; a deliberate retry/resume path
must be explicit and validated through the existing API. On graceful stop, clear
timers and settle owned local work before reporting stopped; no later state writes
or execution events are permitted. No claim about remote provider cancellation.

## Acceptance and review

- Given real temporary project files, creation produces exactly one whole-tree
  YAML document with no SQL tree/node rows; malformed/dependent/cyclic plans fail
  before any record or dispatch exists.
- Given cancellation of a multi-node tree, a restarted engine sees all affected
  nodes cancelled in the same snapshot. Inject a write failure and prove previous
  file bytes/cache/events remain consistent.
- Given held validation or code, cancel/stop and then release it; no late success,
  retries, task writes or side effects from another engine lifetime occur.
- Given an interrupted running document, startup marks it visibly blocked without
  dispatching work and retains completed artifacts. Intentional resumption uses
  the documented current API and a fresh attempt identity.
- Given two unrelated board tasks assigned to the same agent, ordinary chat and
  execution-tree completion cannot complete either board task implicitly.
- Existing engine, execution bridge, validation, template scheduler, self-test and
  retrospective tests pass after replacing SQL fixtures. Add focused persistence,
  interruption and lifecycle races; run required check and composed/compiled
  restart verification before parent review, commit and push.

## Evidence

Planned while F1 implementation and parent review run. No F2 changes are complete.
