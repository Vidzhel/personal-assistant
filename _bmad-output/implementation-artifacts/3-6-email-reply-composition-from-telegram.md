# Story 3.6: Email Reply Composition from Telegram

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the mobile user,
I want to compose and send email replies through Raven from Telegram,
So that I can handle email without opening Gmail.

## Acceptance Criteria

1. **Draft Composition via Natural Language** — Given the user sends "Reply to the client email, tell them I'll have it ready by Thursday", When Raven processes the intent, Then a draft reply is composed and presented in Telegram with `[Send] [Edit] [Cancel]` buttons.

2. **Send with Approval** — Given the user taps "Send", When the Gmail skill sends the email, Then the permission gate is checked (red-tier `gmail:reply-email`), the email is sent after approval, and confirmation is shown in Telegram.

3. **Edit Flow** — Given the user taps "Edit", When the edit flow starts, Then the user can provide corrections and a new draft is presented with the same `[Send] [Edit] [Cancel]` buttons.

4. **Cancel Flow** — Given the user taps "Cancel", When the cancel action is processed, Then the draft is discarded and the user receives a confirmation message.

5. **Red-Tier Approval** — Given email sending is Red-tier, When the user taps "Send", Then the action queues for approval and the user is notified it's pending via the existing approval flow.

## Tasks / Subtasks

