# Existing reliability work — September 5, 2026

Scope authorized by the owner: finish existing tasks sequentially, review and test
changes, and record concrete fixes for deferred work. Repository attachments,
new workspace layout, project-memory redesign, and graph replacement are deferred
until the owner returns to that design. Existing checked-off/unchecked historical
plans are reconciled against code, not blindly reimplemented.

| Order | Task | State | Completion evidence |
| --- | --- | --- | --- |
| R1 | Enforce project ownership in data-source and session entry points | Complete | 83 focused backend tests; 34 final ownership/stream tests; check + web types passed. Independent reviews, buffer defect fixed. |
| R0 | Isolate all composed tests from owner definitions and mutable roots | Complete | Full suite: 159 files, 1763 passed / 6 skipped; check passed; 87 owner definition files unchanged. |
| R2 | Finish current project metadata/update/delete persistence | Complete | 163 files; 1818 passed / 6 skipped; check passed; restart, archive, failure and graph-race coverage. |
| R3 | Correct capability failure behavior and knowledge availability | Complete | 171 files, 1907 passed / 6 skipped; check passed; 30 disposable Neo4j tests; independent review fixes verified. |
| R4 | Repair current build/deployment paths and runtime persistence | Pending | Web/core builds and isolated boot; container config/build checked where available. |
| R5 | Review current learning/schedule/approval loops and run isolated journeys | Pending | Outcome-based E2E and browser verification; defects fixed or recorded below. |
| R6 | Reconcile Claude/Codex/docs and old plan status with final behavior | Pending | One truthful current status entry; specific remaining tasks, not stale phase checklists. |
| R7 | Final regression/review and resolution ledger | Pending | check, tests, definition validators, builds; evidence and limits documented. |

## Deferred work and resolution plans

- Workspace attachments and new project-memory ownership: explicitly deferred by
  owner. Resume the proposed workspace design only after this reliability pass;
  it defines source grants, identity migration, file retrieval, and acceptance journeys.
- Graph removal: keep the current graph. Before replacement, back up and export
  IDs, durable node metadata, project memberships, and all relationship statuses;
  prove restore/parity before switching readers and deleting infrastructure.
- Existing local Neo4j test-contact delta: no pre-run snapshot exists. Do not
  guess/delete records. Compare against the owner's last backup/export if one is
  available, classify the exact delta, and only then propose a bounded repair.
  The default test suite is now isolated at the graph-client factory boundary.

Each completed task receives implementation, review findings, verification, and
any follow-up entries here. No live outbound messages or production deployment
are part of isolated verification.

## R1 completion

HTTP, WebSocket and direct chat events reject unknown/foreign explicit sessions
before transcript/status/model mutations. Nested data-source CRUD checks its
parent, and session reference deletion requires a matching endpoint. Valid
source lifecycle and resumed/new chats remain covered.

Three independent review perspectives found one exposed UI defect: after 201
messages the bounded WebSocket buffer stopped advancing the chat cursor. Fixed
with message-identity consumption; regression and follow-up review cover errors
after 250 messages, batched arrivals and eviction. No backend bypass was found.

Verification: focused backend command covering project-ownership,
project-knowledge, orchestrator, session-management and api tests passed 83 tests.
Final ownership + ws-message-cursor run passed 34 tests; shared build,
`npm run check` and `npx tsc --noEmit -p packages/web/tsconfig.json` passed.
Full composition regression waits for R0 isolation. Wider session/UI issues are
scheduled in R5 and listed in `deferred-work.md`.

## R0 completion

Every composed test uses explicit temporary project/library/config/data paths
and a fake backend. Preflight guards protect both fixture construction and
composition startup; explicit SDK factories, external paths and symlinks are
rejected. The environment/Neo4j guards remain. The real SDK subprocess contract
uses its fake executable; runner-dependent failures passed with escalation.

Independent diff/acceptance reviews plus parent edge review found fixture writes
preceding validation and inconsistent service configDir handling. Both were fixed
and re-reviewed. Fresh reviewer spawning reached the tool's thread limit, so
the two independent reviewers were reused from unrelated read-only audits.
Services now share the selected config root; an email E2E covers a custom path.
The new chat MCP journey creates a skill and reloads the isolated library.
A memory-test event subscription race was also fixed.

Full regression with two workers and approved subprocess/socket access passed
159 files, 1763 tests, with 6 skipped (`/tmp/raven-r0-full.log`). Final check passed
(`/tmp/raven-r0-check-final.log`). The integrity manifest confirms all 87 files
under projects/library/config unchanged, with no additions or removals. Git
is deliberately mocked in composition tests; real history verification remains
part of the runtime persistence task. No live services were used.

## R2 completion

Managed project settings and UUID identity persist in the existing context.md
definition. Updates merge current file metadata and preserve human context;
the saved prompt reaches chat. Empty projects archive original context plus an
identity snapshot, while referenced/system projects refuse deletion. Project
knowledge mutations serialize with deletion, and canonical IDs resolve correctly
through child navigation, template filtering and model project listings.

Review found and fixed metadata overwrite, reserved-root cycles, path/ID mismatch,
graph-write races, incomplete enumeration, orphan double writes and archive
identity loss. The validation command now catches project metadata and identity
errors. Two reused independent review perspectives plus parent review were used;
the reviewer who authored some tests excluded their own route patch, which the
other reviewer inspected. The tool's thread limit prevented fresh reviewer threads.

Final full suite: 163 files, 1818 passed / 6 skipped; npm run check passed.
All 87 original definition files remain unchanged. Legacy metadata export and
process-interruption recovery have explicit resolution plans in deferred-work.md;
graph-unavailable archives report that memberships were not checked. Default
tests do not establish real Git history or live account delivery.

## R3 completion

Named agents reject missing skill, MCP and vendor definition bindings before
turn mutations; neither chat nor heartbeat inherits the full library on failure.
Knowledge MCP registration and prompt instructions follow actual dependencies
and role permissions. Unsupported search filters/domain-save fields and the
unusable knowledge specialist were removed. The project validator now checks
nested current agent definitions as well as legacy flat YAML.

Explicit graph disablement creates no drivers, including background services.
Private initialization publishes dependencies only after success; failure disposes
all started processors and the driver. Disposal stops subscriptions, local waits,
late graph/file writes, nested merge events and inference that has not begun.
Already running external model work is not cancelled by this graph lifecycle.
HTTP requests drain before graph disposal.

Routine reindex merges by durable file identity and preserves graph relationships,
project memberships, lifecycle metadata and unmatched records. Duplicate or malformed
input batches fail preflight; generated IDs survive retries. Review found and
fixed stale file claims, identity-write snapshot overwrite, late CRUD file writes,
lazy-model initialization and nested merge continuations. Full vendor-reference
validation was also added after review. Two reused independent reviewer perspectives
and parent review were used; fresh reviewer threads were unavailable.

Final default regression: 171 files, 1907 passed / 6 skipped
(`/tmp/raven-r3-full-final.log`). Final npm run check passed
(`/tmp/raven-r3-check-final.log`). A separately opted-in, disposable Testcontainers
Neo4j run passed all 30 knowledge-store cases, including real relationship and
replacement-file preservation (`/tmp/raven-r3-reindex-neo4j-final.log`). The 13
default reindex/disposal cases passed; all 87 original definition files remain
unchanged. Interrupted cross-store recovery and external-edit derived-index refresh
have concrete follow-up plans in deferred-work.md.
