---
title: Verify and repair current assistant journeys
created: 2026-09-05
type: bugfix
status: complete
baseline_commit: 255e181
context: [AGENTS.md, ARCHITECTURE.md]
---

# R5 — Usable chat, controls, learning and schedules

Review the existing August delivery against current code. Use outcome-based
tests and an isolated browser harness; fake model output is appropriate, while
real Telegram/account delivery and live-model quality remain separate canaries.

## Known issues to repair and cover

- Chat hook state must follow the active project/session. A late history request
  or another session's event must not replace/mix the current transcript or
  clear its running/error state. Rejected/disconnected sends must be visibly
  unsent or rolled back with the draft recoverable, rather than appearing saved.
  Test session switching and two sessions in one project during a running turn.
- Verify WebSocket disconnect cleanup: the current close handler schedules a
  reconnect even after intentional disconnect. Prevent orphan connections after
  navigation/unmount, and make disconnected send failure visible to callers.
- Inspect project ID URL encoding end to end. Registry IDs for nested projects
  contain `/`, while several API client calls and links interpolate raw IDs.
  Preserve identity; encode path segments consistently and verify nested project
  navigation, chat, source CRUD and ordinary project links through the browser.
- API client currently calls `res.json()` for every success, including bodyless
  deletes. Handle empty successful responses, and surface server-provided errors
  from refused deletes/updates. Verify the project lifecycle through the UI.
- Stop/cancel controls must reflect backend acceptance and terminal state.
  Pending approvals must resolve through existing permission policy and visibly
  leave the inbox. Exercise approve/deny and cancellation using a controllable
  fake backend and temporary DB, with no outbound integrations enabled.
- Core shutdown must stop accepting queued/running agent work and settle or
  cancel it before disposing SQLite/logging. AgentManager currently exposes
  per-task cancellation without a shutdown/drain API. Test a deferred fake
  backend so terminal events and absence of late writes are observable. R3's
  knowledge processor cleanup does not itself cancel external model tasks.

## Existing loops to assess

- Run isolated chat/resume, schedule hot-reload and template completion, memory
  retrospective→candidate→consolidation, intents budgets/cancellation, heartbeat
  silence and self-test health journeys. Strengthen assertions only where actual
  outcomes are missing; do not duplicate implementation with shallow tests.
- Reconcile old phase plans against shipped code and test evidence. `/task-trees`
  is a compatibility redirect to `/tasks`; manual tests should use the current
  task board and current controls, not treat the redirect as a missing feature.
- Add reproducible headless Playwright journeys with temporary isolated backend,
  explicit frontend API/WS endpoints, bounded startup/waits and cleanup. Prefer
  assertions on visible state and persisted outcomes. No production app reuse.
- Integrate the deterministic browser command into CI, with artifacts on failure.
  Keep manual owner-account canaries clearly identified and concretely planned.

## Completion evidence

Record reviewed paths, repaired defects, focused tests, browser journey results,
`npm run check`, and exact environmental limitations. Each remaining issue needs
a concrete next implementation/verification step in the deferred-work ledger.
Workspace attachments and project-memory ownership remain deferred by the owner.


## Delivered and reviewed

- Correlated chat acceptance follows successful transcript persistence; validation,
  capability and storage failures retain recoverable drafts. All streams use the
  Raven session ID; SDK session identity remains separate for resume.
- Shared chat state isolates sessions, preserves typed/rejected drafts, reconciles
  missed completions on reconnect, and waits for actual cancellation completion.
  Knowledge chat now uses this same flow instead of inventing a REST reply.
- Project URL segments decode/encode once; bodyless deletes, server failure
  details, project update acknowledgements, New Chat selection, and refused deletes
  work through the dashboard. Data sources remain usable with graph disabled.
- Orchestrator/manager and direct retrospective/heartbeat/consolidation work have
  stop admission, abort checkpoints, and local mutation drain. SDK bridges remove
  abort listeners on completion. Local MCP registration rejects calls after abort;
  already admitted MCP mutations remain an explicit follow-up.
- Voice requests own upload/poll/inference/deletion waits and suppress obsolete
  outputs across stop/restart. Maintenance uses current validators and refreshed
  skill definitions, correct roots/port, and disposable request waits. IMAP gating
  matches the implementation's actual credentials.
- Failed, malformed or partially applied memory consolidation retains candidates;
  successful application/indexing precedes archival. Schedule, intent cancellation,
  heartbeat silence and durable learning outcomes use real composed runtime paths.
- Added an isolated Playwright launcher and 11 durable browser journeys plus CI
  failure artifacts. Temporary roots and fresh child environments exclude owner
  configuration/integrations; occupied fixture ports are refused. Both HTTP and
  WebSocket destinations are restricted to the fixture. Live TickTick tests now
  require an explicit opt-in as well as credentials.

Independent reviews used the existing agents with their current context, plus
parent review. They were not fresh blind reviews. Findings repaired during review
included missed-completion reconnect, double URL encoding, generic Fastify error
labels, direct-loop shutdown, partial consolidation loss, and stale SDK test
assumptions. The browser creation test now waits for client-loaded data before
interacting with server-rendered controls.

## Verification

- Full suite: **184 files, 1971 passed, 6 explicitly skipped**
  (`/tmp/raven-r5-full-final.log`).
- `npm run check`: passed (`/tmp/raven-r5-check-complete.log`).
- All **11 headless browser journeys** passed
  (`/tmp/raven-r5-browser-complete.log`). A named CLI session also captured an
  accessibility snapshot and `.browser-test-output/r5-projects-loaded.png`.
  Its favicon 404 and subsequent dev-HMR reconnect failures after fixture teardown
  were not counted as successful interactions or production failures.
- Shared/core and production Webpack dashboard builds passed. The owner's exact
  `next-env.d.ts` bytes were restored after the build.
- Compiled smoke passed all 33 migrations, six actual services, fake chat,
  persistent definitions/memory/history and two natural process exits
  (`/tmp/raven-r5-compiled.log`).
- Focused evidence includes 26 voice tests, 41 heartbeat/consolidation/shutdown
  tests, 54 web state/API/transport tests, and eight SDK cancellation tests.
- All 87 original definition files remain byte-identical. Provider canaries,
  admitted MCP mutation drain and workspace/graph ownership follow-ups remain
  concrete entries in `deferred-work.md`.