- [x] Task 1: Create reply-composer service in email suite (AC: #1, #3, #4)
  - [x] 1.1 Create `suites/email/services/reply-composer.ts` implementing `SuiteService`
  - [x] 1.2 Subscribe to `email:reply:start` events (emitted by callback handler)
  - [x] 1.3 On start: fetch original email context via agent manager (gmail-agent with `gmail:get-email` action) — retrieve from, subject, snippet, messageId
  - [x] 1.4 If user provided reply intent text (from natural language command): compose draft via gmail-agent sub-agent with prompt including original email context + user instructions
  - [x] 1.5 If user tapped Reply button (no intent text): compose draft via gmail-agent with just the original email context, asking agent to draft a contextual reply
  - [x] 1.6 Emit `notification` event with the draft preview + `[Send] [Edit] [Cancel]` inline keyboard to the originating topic
  - [x] 1.7 Store pending draft state: `{ emailId, draftText, topicId, messageId }` in module-level Map keyed by a compositionId
  - [x] 1.8 On `stop()`: clear pending drafts Map, unsubscribe from events

- [x] Task 2: Add email reply event types and callback routing (AC: #1, #2, #3, #4)
  - [x] 2.1 Add event types to `packages/shared/src/types/events.ts`: `email:reply:start` (payload: emailId, userIntent?, topicId?, topicName?), `email:reply:send` (payload: compositionId), `email:reply:edit` (payload: compositionId, newInstructions), `email:reply:cancel` (payload: compositionId)
  - [x] 2.2 Update callback-handler.ts `handleEmailAction` for `reply` action: emit `email:reply:start` event (NOT `user:chat:message`) with emailId from callback data
  - [x] 2.3 Add new callback data patterns for reply actions: `er:s:{compositionId}` (send), `er:e:{compositionId}` (edit), `er:c:{compositionId}` (cancel)
  - [x] 2.4 Add handler functions for send/edit/cancel callbacks in callback-handler.ts
  - [x] 2.5 Send callback emits `email:reply:send` → reply-composer handles by triggering gmail-agent with `gmail:reply-email` action (goes through permission gate)
  - [x] 2.6 Edit callback emits `email:reply:edit` → reply-composer prompts user for corrections (emit notification asking for new instructions, listen for next `user:chat:message` with compositionId context)
  - [x] 2.7 Cancel callback emits `email:reply:cancel` → reply-composer clears draft from Map, emits confirmation notification

- [x] Task 3: Handle natural language reply intent from orchestrator (AC: #1)
  - [x] 3.1 Update orchestrator raven-orchestrator.ts or productivity-coordinator.ts agent prompt to recognize email reply intents and route appropriately
  - [x] 3.2 When user sends "Reply to [email], tell them [content]" via Telegram chat, the orchestrator should emit `email:reply:start` with userIntent containing the reply instructions
  - [x] 3.3 The gmail-agent fetches the email context, then reply-composer composes the draft using the user's intent text

- [x] Task 4: Gmail agent prompt enhancement for reply composition (AC: #1, #3)
  - [x] 4.1 Update `suites/email/agents/gmail-agent.ts` prompt to include reply composition instructions
  - [x] 4.2 Agent must: fetch original email (use `gmail:get-email`), compose a professional reply incorporating user instructions, return structured JSON: `{ emailId, to, subject, draftBody, originalSnippet }`
  - [x] 4.3 Agent must maintain proper email threading (In-Reply-To, References headers handled by Gmail MCP)

- [x] Task 5: Permission gate integration for reply sending (AC: #2, #5)
  - [x] 5.1 When reply-composer receives `email:reply:send`, it calls agent manager with `gmail:reply-email` action
  - [x] 5.2 The existing permission gate in agent-session.ts will block as red-tier → emits `permission:blocked`
  - [x] 5.3 Existing Telegram approval flow handles: shows `[Approve] [Deny]` buttons
  - [x] 5.4 On approval: agent executes `gmail:reply-email` via Gmail MCP → confirmation notification sent
  - [x] 5.5 On deny: reply-composer notifies user "Reply cancelled by approval denial"

- [x] Task 6: Register reply-composer service in email suite (AC: all)
  - [x] 6.1 Add `services` capability to `suites/email/suite.ts` if not present
  - [x] 6.2 Create `suites/email/services/` directory
  - [x] 6.3 Register `reply-composer` in suite manifest services array
  - [x] 6.4 Ensure service starts/stops correctly during suite lifecycle

- [x] Task 7: Tests (AC: all)
  - [x] 7.1 Create `suites/email/__tests__/reply-composer.test.ts` — test draft composition flow, event handling, pending state management
  - [x] 7.2 Test send callback → permission gate flow (mock agent manager, verify `gmail:reply-email` action passed)
  - [x] 7.3 Test edit callback → re-compose with corrections
  - [x] 7.4 Test cancel callback → draft cleared, confirmation sent
  - [x] 7.5 Extend `suites/notifications/__tests__/callback-handler.test.ts` with reply-specific callback tests (er:s:, er:e:, er:c:)
  - [x] 7.6 Test edge cases: email not found, empty reply, draft expired, concurrent reply attempts
  - [x] 7.7 Test natural language intent routing (orchestrator emits email:reply:start with userIntent)

## Dev Notes

### Architecture Constraints

- **This creates a new service in the `suites/email/` suite** — the email suite already has imap-watcher.ts as a service. Reply-composer is a second service that handles the interactive reply composition flow.
- **Event-driven composition** — The reply flow is: callback button → `email:reply:start` event → reply-composer service → gmail-agent (fetches email + composes draft) → `notification` event → Telegram (shows draft + buttons) → callback button → `email:reply:send` → gmail-agent (sends via Gmail MCP, gated by permission) → confirmation notification.
- **No direct Telegram API calls from email suite** — reply-composer emits `notification` events; the existing notification subscriber in telegram-bot.ts handles delivery with inline keyboard. Same pattern as briefing-formatter.
- **No classes** — reply-composer exports a `SuiteService` object with `start()/stop()` methods (same pattern as media-router, imap-watcher, briefing-formatter).
- **MCP isolation preserved** — reply-composer does NOT use Gmail MCP directly. It delegates to agent manager which spawns gmail-agent sub-agent with Gmail MCP tools.
- **Permission gating is automatic** — The `gmail:reply-email` action is red-tier in `actions.json`. When agent-session.ts encounters this action, it blocks and queues for approval. No new permission logic needed.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Gmail agent | `suites/email/agents/gmail-agent.ts` | **EXTEND** prompt for reply composition |
| Email actions | `suites/email/actions.json` | **USE** existing `gmail:reply-email` (red), `gmail:get-email` (green) |
| IMAP watcher | `suites/email/services/imap-watcher.ts` | **REFERENCE** service pattern |
| Email suite | `suites/email/suite.ts` | **EXTEND** with services array |
| Callback handler | `suites/notifications/services/callback-handler.ts` | **EXTEND** with reply composition callbacks (er:s:, er:e:, er:c:) |
| Email callback parsing | `suites/notifications/services/callback-handler.ts:275-296` | **MODIFY** `e:r:` handler to emit `email:reply:start` instead of `user:chat:message` |
| buildInlineKeyboard | `suites/notifications/services/telegram-bot.ts:49-63` | **USE** for draft preview buttons |
| sendMessageWithFallback | `suites/notifications/services/telegram-bot.ts:139-158` | **USE** via notification events |
| Permission gate | `packages/core/src/agent-manager/agent-session.ts:66-135` | **USE** — enforces red-tier for `gmail:reply-email` |
| Approval flow | `suites/notifications/services/callback-handler.ts` | **USE** — handles `a:y:` / `a:n:` approval callbacks |
| Briefing formatter | `suites/daily-briefing/services/briefing-formatter.ts` | **REFERENCE** — pattern for event-driven service with notification emission |
| NotificationEvent | `packages/shared/src/types/events.ts:89-98` | **USE** — `channel`, `title`, `body`, `topicName`, `actions` |
| AgentManager.executeApprovedAction | `packages/core/src/agent-manager/` | **USE** for fire-and-forget email operations |
| Constants | `packages/shared/src/suites/constants.ts` | **USE** — add new constants for email reply events |
| generateId() | `packages/shared/src/utils/id.ts` | **USE** — `crypto.randomUUID()` |
| createLogger() | `packages/shared/src/utils/logger.ts` | **USE** — Pino logger |

### Reply Composition Flow Architecture

```
Option A: User taps Reply button on email in briefing/notification
  │
  │ callback_data: e:r:emailId123
  │
  ▼
Callback Handler (callback-handler.ts)
  │ MODIFIED: emit email:reply:start (was: user:chat:message)
  │ payload: { emailId: 'emailId123', topicId, topicName }
  ▼
Reply Composer Service (NEW - suites/email/services/reply-composer.ts)
  │ subscribes to email:reply:start
  │ 1. Generate compositionId (crypto.randomUUID)
  │ 2. Store { emailId, compositionId } in pendingDrafts Map
  │ 3. Fetch email via agent manager → gmail-agent (get-email, green-tier)
  │ 4. Compose draft via gmail-agent (generate contextual reply)
  │ 5. Store draft text in pendingDrafts
  │ 6. Emit notification with draft preview + [Send] [Edit] [Cancel] buttons
  │    callback_data: er:s:{compId}, er:e:{compId}, er:c:{compId}
  ▼
Telegram Bot (existing notification subscriber)
  │ delivers draft preview with inline keyboard
  ▼
User taps [Send]
  │ callback_data: er:s:{compId}
  ▼
Callback Handler → emits email:reply:send { compositionId }
  ▼
Reply Composer
  │ retrieves draft from pendingDrafts Map
  │ calls agent manager with gmail:reply-email action
  │ → Permission gate blocks (RED tier)
  │ → Approval queued, Telegram shows [Approve] [Deny]
  │ → On approve: gmail-agent sends reply via Gmail MCP
  │ → Emit confirmation notification
  │ → Clear from pendingDrafts
```

```
Option B: User sends natural language "Reply to client email, say I'll be ready Thursday"
  │
  ▼
Telegram Bot → user:chat:message
  ▼
Orchestrator → raven-orchestrator → productivity-coordinator
  │ recognizes email reply intent
  │ emits email:reply:start { emailId: (resolved by agent), userIntent: "tell them I'll be ready Thursday" }
  ▼
Reply Composer (same flow as above, but uses userIntent for draft composition)
```

### Key Design Decisions

1. **Dedicated email:reply events** — Rather than overloading `user:chat:message` with email reply context (current placeholder), dedicated events (`email:reply:start`, `email:reply:send`, `email:reply:edit`, `email:reply:cancel`) make the flow explicit and testable.

2. **Reply-composer as email suite service** — Lives in `suites/email/services/` because it's email domain logic. The notifications suite handles delivery (Telegram), but composition logic belongs with email.

3. **Module-level Map for pending drafts** — Same stateless-service pattern as media-router. Drafts are ephemeral — if the process restarts, users re-initiate. No DB persistence needed for drafts.

4. **Composition ID in callback_data** — Using `er:s:{compId}` (12 chars + UUID truncated to fit 64-byte limit). Truncate compositionId to first 8 chars of UUID for callback_data (Map lookup still works with prefix match or use short IDs).

5. **Agent-mediated draft composition** — The gmail-agent composes the draft (not a hardcoded template). This gives AI-quality replies that match the user's communication style and the email context.

6. **Edit flow re-composes** — When user taps Edit and provides new instructions, the gmail-agent re-composes (doesn't try to patch). Simpler, more reliable.

### Callback Data Format (64-byte limit)

```
er:s:{8-char-id}   → Send draft     (max 13 bytes)
er:e:{8-char-id}   → Edit draft     (max 13 bytes)
er:c:{8-char-id}   → Cancel draft   (max 13 bytes)
```

Use first 8 chars of compositionId UUID. Store full UUID in pendingDrafts Map, match by prefix.

### NFR Compliance

- **NFR14:** Telegram delivery retries handled by existing sendMessageWithFallback
- **NFR21:** Inline keyboard responses within 2 seconds — reuse existing callback handler patterns
- **Permission system:** `gmail:reply-email` red-tier enforced via existing permission gate, no new logic

### Previous Story Learnings (3.5 — Morning Briefing Delivery)

- **Event-driven services** — briefing-formatter is the template: subscribe on start, validate payload, emit notification event, unsubscribe on stop
- **Notification event emission** — Use `channel: 'telegram'`, `topicName`, `title`, `body`, `actions[]` for inline keyboard
- **Callback data patterns** — Email callbacks exist (`e:r:`, `e:a:`, `e:f:`). Reply composition adds `er:s:`, `er:e:`, `er:c:` (different domain prefix)
- **Zod validation** — Always validate event payloads with `safeParse()` before processing
- **Error handling** — All error paths must have user-visible feedback or logging
- **Test patterns** — Mock eventBus with vi.fn(), capture event handler references, verify emission payloads
- **vi.mock at module scope** — Vitest hoists mocks; put them at file top, not in beforeEach
- **Code review fixes from 3.5** — H1: always set notification `title` field. H2: don't gate actions behind irrelevant conditions. H3: name functions descriptively

### Git Intelligence (Recent Commits)

Last commits show Epic 3 progression:
- `21d1103` feat: morning briefing delivery via Telegram (story 3.5) + code review fixes
- `51a4809` feat: media & file routing via Telegram (story 3.4)
- `4bc38ec` feat: WIP gemini voice transcription suite (story 3.3) + telegram voice forwarding
- `98ed123` feat: inline keyboard actions & approvals (story 3.2) + code review fixes

Commit message format: `feat: <description> (story X.Y)` — follow for story 3.6.

Files from story 3.5 that inform 3.6 patterns:
- `suites/daily-briefing/services/briefing-formatter.ts` — SuiteService pattern with event subscription + notification emission
- `suites/notifications/services/callback-handler.ts` — email callback domain (`e:r:`, `e:a:`, `e:f:`)
- `suites/daily-briefing/__tests__/briefing-formatter.test.ts` — test patterns for event-driven services

### Project Structure Notes

- **Modified files:**
  - `suites/email/suite.ts` — add services capability and register reply-composer
  - `suites/email/agents/gmail-agent.ts` — enhanced prompt for reply composition
  - `suites/notifications/services/callback-handler.ts` — modify `e:r:` handler, add `er:s:`, `er:e:`, `er:c:` handlers
  - `packages/shared/src/types/events.ts` — add email reply event types
  - `packages/shared/src/suites/constants.ts` — add reply event constants (if needed)
- **New files:**
  - `suites/email/services/reply-composer.ts` — reply composition service
  - `suites/email/__tests__/reply-composer.test.ts` — reply composer tests
- **Alignment:** All new files follow kebab-case naming, SuiteService pattern, ESM imports with `.ts` extensions

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 3, Story 3.6]
- [Source: _bmad-output/planning-artifacts/epics.md — FR40: User can compose and send email replies via Raven from Telegram]
- [Source: _bmad-output/planning-artifacts/architecture.md — MCP Isolation, Sub-agent delegation, Permission gates]
- [Source: _bmad-output/implementation-artifacts/3-5-morning-briefing-delivery.md — previous story learnings, event-driven service patterns]
- [Source: suites/email/agents/gmail-agent.ts — existing gmail agent]
- [Source: suites/email/actions.json — gmail:reply-email (red), gmail:get-email (green)]
- [Source: suites/email/services/imap-watcher.ts — SuiteService pattern in email suite]
- [Source: suites/notifications/services/callback-handler.ts — email callback handling, parseCallbackData]
- [Source: suites/notifications/services/telegram-bot.ts — notification subscriber, buildInlineKeyboard, sendMessageWithFallback]
- [Source: packages/core/src/agent-manager/agent-session.ts — permission gate enforcement]
- [Source: packages/core/src/orchestrator/orchestrator.ts — handleUserChat routing]
- [Source: packages/shared/src/types/events.ts — NotificationEvent, UserChatMessageEvent]
- [Source: _bmad-output/project-context.md — coding conventions and critical rules]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Task 1: Created `suites/email/services/reply-composer.ts` — SuiteService implementing the full reply composition flow. Subscribes to email:reply:start/send/edit/cancel events. Uses `config.agentManager` (lazy resolution) to delegate to gmail-agent for email fetching and draft composition. Module-level Map for pending drafts with short ID (8-char UUID prefix) for callback data. Handles permission denial via `permission:denied` event listener.
- Task 2: Added 4 new event types (`EmailReplyStartEvent`, `EmailReplySendEvent`, `EmailReplyEditEvent`, `EmailReplyCancelEvent`) with Zod validation schemas. Added `er:` domain to callback-handler for reply composition callbacks. Modified `e:r:` handler to emit `email:reply:start` instead of `user:chat:message`. Added `handleEmailReplyAction` function for send/edit/cancel routing.
- Task 3: Updated raven-orchestrator and productivity-coordinator agent prompts to recognize email reply intents and route them through the email:reply:start event flow.
- Task 4: Enhanced gmail-agent prompt with reply composition instructions — structured JSON output format, tone matching, and threading guidance.
- Task 5: Reply-composer calls `agentManager.executeApprovedAction` with `gmail:reply-email` action (red-tier). Permission gate blocks automatically, approval flow presents [Approve/Deny]. Added `result` field to `executeApprovedAction` return type (backward-compatible) to enable draft composition results.
- Task 6: Registered `reply-composer` in email suite services array. Directory already existed.
- Task 7: Created 26 tests in reply-composer.test.ts covering all ACs. Extended callback-handler.test.ts with 7 new email-reply tests (45 total). All 486 tests pass, 0 regressions.

### Change Log

- 2026-03-15: Implemented story 3.6 — email reply composition from Telegram

### File List

**New files:**
- `suites/email/services/reply-composer.ts` — Reply composition service
- `suites/email/__tests__/reply-composer.test.ts` — 26 tests for reply composer

**Modified files:**
- `packages/shared/src/types/events.ts` — Added 4 email reply event types + Zod schemas
- `packages/shared/src/suites/constants.ts` — Added EVENT_EMAIL_REPLY_* constants
- `packages/shared/src/suites/index.ts` — Re-exported new constants
- `packages/core/src/agent-manager/agent-manager.ts` — Added `result` to executeApprovedAction return type
- `suites/notifications/services/callback-handler.ts` — Modified e:r: handler, added er: domain + handleEmailReplyAction
- `suites/notifications/__tests__/callback-handler.test.ts` — Updated e:r: test, added 7 email-reply tests
- `suites/email/agents/gmail-agent.ts` — Enhanced prompt for reply composition
- `suites/email/suite.ts` — Added reply-composer to services array
- `suites/_orchestrator/agents/raven-orchestrator.ts` — Updated prompt for email reply routing
- `suites/_orchestrator/agents/productivity-coordinator.ts` — Updated prompt for email reply intent handling
