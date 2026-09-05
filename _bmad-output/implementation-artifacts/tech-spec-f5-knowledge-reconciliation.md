---
title: Knowledge reconciliation and derived-index refresh
type: fix
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Intent

After F4, finish the existing knowledge file/graph boundary and refresh stale
derived data after external Markdown edits. This concerns Raven knowledge
bubbles; it does not add repository embeddings to the owner's workspace design.
No legacy export or restoration is required.

## Implementation boundaries

Extend the existing knowledge store and processors. Markdown owns bubble
identity, path, content and file metadata. Graph project memberships, typed
links, lifecycle properties and annotations remain durable graph state.
Routine reconciliation must preserve those relationships and properties and
must never prune unmatched Bubble nodes automatically.

Provide a read-only reconciliation report for file-only and graph-only records,
path/identity mismatches, malformed or duplicate files and stale derived data.
Expose it through the existing knowledge maintenance route. Separate repair
choices from reporting; fail closed on ambiguous duplicate identities.

Review rename/delete mutation order: `updateBubble` currently unlinks the old
path before writing the new path, and `removeBubble` deletes the graph before
unlinking Markdown. Make interruption outcomes recoverable through the existing
write path and report any unresolved disagreement explicitly. Preserve a valid
file until its replacement is durable. Do not advertise a reconciliation report
alone as atomic cross-store writes or restoration of lost graph relationships.

Use canonical source hashes to detect edits relevant to embeddings/chunks.
Persist derived revision hashes only after a successful replacement; a mismatch
remains retryable after restart. Refresh one bubble at a time while retaining
old derived data until the replacement is ready. Remove the global chunk-delete
step from routine refresh so one failure cannot erase unrelated derived data.

Startup reindex currently precedes processor construction. Return changed IDs or
otherwise hand pending refresh work to the existing processors after they start;
do not emit events before their listeners exist and assume refresh occurred.
Keep failed refreshes stale and retry through the existing maintenance path.

## Acceptance

Use isolated fixtures and fake or disposable graph storage, never the owner's
graph. Verify a nonmutating report for every disagreement class; preserve durable
relationships and properties across repeated reindex and external body/title/tag
edits. Inject failures at rename, file/graph mutation and embedding/chunk write
boundaries. Prove old usable data remains, staleness is visible, retry succeeds,
and one failing bubble does not erase another's derived data. Verify startup
refresh begins after processor registration and respects F4 shutdown draining.
Run required checks and the default suite before parent review, commit and push.

## Reviewed implementation

- `GET /api/knowledge/reconciliation` compares source files, graph metadata,
  source/derived revisions and actual derived records without changing either
  store. Each discrepancy carries a repair instruction. The report remains
  available when startup encounters invalid files; connection/schema/processor
  initialization failures still disable the unavailable graph.
- `POST /api/knowledge/reindex` and `POST /api/knowledge/reindex-embeddings` await
  the actual source/embedding/chunk repair and return indexed files, refreshed
  IDs, file errors and per-component refresh errors. The obsolete synthetic
  reindex task ID/status route is removed. Concurrent runtime repair requests
  share one operation. Existing system maintenance retries stale revisions and
  appends deterministic results and unresolved issues to its saved report.
- Startup indexes files before constructing processors and refreshes changed
  IDs after all processor listeners are registered. This owned refresh runs in
  the background so model loading cannot block the dashboard; explicit repair
  requests share the pending work. A failed component stays
  stale; it does not disable the report or prevent another bubble from refreshing.
- File metadata is validated consistently, with optional plain-Markdown fields
  and retained additional frontmatter. Direct reads use current file content,
  title, tags and source metadata; graph lifecycle state, domains, links and
  project memberships remain graph-owned. Processor reads do not bump access
  timestamps. Source revisions hash canonical title, trimmed body and tag set.
- File writes use a flushed temporary file plus rename. A renamed source is
  retained until the replacement and graph write succeed. Store mutations queue
  to avoid interleaved Raven edits; exact-byte checks reject stale file copies.
  Delete intent YAML is durable before graph deletion, protects the identity
  from reindexing and permits an explicit retry of the same delete after restart.
  Changed source bytes are retained for manual resolution.
- Embedding generation finishes before its graph replacement. Chunk refresh
  prepares all chunks before one transaction replaces that bubble's derived
  rows. Revision checks happen under a node write lock; revision markers commit
  with the replacement data. Routine repair never globally deletes chunks.

Neo4j's documented write-lock pattern supports the revision check under a
transaction lock; see the [official concurrent data access documentation](https://neo4j.com/docs/operations-manual/current/database-internals/concurrent-data-access/).
The SDK/model pipeline can finish late; these guards protect local commits and
do not claim remote cancellation.

## Operational limits and repair choices

Markdown and Neo4j do not share one atomic transaction. An interrupted rename
can leave two files with the same ID; resolve which file to retain before
reindexing. A graph-only Bubble is retained, including its links, until an
explicit repair is chosen. Reindexing a file-only Bubble cannot restore graph
relationships that were previously deleted. A pending deletion never triggers
automatic file deletion on startup: retry the explicit delete, or inspect and
resolve the intent and source conflict manually. No legacy restoration is added.

Embedding and chunk freshness is independent of graph relationship recovery.
Successful source indexing alone does not mean retrieval is fresh; inspect
`refreshErrors` and the reconciliation report. The revision hashes are detection
and retry markers, not a history of old source files or a backup system.

## Verification

- Required check passed: `/tmp/raven-f5-check-verified.log`.
- Default suite: 203 files, 2,138 passed, six explicit live skips:
  `/tmp/raven-f5-full-verified.log`. Three prior cancellation tests were updated
  for queued mutation/transaction boundaries; none was removed or newly skipped.
- Disposable Neo4j: 132 passed across storage (32), API/retrieval (50), and
  embedding/chunk/domain processors (50). Logs:
  `/tmp/raven-f5-knowledge-store-final.log`,
  `/tmp/raven-f5-knowledge-api-retrieval.log`,
  `/tmp/raven-f5-knowledge-processors.log`.
- Core build, 14 isolated browser journeys and compiled restart with two clean
  process exits passed: `/tmp/raven-f5-build-core.log`,
  `/tmp/raven-f5-browser.log`, `/tmp/raven-f5-compiled.log`.
- All 87 baseline definition files remain byte-identical. Owner IDE files,
  local project folders and `packages/web/next-env.d.ts` remain excluded.

Parent review corrected file authority fallbacks, pending deletion and mutation
queue behavior, source/derived revision handling, missing derived records,
automatic domain membership loss and startup model-loading availability.
Graph tests use disposable containers and fake model output; they do not claim
live model quality, account authentication, provider cancellation or restoration.
