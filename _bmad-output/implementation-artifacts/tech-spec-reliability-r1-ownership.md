---
title: Enforce existing project ownership boundaries
created: 2026-09-05
type: bugfix
status: done
baseline_commit: e7e0ed5
context: [AGENTS.md, ARCHITECTURE.md]
---

# R1 — Project ownership in existing APIs and chat

The owner authorized sequential reliability fixes and their tests. This is the
first bounded task; it does not implement repository attachments.

## Intent

A route naming one project must never modify another project's source or resume
another project's session. Unknown parents and resources should produce clear
not-found responses, not SQLite foreign-key errors or silent mutation. Chat with
an explicit session ID must validate ownership before writing messages/changing
status or dispatching a model turn. A stale/missing explicit ID must not silently
create a different conversation.

## Tasks and boundaries

- Inspect `api/routes/project-knowledge.ts` and existing project/source/session
  APIs. Enforce parent existence and source ownership for GET/POST/PUT/DELETE
  data-source endpoints; wrong-parent source IDs behave as not found.
- Inspect `orchestrator/orchestrator.ts::handleUserChat` and chat HTTP/WS entry
  points. Reject mismatched/missing explicit session IDs at a shared boundary
  without silently resuming another project or leaving a user without feedback.
- Add regression API/event tests over temporary SQLite that verify stored state
  and dispatched outcomes. Preserve valid create/list/edit/delete and resume.
- Include the same parent invariant for session list/create routes and session
  cross-reference deletion (reviewed scope refinement during implementation).
- Keep public success shapes compatible. No authentication system, workspace
  schema, live services, or source corpus/indexing changes.

## Acceptance

- Given a source owned by project A, when project B addresses its ID for update
  or delete, then the request returns 404 and A's record is unchanged.
- Given a missing project, when source CRUD is requested, then a bounded 404 is
  returned without a foreign-key exception.
- Given a session in project A, when project B submits its ID, then no transcript,
  session status, or agent task is changed for A and the caller receives an error.
- Given an explicit unknown session, when chat is submitted, then it is rejected
  clearly; given no session ID, normal project session creation still works.
- Given a chat stream that has exceeded the 201-message WebSocket buffer, when
  another event or chat rejection arrives, then the dashboard consumes it once
  and continues showing rejection feedback.
- Given a session reference, when a session outside both reference endpoints
  requests deletion, then return 404 and retain the reference; either endpoint
  may delete the existing link.
- Existing tests and `npm run check` pass. Test credentials and files are isolated.

## Verification

Run focused affected Vitest files, source formatting/lint/type gates; report exact
commands, test counts, and any unresolved findings. No remote operations.

## Review fixes

- Independent review identified a saturated-buffer cursor bug that hid rejection
  feedback after 201 WebSocket messages. Chat now tracks the last consumed
  message object instead of the current buffer length, preserving the bounded
  buffer and consuming subsequent events without replay. Regression tests cover
  both rejection shapes after 250 events, batched arrivals, an evicted cursor,
  and a shorter replacement stream.
