---
title: Reliable project conversations in Telegram
type: feature
created: 2026-09-06
status: complete
baseline_commit: 8f531b0
context:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - personal-assistant-next-steps-2026-09-06.md
---

# Reliable project conversations in Telegram

## Authorized scope

The owner approved the first three P0 product priorities: project Telegram,
session model/thinking controls, and readiness/phone access, plus the official
TickTick MCP with usable instructions. Deliver these as sequential reviewed
slices. The first slice combines T0/T1 because reliable routing and delivery
belong to the same conversation experience. Continue with M0, O0 and A2 afterward;
do not stop after completing this slice. Preserve unrelated working-tree files.
The existing roadmap and explicit implementation request supply scope approval.

## Intent

**Problem:** Telegram mixes agent/category topics with projects, loses session
ownership, can publish unrelated completions, and can mark failed sends delivered.
The owner cannot reliably understand or resume project work there.

**Approach:** Use stable project bindings and existing Raven sessions. Agents sign
their contributions inside a project conversation. General is Inbox / Today.
Persist delivery outcomes and reply associations in operational SQLite so restart
cannot silently change a conversation's meaning. Keep private bot chat usable.

## Boundaries and constraints

Always preserve existing capability, project access, cancellation and budget
checks. Persist operational data in the current atomic initial schema; do not
build legacy migrations. Use existing session/task/notification paths. Notify
only the originating address or an explicitly configured background destination.
Do not send live Telegram messages during automated tests. Do not read owner
transcripts, private projects or secrets into test fixtures. An API acknowledgement
does not establish that a person read a message. Unknown remote outcomes stay
unknown; avoid blind retries that duplicate already accepted messages.

Model selectors and remote HTTPS configuration are subsequent slices. Provide
clean integration points for their commands and artifact links. Do not add a
second scheduler, task store or notification engine. Retire agent-topic routing
when project routing replaces it. Keep stopped services free of owned work.

## I/O and edge cases

| Scenario              | Input/state                                | Expected behavior                                                            |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Project message       | Bound forum topic                          | Stable project and selected Raven session; attributable result returns there |
| Older reply           | Reply to known result after restart        | Resume originating session, not whichever conversation is newest             |
| New conversation      | `/new` in bound project                    | Fresh session with shared project context                                    |
| Private chat          | No forum topic                             | Explicit project selection and persisted session continuity                  |
| Unknown/deleted topic | Missing binding or Telegram rejects thread | Visible routing error; never silently spill project content into General     |
| Concurrent work       | Two tasks in one project                   | Separate task-correlated progress and correct final results                  |
| Other transport       | Browser or unrelated background completion | No Telegram post without explicit notification destination/policy            |
| Send failure          | Both formatting attempts rejected          | Failed outcome with sanitized reason; no delivered timestamp                 |
| Timeout               | Provider may have accepted                 | Unknown outcome visible; reconcile before replay                             |
| Partial attachment    | Text succeeds, file fails                  | Retain success evidence and expose partial failure                           |
| Restart               | Pending send/reply association exists      | Preserve evidence and addressing; no automatic duplicate side effect         |

## Code map and execution

- [ ] `packages/core/src/services/notifications/telegram-bot.ts` and `topic-store.ts`:
      replace category/agent-derived project identity with persistent unique project
      bindings; restore bindings, retain session/reply identity, implement project and
      new-conversation controls, attribute agent results and correlate progress by task.
- [ ] `packages/shared/src/types/events.ts`, session/orchestrator/AgentManager
      admission and completion paths: propagate trusted transport origin and task,
      project/session identity without accepting arbitrary cross-project resume.
- [ ] `packages/core/src/notification-engine/notification-queue.ts`, delivery
      scheduler, intent/proactive producers: return explicit outcomes, retain bounded
      attempts and provider IDs, carry destination project consistently. Inventory
      producers; global notifications must explicitly declare global destination.
- [ ] `migrations/001-initial-schema.sql` and notification/session fixtures:
      extend only current operational schema and preserve atomic initialization.
- [ ] Existing notification API/dashboard: expose failed/unknown delivery,
      destination, attempt count and sanitized error so failures are actionable.
- [ ] Existing notification, session and composed test files: reproduce failure
      paths before repair and prove isolation, restart, concurrent tasks and scope.
- [ ] Update deployment/Telegram guidance and completion evidence; parent reviews,
      runs required checks and commits/pushes the completed slice.

## Acceptance

- Given renamed projects or identical display names, when routing after restart,
  then stable project IDs preserve ownership and histories.
- Given forum or private chat, when the owner starts or resumes work, then the
  corresponding Raven session receives input and result attribution is accurate.
- Given an unrelated completion, when no notification policy targets Telegram,
  then no Telegram API call occurs.
- Given failed, uncertain or partially accepted delivery, when inspected through
  the API/dashboard, then it never appears as fully delivered and known evidence
  survives restart.
- Given a result artifact, when opened in an isolated mobile viewport through
  the existing local artifact route, then its project authorization is preserved.
  Actual remote-device access belongs to O0 and does not block this local check.
- Given service stop/restart, when delayed callbacks finish, then disposed stores
  are not written and owned listeners/tasks do not duplicate.
- Given a configured owner, messages, media and callbacks require both the owner
  identity and the configured chat; unrelated group activity cannot enter a
  private conversation. Duplicate incoming message IDs cannot start duplicate work.
- Given an explicit topic rebind, former project routing is invalidated before
  another notification can use it. General and System retain their reserved roles.
- Given a rapid rejection or completion before the processing acknowledgement
  returns, no stale processing message remains. Auxiliary sends join service drain.
- Given malformed initial-schema SQL or an incompatible existing database, startup
  fails clearly without committing a partially accepted initial schema or resetting
  existing data; verify the actual schema version inside the initialization transaction.

## Verification

Run focused Vitest notification/session/composed tests with fake Telegram and
temporary roots, `npm run check`, the default suite, and build/compiled restart
when runtime/schema boundaries change. Use the browser-testing skill for affected
dashboard/mobile journeys. Real account delivery remains a separately reported
canary; fake provider tests cannot prove it.

## Progress

- 2026-09-06: Scope authorized; current source and roadmap examined. No legacy
  migration or broader life-planning feature work is included in this slice.

Parent review and verification: [completed evidence](p0-project-telegram-review.md).
