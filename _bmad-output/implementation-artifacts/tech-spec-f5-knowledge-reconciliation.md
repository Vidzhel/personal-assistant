---
title: Knowledge reconciliation and derived-index refresh
type: fix
created: '2026-09-05'
status: planned
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
