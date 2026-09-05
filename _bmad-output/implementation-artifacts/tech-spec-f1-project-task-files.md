---
title: Project-local YAML board tasks
type: refactor
created: '2026-09-05'
status: complete
baseline_commit: 0244248
execution_mode: plan-code-review
context: ['AGENTS.md', 'ARCHITECTURE.md']
---

## Intent and authorization

The unused Raven project may discard legacy runtime state. The owner wants task
files inside each project, approved YAML, cheaper implementation agents and parent
review, and already authorized committing/pushing each tested checkpoint. Move
board tasks into readable authoritative files with the existing API; later
checkpoints move execution trees/run history and finish the remaining reliability
issues. No legacy SQLite task import or second authoritative store is needed.

## Boundaries

Use projects/<resolved fsPath>/tasks/board/<id>.yaml. A trusted provider supplies
the current project ID/fsPath pairs; IDs from HTTP must never become directory
paths directly. Projectless records use system/tasks/board physically, preserving
the public optional projectId contract. Keep the synchronous TaskStore interface,
existing task events and query behavior. Files are read as authority, including
after restart or an external edit; no SQL task fallback. Retired pipeline fields
can be removed in the final obsolete-schema checkpoint rather than mixed into
this API-compatible change.

All reads/writes reject symlinked roots/components/files, malformed YAML, invalid
schema, duplicate record IDs, mismatched filename/document/project ownership and
invalid task relationships. Validate IDs as safe filenames without traversal.
One Raven process owns a storage root; do not add a new service/engine or database.
Use current yaml/Zod dependencies and existing logger conventions.

## Implementation map

- packages/core/src/task-manager/task-store.ts: replace SQL implementation with
  YAML-backed existing methods. Add focused helper modules for file IO, record
  validation and filtering; avoid one oversized factory or lint disables.
- packages/core/src/project-manager/project-records.ts: shared synchronous helper
  for trusted project-scoped records, atomic writes and recovery of cross-project
  moves. Reusable by later tree/run stores; keep it small and explicit.
- packages/shared/src/types/tasks.ts: persisted record validation as needed,
  preserving current public types and API behavior for this checkpoint.
- packages/core/src/api/routes/tasks.ts: distinguish missing task (404), invalid
  references/input (400/409) and storage failures (500); validate completion input.
- packages/core/src/raven.ts: explicit projectsDir/provider wiring. Parent owns
  this file and project-cache/project-sync changes; coordinate via messages.
- task-store, tasks-api, task-lifecycle and task-schedule-filter tests: replace
  direct board SQL fixtures with real temporary project YAML. Parent covers
  composed fixtures and project deletion/current metadata as needed.

## Durability and relationships

Validate the complete next task before IO. A same-directory exclusive temporary
file, file flush, atomic rename and directory flush precede publication/events.
No read should observe a partial document. Reject duplicate (source, externalId)
pairs, unknown projects/parents, parent cycles and cross-project parent links.
Completing is idempotent for artifacts/timestamps; reopening clears completedAt.
Queries and counts remain deterministic and reflect files, not stale in-memory
records. Validate direct method input as well as HTTP input.

Cross-project reassignment must preserve the existing update API. Since it changes
two paths, use a small durable move intent with source/destination paths and
expected content hashes. Recovery completes an admitted move and removes the
old copy, refuses conflicting external edits, and never silently overwrites a
different task. No general transaction framework is needed. Reject a parent move
that would leave children in another project; a separate explicit child transfer
is outside this checkpoint. Stale temporary files are not authoritative records.
Handled pre-commit errors emit no task success event.

## Acceptance and verification

- Given temporary project definitions, creating a project task writes valid YAML
  inside exactly that project; omitted projectId writes under system.
- Given the same files and a new store, queries/completion/archive work with no
  SQLite task rows. Updating a YAML task externally is reflected on next read.
- Given malformed/duplicate/foreign/symlinked files or references, loading or
  mutation fails clearly before a successful write/event.
- Given completion/reopen/retry, completedAt and artifacts stay consistent.
- Given failure before atomic replacement, old bytes remain; given interruption
  during reassignment, the next store recovers one correct record or reports an
  actual conflict. Test durable fault boundaries without touching owner paths.
- Given a project with task files, deletion cannot orphan those tasks. Missing or
  empty old SQLite-only task data cannot become authoritative again.
- Focused store/API/lifecycle/filter/recovery tests, required npm run check,
  applicable composed restart and project ownership tests pass before commit.

Use Node22.23.2/npm10.9.8 at /tmp/raven-node-r6/node_modules/.bin if still present.
Test sockets/subprocesses may require approved escalation. No .env, owner database,
owner graph or authenticated model calls. Preserve the owner's next-env/IDE/local
project work. Parent reviews all changes before staging.

## Review and evidence

Parent review corrected creation validation, empty project IDs, completion
idempotency, offset timestamp ordering, partial archive event publication,
symlink/path validation, move recovery conflicts, project deletion races, stale
metadata fallback, explicit system permissions, identity removal and failed
registry reload handling. No legacy task import or orphan project scaffolding
remains. Referenced missing projects stay readable as history but cannot accept
new work. The active plan separately tracks execution trees, run history and
obsolete SQL schema cleanup.

Verification on September 5:

- `/tmp/raven-f1-full-final.log`: 189 files, 2,014 tests passed, six explicit live
  TickTick tests skipped. Initial failures were corrected test fixtures; the
  final default suite is green.
- `/tmp/raven-f1-check-final.log`: formatting, ESLint, shared/core TypeScript,
  strip-types compatibility and dependency override guard passed.
- `/tmp/raven-f1-browser.log`: all 12 isolated headless journeys passed, including
  board drag-to-complete, reload and task details/artifacts.
- `/tmp/raven-f1-build-final.log` and `/tmp/raven-f1-compiled-final.log`: core build
  includes 33 SQL migrations; the packaged runtime verifies task YAML, definitions,
  memory, session/Git history and fake-backend chat across two clean processes.
  The extended smoke helper now expects the task API's 201 response.
- `/tmp/raven-f1-faults.log`: ten fault cases cover failed write/rename, three
  durable move phases, conflicting edits, path aliasing and removed destinations.
  These tests also pass in the final full suite.
- All 87 original definition files retain their baseline hashes; owner IDE,
  local projects and next-env changes remain unstaged.

One process owns each record root. Manual external moves of referenced project
definitions require an explicit identity decision; the implementation fails
closed rather than silently attaching history to a different definition.
