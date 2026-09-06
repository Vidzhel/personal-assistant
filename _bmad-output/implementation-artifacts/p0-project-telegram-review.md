# Telegram P0 review and verification

Scope: [T0/T1 specification](tech-spec-p0-project-telegram.md), baseline `8f531b0`.
Implementation and parent review complete. Owner work is excluded.
Automated evidence below uses temporary storage and fake providers.

## Independent review findings

The blind reviewer received only a diff. The edge-case reviewer and acceptance
auditor may trace current project source. The parent deduplicates findings and
checks the implementation and tests. The following are implementation repairs
within the approved scope; none requires a change to owner intent.

| ID | Finding and acceptance check | State |
| --- | --- | --- |
| B1 | Fresh messages can persist a pending binding before a session exists; test real SQLite in private and forum modes. | Verified by regression coverage below |
| B2 | Delayed acceptance cannot overwrite a newer `/new` or project selection; test event ordering. | Verified by regression coverage below |
| B3 | Completion revalidates the current topic's project after reassignment. | Repaired and regression verified |
| B4 | Restart preserves accepted attempt evidence even if aggregate status was not committed. | Verified by regression coverage below |
| B5 | Safely unattempted immediate notifications recover with exact original addressing; uncertain attempts are not replayed. | Verified by regression coverage below |
| B6 | Evidence-write errors after provider acceptance cannot be mistaken for definite provider rejection. | Verified by regression coverage below |
| B7 | Predispatch failures release temporary input reservations so a redelivered message can proceed. | Verified by regression coverage below |
| B8 | Completed input reservations do not accumulate without a bound in memory. | Verified by regression coverage below |
| B9 | Repeated command updates do not create duplicate `/new` sessions. | Verified by regression coverage below |
| B10 | Attachment inspection races after text acceptance produce immediate partial outcomes. | Verified by regression coverage below |
| B11 | Fractional/invalid diagnostics limits do not reach SQLite as invalid limits. | Verified by regression coverage below |
| B12 | Diagnostics describe Telegram evidence and distinguish waiting/included states from failed sends. | Verified by regression coverage below |
| B13 | Abort and unclassified transport failures retain uncertainty unless Telegram definitively rejected the request. | Verified by regression coverage below |
| B14 | Telegram commands with an addressed bot suffix behave as commands. | Verified by regression coverage below |
| P1 | General/private Inbox routing works on a clean deployment without owner-local untracked projects; prove first message through the composed orchestrator and fake backend. | Verified by regression coverage below |
| E1 | Older General/System replies use reserved project ownership rather than requiring an ordinary project-topic row. | Verified by regression coverage below |
| E2 | Inbox project notifications use General and cannot create a duplicate Inbox topic. | Verified by regression coverage below |
| E3 | Failed processing acknowledgements do not prevent otherwise valid chat dispatch. | Verified by regression coverage below |
| E4 | Failed voice/media downloads and transcription emit correlated rejection and clear pending/status state. | Verified by regression coverage below |
| E5 | Service stop cancels and bounds provider/download waits without late writes into disposed stores. | Verified by regression coverage below |
| E6 | Manual retrospective requests receive a terminal Telegram response instead of leaving processing indefinitely. | Verified by regression coverage below |
| E7 | Web-only escalation notifications do not repeat indefinitely after Telegram claim ownership changes. | Verified by regression coverage below |
| E8 | Unsnoozed immediate and batched notifications return to a delivery state with an actual consumer. | Verified by regression coverage below |
| E9 | Deferred System notifications retain their destination and are not stranded by the General-only briefing filter. | Verified by regression coverage below |
| E10 | Accepted reply evidence can recover a missing historical reply binding across a crash between local writes. | Verified by regression coverage below |
| A1 | Execution-tree notification nodes use ordinary delivery admission with durable destination and evidence. | Repaired and regression verified |
| A2 | Callback dependencies are rebuilt on service restart; callbacks cannot retain disposed prior stores or a detached event bus. | Repaired and regression verified |

## Parent review and browser evidence

- Reviewed producer routing, sender checks, rebind invalidation, voice/media
  session continuity, shutdown ownership, atomic schema compatibility and delivery
  claim ordering. Follow-up fixes are under regression verification.
- Initial compiled core build and restart check passed, including two clean exits
  and retained definitions, memory and conversation history in temporary storage.
- Initial isolated browser run: 21 of 22 journeys passed. Project deletion failed
  with `no such column: scope`; a remaining lifecycle reference query used the
  retired Telegram schema. The implementation agent repaired that query and its
  fixture; rerun pending.
- Both initial delivery diagnostics journeys passed: four actual API-backed
  outcomes and a visible fetch failure. Manual Playwright CLI inspection confirmed
  390px page width at a 390px viewport, but the table obscured error details behind
  horizontal scrolling. Small-screen cards and a full-error viewport assertion
  replace that layout; rerun pending.
- The default suite and final required check are still pending. Fake provider and
  local browser results do not prove real Telegram account delivery.

## Final verification — September 6

- `npm run check`: passed (format, lint, shared/core types, 253 production
  strip-types checks, dependency guard).
- `npm test`: 245 files passed, 2,522 tests passed and six explicit live skips.
  The subsequently added accepted-reply crash recovery test also passed; the
  final Telegram bot file passed all 84 tests with scoped lint/format checks.
- `npm run build`: shared/core, TickTick workspace and production Next dashboard
  passed. Restored the owner's exact pre-build `next-env.d.ts` afterward.
- `npm run test:compiled`: passed with two clean exits and retained definitions,
  memory and conversation history in temporary storage.
- All 22 isolated Playwright journeys passed, including repaired empty-project
  deletion, mobile delivery evidence and a visible diagnostics fetch failure.
  Parent visually reviewed the 390px mobile screenshot: complete error text and
  provider IDs are readable without horizontal scrolling.
- `npm run test:deployment`: 10 tests passed, including the new public Inbox seed.
- Docker context verification could not run: this WSL environment reports Docker
  unavailable, including outside the restricted runner. No container validation
  or live Telegram account delivery is claimed for this slice.

Coverage mapping: conversation-store tests prove B1/B2; bot regressions cover
B2/B3/B5–B10/B13/B14, E1–E5/E10 and A2. Queue tests prove B4 and interrupted
claims without replay. API/browser tests cover B11/B12. The composed Telegram
journeys prove P1 and E6 through real grammY update handling, orchestration,
SessionManager, AgentManager, SQLite and filesystem definitions. Engagement tests
cover E7. Queue/scheduler and briefing tests cover E8/E9, including the parent
repair preserving origin/session/task through snooze admission and flush.
Execution integration and composed schedule tests cover A1 through ordinary
notification admission; they do not substitute local dispatch for remote receipt.

## Operational follow-up

An actual owner account canary remains deliberate setup work: send a harmless
message in private chat and a bound forum topic, check the correct project and
reply, and compare its provider ID with Settings. Repeat with `/new` and an older
reply. Never manufacture account delivery evidence from fake transport tests.
Run `npm run test:docker-context` when Docker is available. Neither check requires
or authorizes resetting an existing operational database.
