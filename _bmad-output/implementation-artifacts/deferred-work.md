# Reliability follow-ups — September 2026

The active delivery queue is
[reliability-completion-2026-09-05.md](reliability-completion-2026-09-05.md).
Items assigned to an R-task below are scheduled within this pass, not accepted
as permanent limitations. Update the status and evidence when each is resolved.

| Item | State / target | Resolution and verification |
| --- | --- | --- |
| Chat/session UI races, optimistic rejected text, disconnected sends | Scheduled R5 | Scope live events and pending/history state by session; retain rejected drafts; browser-test switching and failed sends. |
| References stream stops updating after the 201-message buffer fills | Scheduled R5 | Reuse the reviewed message-identity cursor; verify references continue after buffer rollover. |
| Intentional WebSocket disconnect schedules a reconnect | Scheduled R5 | Close-state guard and timer cleanup; assert no reconnect after unmount and recovery after an unexpected close. |
| Voice transcript output depends on process working directory | Scheduled R4/R5 | Resolve output under the configured runtime data root; test the file path using temporary roots from a different working directory. |
| Maintenance convention audit still inspects retired agents.json/schedules.json | Scheduled R5 | Use current registries/validators or remove obsolete checks; test useful violations and a healthy current layout. |
| IMAP service registration requires OAuth variables instead of its actual IMAP credentials | Scheduled R5 | Align registry requiresEnv with GMAIL_IMAP_USER/GMAIL_IMAP_PASSWORD; test gating with fake service boundaries. Current isolated email tests do not set IMAP credentials or connect. |
| Active agent tasks can outlive core shutdown | Scheduled R5 | Audit AgentManager queue/run cancellation and add stop/drain behavior before SQLite/logging disposal; prove with a deferred fake backend that shutdown emits terminal state and produces no late writes. R3 handles knowledge processors and HTTP-before-driver ordering; that does not cancel external model tasks. |
| Workspace attachments and project-owned memory | Deferred by owner | Resume the proposed workspace design after current reliability tasks; agree ownership, grants, retrieval and migrations before implementation. |
| Graph replacement and durable relationship migration | Deferred with workspace design | Export/back up nodes, links and project memberships, prove restore/parity, switch readers, then remove predecessor infrastructure. |
| Prior local Neo4j test-contact delta | Needs prior backup/export | R3 source audit established that the earlier successful startup included a destructive Bubble reindex query; the earlier no-deletion statement was unsupported and has been corrected. Compare against an earlier snapshot before any proposed repair. Default tests now block the real graph-client factory. Never infer lost data or safe cleanup from IDs alone. |
| Legacy plain project definitions still retain settings/IDs in SQLite until a managed update | Controlled migration follow-up | Back up SQLite and project files; inventory definitions lacking ravenProject metadata, dry-run existing metadata writer with cache values, validate IDs/body preservation, then apply and prove a fresh-cache rebuild. Do not discard the existing database before that migration. New managed definitions already carry their identity/settings. |
| Process interruption between project filesystem and SQLite changes | Recovery follow-up | Add startup detection for missing managed paths and unmatched archive snapshots, report conflicts without deleting data, then exercise process-kill fault injection around each mutation boundary and a deterministic restore/complete operation. Current compensation covers handled failures; no cross-store power-loss atomicity is claimed. |
| Knowledge files and graph disagree after interrupted CRUD or manual file removal | Recovery follow-up | Preserve durable files and unmatched graph records; reject stale file identity claims in CRUD. Add a read-only reconciliation report with file/graph IDs and paths, backed-up explicit repair choices, and interruption tests around graph/file mutation boundaries. A graph deletion already in flight at shutdown may complete while its file is retained for recovery. Do not automatically prune unmatched records. |
| Externally edited knowledge files retain prior embeddings/chunks during routine reindex | Retrieval follow-up | Add content hashes and change-aware derived-index refresh while preserving durable graph links and project memberships; test edited-file retrieval and failed refresh retries. Existing explicit reindex-embeddings endpoint regenerates chunks; routine reindex currently refreshes file fields/tags and preserves graph metadata. |
| GitHub reported dependency alerts during checkpoint push | Dependency audit in R6 | Inspect current lockfile audit and primary advisories, apply compatible updates with regression/build evidence or record package/version, exposure and a bounded upgrade plan. The remote reported 10 high and 4 moderate alerts; these are not yet a verified runtime impact assessment. |
| Live Claude/account canary | Separate from isolated verification | Use an explicitly chosen disposable task/account destination after deterministic tests; verify authentication, SDK resume, MCP scope and delivery with recorded outcomes. No outbound messages are authorized by this testing pass. |

No issue is closed merely because a fake model returned a successful result.
Record what the automated boundary actually exercised.
