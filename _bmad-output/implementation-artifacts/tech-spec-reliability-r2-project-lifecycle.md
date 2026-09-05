---
title: Make existing project metadata and lifecycle survive restart
created: 2026-09-05
type: bugfix
status: done
baseline_commit: 17ead95
context: [AGENTS.md, ARCHITECTURE.md]
---

# R2 — Finish the current project lifecycle

Fix the current project feature without implementing workspace attachments or a
new workspace schema. Existing API fields must round-trip through the existing
filesystem project definition and survive registry synchronization/restart.

## Boundaries and implementation tasks

- Use validated metadata in the existing `context.md` definition (for example a
  namespaced YAML frontmatter section) rather than introducing the proposed
  workspace manifest. Preserve the human context body and unrelated metadata.
  A legacy plain context file remains readable; preserve legacy DB metadata
  during reconciliation rather than overwriting it with inferred defaults.
- Extend scanner/scaffolder/project sync/API together for existing display name,
  description, skills, systemPrompt and systemAccess. Preserve DB/project IDs
  and fs_path on ordinary edits. Avoid writing migration data into owner files
  until actual runtime use; verification runs on temporary fixtures.
- Update must persist the definition atomically and reload the registry/cache.
  Handle failure without reporting a successful DB-only update. Use existing
  commit helper for actual project-definition edits with exact file scope.
- Delete an empty ordinary project without later registry resurrection; preserve
  its managed directory by moving it to an ignored archive location before
  removing the cache row. Reject deletion of the system project, projects with
  children, or projects with referenced runtime/history/config records with a
  clear conflict response. Do not delete user history or move external folders.
  Roll back the file move if DB mutation fails. Do not invent a new archive UI.
- Guard mutation paths against traversal/symlink escapes. Handle concurrent edits
  and create-name conflicts consistently; avoid overwriting existing context.
- Add real-composition/API restart tests and focused legacy/failed-write/delete
  regressions; all roots and model boundaries must be isolated.

## Acceptance

- Given a project created/updated with every supported field, when core restarts,
  then GET returns the same metadata/ID and chat sees the intended context.
- Given a legacy DB-linked project and plain context.md, when synced, then its
  existing settings survive and no false default access is granted.
- Given an empty ordinary project, when deleted and core restarts, then it does
  not reappear and its archived files remain recoverable.
- Given a project with sessions/data sources/children or system identity, when
  deletion is attempted, then it fails clearly without changing files or records.
- Given a write/move/database failure, API does not report success or leave an
  intentional split store; relevant regression tests and npm run check pass.

No source attachments, source indexing, graph removal, or project-memory
ownership changes are included. Report precise limitations and follow-ups.

## Preparation review — concrete edge cases

- Distinguish absent legacy metadata from explicitly invalid metadata. Invalid
  namespaces must report an error, not silently fall back. Preserve legacy
  system_access, including access-only orphans; `carriesConfig()` currently
  misses that field. Preserve IDs/fs_path independently of display names.
- `systemPrompt` is currently disconnected from chat. Include the supported
  persisted prompt in resolved context without exposing raw YAML. Project skills
  remain metadata; do not broaden the named agent's bindings from that field.
- Apply creation safety to API, scaffold/bulk, Telegram and reconciliation.
  Protect scanner-ignored/reserved paths and the seeded meta ID; reject missing
  parent definitions and existing unindexed directories without overwriting.
- Serialize the relevant full mutation, including merging updates, registry
  reload and DB writes. Exclusive file creation prevents same-slug overwrites.
  Recheck references immediately before deleting after any awaited file move.
- Reference checks include telegram_topics with scope='project' and key=ID,
  plus local agents/templates/schedules/children even if their definitions are
  malformed. Protect the system by ID/path as well as its DB flag. State the
  graph-membership preservation policy explicitly; known links must survive,
  and unavailable graph metadata must not be claimed as verified empty.
- Preserve original file bytes for compensation on handled failure. Reconcile
  create failures too, so failed requests do not become projects on restart.
  Never put an async callback inside a SQLite transaction. Document power-loss
  limits rather than claiming filesystem/SQLite cross-store atomicity.
- Guard archive-root and context-file symlinks, use a unique archive destination,
  and distinguish scanner exclusion from Git ignore. Call exact-path commit
  helper only after success; its swallowed Git errors are not transaction proof.

The preparation review was read-only; it did not touch owner definitions.

## Implementation and review decisions

New managed definitions persist a UUID separately from their filesystem path.
Existing operational IDs remain stable. The `ravenProject` namespace in
`context.md` owns supported settings; ordinary updates preserve the exact human
body and unrelated YAML comments. Legacy definitions without metadata retain
their existing database settings until a managed update writes them to the file.
An archive keeps the original context plus an `archive.json` identity/settings
snapshot; it is excluded from scanning but eligible for exact-path Git history.

Independent boundary review and parent review found and corrected stale-file
metadata overwrites, synthetic `_global` collisions, UUID/path consumers,
graph-link/delete races, incomplete filesystem enumeration, orphan reconciliation
double writes, missing legacy archive identities, and invalid empty-frontmatter
handling. The validator now checks metadata, effective identity collisions and
enumeration errors as well as the existing agent/schedule/template rules.
The existing three-level project limit also applies before new definition writes.

Knowledge link/proposal writes share the project mutation lock. Known graph
memberships prevent deletion; unavailable graph metadata is explicitly reported
as unchecked, and graph nodes/relationships are never deleted by project archive.

Handled write/reload/database failures compensate file/cache changes. This does
not provide atomic filesystem/SQLite commits across process termination or power
loss. Preserve the database and archive snapshots for recovery; the follow-up
ledger records interrupted-mutation reconciliation and legacy metadata export.

## Verification

Final full regression: 163 files passed; 1818 tests passed and 6 skipped
(`/tmp/raven-r2-full-final.log`). `npm run check` passed, including formatting,
ESLint, shared/core type checks and strip-types validation
(`/tmp/raven-r2-check-final.log`). Seven composition journeys cover restart,
prompt delivery, archive retention, reference refusal and a fresh cache rebuild.
Lower-level lifecycle tests cover 28 cases; metadata/definition validation covers
31 cases. Graph concurrency uses a fake driver and real SQLite/filesystem lifecycle.
All 87 original owner definition files are unchanged, with no additions/removals.

Two reused independent reviewers plus parent review assessed boundaries and
acceptance. The acceptance reviewer had authored the lifecycle E2E; their own
template/graph-route patch was excluded from that review and checked by the
other reviewer. Fresh reviewer threads were unavailable at the tool's thread
limit. No live service, model account, external graph or outbound delivery was
used as verification; Git is mocked in the default composition suite.
