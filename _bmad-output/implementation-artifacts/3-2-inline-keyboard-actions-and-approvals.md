# Story 3.2: Inline Keyboard Actions & Approvals

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the mobile user,
I want inline keyboard buttons for quick actions and approvals,
so that I can manage tasks and approve actions with a single tap.

## Acceptance Criteria

1. **Task Action Buttons on Briefing** — Given a morning briefing with overdue tasks, When each task is displayed, Then inline buttons appear: `[Complete] [Snooze 1d] [Snooze 1w] [Drop]`.

2. **Complete Task via Button** — Given the user taps "Complete" on a task, When the callback is processed, Then the task is marked complete in TickTick, the keyboard updates to show "Done ✓", and response arrives within 2 seconds (NFR21).

3. **Approval Notification Buttons** — Given a Red-tier approval notification, When delivered to Telegram, Then inline buttons appear: `[Approve] [Deny] [View Details]`.

4. **Approve via Button** — Given the user taps "Approve", When the callback is processed, Then the pending approval is resolved, the action executes, and confirmation is shown with updated keyboard.

5. **Deny via Button** — Given the user taps "Deny", When the callback is processed, Then the pending approval is denied, no action executes, and the keyboard updates to show "Denied".

6. **Snooze Task via Button** — Given the user taps "Snooze 1d" or "Snooze 1w" on a task, When the callback is processed, Then the task is snoozed in TickTick for the specified duration and the keyboard updates with confirmation.

7. **Drop Task via Button** — Given the user taps "Drop" on a task, When the callback is processed, Then the task is deleted/closed in TickTick and the keyboard updates to show "Dropped".

8. **View Details Button** — Given the user taps "View Details" on an approval, When the callback is processed, Then the full action details (skill name, action name, details text) are sent as a reply message.

9. **Callback Response Time** — Given any inline keyboard button tap, When the callback is processed, Then `answerCallbackQuery()` is called within 2 seconds to avoid Telegram's timeout spinner.

10. **Error Handling** — Given a callback action fails (TickTick API down, approval already resolved), When the error occurs, Then a user-friendly message is shown via `answerCallbackQuery({ text: 'Error: ...' })` and the message is NOT corrupted.

11. **Permission Tier Enforcement** — Given a callback action triggers a skill action (e.g., task:complete), When the action has a permission tier configured, Then the permission gate is checked before execution (Red-tier actions from callbacks should be rare since approvals themselves are already gated).

## Tasks / Subtasks

- [x] Task 1: Define callback data format and parsing (AC: #9, #10)
  - [x] 1.1 Define callback data string format: `action:target[:arg1[:arg2]]` — e.g., `task:complete:taskId123`, `task:snooze:taskId123:1d`, `approval:approve:approvalId456`, `approval:deny:approvalId456`, `approval:details:approvalId456`
  - [x] 1.2 Create `parseCallbackData(data: string): CallbackAction | null` function in `suites/notifications/services/callback-handler.ts` — returns structured object `{ action: string, target: string, args: string[] }` or null on parse failure
  - [x] 1.3 Define `CallbackAction` type in `packages/shared/src/types/events.ts` (or inline in callback-handler)
  - [x] 1.4 Telegram callback_data has a **64-byte limit** — ensure all action strings fit within this constraint. Use short prefixes: `t:c:`, `t:s:`, `t:d:`, `a:y:`, `a:n:`, `a:v:` if IDs are long

- [x] Task 2: Build callback action router (AC: #1-#8)
  - [x] 2.1 Create `suites/notifications/services/callback-handler.ts` — exported function `handleCallback(action: CallbackAction, ctx: CallbackQueryContext, deps: CallbackDeps): Promise<CallbackResult>`
  - [x] 2.2 Define `CallbackDeps` interface: `{ eventBus, db, agentManager, logger }` — injected at service startup
  - [x] 2.3 Define `CallbackResult` type: `{ success: boolean, message: string, updatedKeyboard?: InlineKeyboardMarkup }`
  - [x] 2.4 Route by action prefix: `task:*` → handleTaskAction, `approval:*` → handleApprovalAction
  - [x] 2.5 All handlers return within 2 seconds — use `answerCallbackQuery()` immediately with "Processing..." and then edit the message asynchronously if the action takes longer

- [x] Task 3: Implement task action handlers (AC: #2, #6, #7)
  - [x] 3.1 `handleTaskComplete(taskId: string)` — emit event to orchestrator requesting TickTick task completion via sub-agent, OR call the approval route's execute pattern directly
  - [x] 3.2 `handleTaskSnooze(taskId: string, duration: string)` — emit event to orchestrator requesting TickTick task snooze
  - [x] 3.3 `handleTaskDrop(taskId: string)` — emit event to orchestrator requesting TickTick task deletion
  - [x] 3.4 **Sub-agent execution path**: Task callbacks need to spawn a TickTick sub-agent to perform the MCP action. Use `agentManager.executeTask()` or the orchestrator's agent session to run the TickTick agent with a specific instruction (e.g., "Complete task with ID {taskId}")
  - [x] 3.5 On success: edit the original message to update the inline keyboard — replace action buttons with confirmation text (e.g., `[Done ✓]`)
  - [x] 3.6 On failure: `answerCallbackQuery({ text: 'Failed: ...' })` — do NOT edit the message so user can retry

- [x] Task 4: Implement approval action handlers (AC: #3, #4, #5, #8)
  - [x] 4.1 `handleApprovalApprove(approvalId: string)` — call `pendingApprovals.resolve(id, 'approved')` directly (the resolve method already handles agent execution and audit logging)
  - [x] 4.2 `handleApprovalDeny(approvalId: string)` — call `pendingApprovals.resolve(id, 'denied')`
  - [x] 4.3 `handleApprovalDetails(approvalId: string)` — query `pendingApprovals` by ID, send details as a reply message (not a message edit)
  - [x] 4.4 On resolve success: edit original message keyboard to show `[Approved ✓]` or `[Denied ✗]`
  - [x] 4.5 Handle edge case: approval already resolved (race condition with dashboard) — show "Already resolved" message
  - [x] 4.6 **Critical**: Approval resolution MUST use the existing `pendingApprovals.resolve()` method to maintain audit trail consistency. Do NOT bypass with direct DB updates.

- [x] Task 5: Enhance telegram-bot notification handler to render inline keyboards (AC: #1, #3)
  - [x] 5.1 In the `notification` event handler in `telegram-bot.ts`: when `event.payload.actions` array is present and non-empty, build an `InlineKeyboard` from the actions
  - [x] 5.2 Map each action in the array to a grammy `InlineKeyboard` button: `{ text: action.label, callback_data: action.action }`
  - [x] 5.3 Layout strategy: 2 buttons per row for task actions (`[Complete] [Snooze 1d]` / `[Snooze 1w] [Drop]`), 3 buttons per row for approvals (`[Approve] [Deny] [View Details]`)
  - [x] 5.4 Attach `reply_markup: { inline_keyboard: [...] }` to `sendMessage` options
  - [x] 5.5 Ensure topic routing still works when actions are present (message_thread_id must be included)

- [x] Task 6: Refactor callback_query handler in telegram-bot.ts (AC: #9, #10, #11)
  - [x] 6.1 Replace the current plain-text `user:chat:message` emit with structured callback routing
  - [x] 6.2 Parse callback_data using `parseCallbackData()` from callback-handler
  - [x] 6.3 If parsed successfully: route to `handleCallback()` → get result → edit message if needed
  - [x] 6.4 If parse fails (unrecognized format): fall back to current behavior — emit as `user:chat:message` for backward compatibility with any existing callback_data patterns
  - [x] 6.5 Call `ctx.answerCallbackQuery()` with result message within the handler (prevent Telegram timeout)
  - [x] 6.6 All callback processing wrapped in try/catch — on error, answer with error text and log

- [x] Task 7: Emit approval notifications with inline buttons (AC: #3)
  - [x] 7.1 In the `permission:blocked` event handler (wherever the notification for Red-tier blocks is emitted): include `actions` array in the notification payload
  - [x] 7.2 Find where `permission:blocked` events trigger Telegram notifications — likely in the notification suite's event handler or the orchestrator
  - [x] 7.3 Add actions: `[{ label: 'Approve', action: 'a:y:{approvalId}' }, { label: 'Deny', action: 'a:n:{approvalId}' }, { label: 'View Details', action: 'a:v:{approvalId}' }]`
  - [x] 7.4 If no existing `permission:blocked` → notification handler exists, create one in the notifications suite that listens for `permission:blocked` events and emits a `notification` event with the approval buttons

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Unit tests for `parseCallbackData()` — valid formats, edge cases (empty string, missing args, too-long data), null on invalid
  - [x] 8.2 Unit tests for `handleCallback()` router — routes task/approval actions correctly, returns proper results
  - [x] 8.3 Integration test: task callback → sub-agent execution → message edit (mock TickTick MCP)
  - [x] 8.4 Integration test: approval callback → pendingApprovals.resolve() → message edit
  - [x] 8.5 Test: approval already resolved → "Already resolved" response
  - [x] 8.6 Test: notification with actions array → inline keyboard rendered correctly
  - [x] 8.7 Test: callback error handling → user gets error message, message not corrupted
  - [x] 8.8 Test: backward compatibility — unknown callback_data falls back to user:chat:message
  - [x] 8.9 Test: `answerCallbackQuery` is always called (prevents Telegram timeout)
  - [x] 8.10 All tests mock grammy Bot, pendingApprovals, agentManager — never hit real APIs

## Dev Notes

### Architecture Constraints

- **Suite-based architecture** — Telegram lives in `suites/notifications/`. The callback handler is a new **service file** within this suite, NOT a new package or skill.
- **MCP Isolation** — Task actions (Complete, Snooze, Drop) require spawning a TickTick sub-agent via `agentManager` since TickTick MCP tools are only available to the TickTick agent. The callback handler does NOT have direct MCP access.
- **Event Bus fire-and-forget** — For task actions that need sub-agent execution, emit an event or call `agentManager.executeTask()` directly. The callback handler should NOT wait indefinitely — use a reasonable timeout (5s) and answer the callback query even if execution is still in progress.
- **No classes** — callback-handler.ts should export functions, not a class.
- **Pending approvals system is complete** — Use the existing `pendingApprovals.resolve()` method for all approval actions. The REST routes at `/api/approvals/:id/resolve` and `/api/approvals/batch` already handle execution + audit logging.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Telegram bot service | `suites/notifications/services/telegram-bot.ts` | **EXTEND** callback_query handler + notification renderer |
| Pending approvals module | `packages/core/src/permission-engine/pending-approvals.ts` | **USE** `resolve()`, `query()` methods directly |
| Approval API routes | `packages/core/src/api/routes/approvals.ts` | Reference implementation for resolve flow |
| Permission events | `packages/shared/src/types/events.ts` | `permission:blocked`, `permission:approved`, `permission:denied` events already defined |
| Notification event | `packages/shared/src/types/events.ts` | Already has `actions` array field — use this for button definitions |
| TickTick agent | `suites/task-management/agents/ticktick-agent.ts` | Sub-agent to spawn for task actions |
| Audit log | `packages/core/src/permission-engine/audit-log.ts` | Already called by `pendingApprovals.resolve()` |
| Agent manager | `packages/core/src/agent-manager/` | Use for spawning TickTick sub-agent from callbacks |
| Existing callback tests | `suites/notifications/__tests__/telegram-bot.test.ts` | Extend with callback routing tests |

### grammy Inline Keyboard API Reference

```typescript
import { InlineKeyboard } from 'grammy';

// Build keyboard
const keyboard = new InlineKeyboard()
  .text('Complete', 't:c:taskId123')
  .text('Snooze 1d', 't:s:taskId123:1d')
  .row()
  .text('Snooze 1w', 't:s:taskId123:1w')
  .text('Drop', 't:d:taskId123');

// Send with keyboard
await bot.api.sendMessage(chatId, 'Overdue: Buy groceries', {
  reply_markup: keyboard,
  message_thread_id: topicId,  // preserve topic routing
});

// Edit message after callback
await ctx.api.editMessageText(
  chatId,
  ctx.callbackQuery.message.message_id,
  'Overdue: Buy groceries\nDone ✓',
  { reply_markup: { inline_keyboard: [[{ text: 'Done ✓', callback_data: 'noop' }]] } }
);

// Answer callback query (MUST call within 2s)
await ctx.answerCallbackQuery({ text: 'Task completed!' });
```

### Callback Data Format Design

**Telegram limit: 64 bytes for callback_data.** Use short prefixes:

| Action | Format | Example |
|---|---|---|
| Complete task | `t:c:{taskId}` | `t:c:abc123` |
| Snooze task 1 day | `t:s:{taskId}:1d` | `t:s:abc123:1d` |
| Snooze task 1 week | `t:s:{taskId}:1w` | `t:s:abc123:1w` |
| Drop task | `t:d:{taskId}` | `t:d:abc123` |
| Approve action | `a:y:{approvalId}` | `a:y:def456` |
| Deny action | `a:n:{approvalId}` | `a:n:def456` |
| View details | `a:v:{approvalId}` | `a:v:def456` |
| No-op (disabled button) | `noop` | `noop` |

### Task Action Execution Path

Task actions from callbacks need to invoke the TickTick MCP via a sub-agent:

1. Callback handler receives parsed action (e.g., `t:c:taskId123`)
2. Handler calls `agentManager.executeTask()` with a prompt like: "Complete the task with ID taskId123 in TickTick"
3. The agent manager spawns a TickTick sub-agent (which has the TickTick MCP)
4. Sub-agent executes the MCP tool to complete the task
5. Result is returned to callback handler
6. Handler edits the Telegram message with the result

**Alternative simpler approach**: If the TickTick MCP server exposes HTTP endpoints or if the MCP client can be called directly (without a full agent session), that would be faster. Check if the agent session's `executeApprovedAction()` pattern can be adapted.

### Approval Resolution Flow (Already Built)

The approval system is already complete from Epic 1, Story 1.6:

```
pendingApprovals.resolve(approvalId, 'approved')
  → Updates DB: resolution = 'approved', resolvedAt = now
  → Emits 'permission:approved' event
  → agentManager.executeApprovedAction(approval) runs the deferred action
  → Audit log entry created with outcome
```

The callback handler just needs to call `pendingApprovals.resolve()` — no new approval logic needed.

### Key Integration: permission:blocked → Telegram Notification

Currently, when a Red-tier action is blocked:
1. `permission:blocked` event is emitted by the permission gate
2. An audit entry is created with `outcome: queued`
3. A `pending_approvals` DB row is inserted

**What's missing**: No handler currently sends a Telegram notification when `permission:blocked` fires. Story 3.2 needs to:
- Subscribe to `permission:blocked` events in the notifications suite
- Emit a `notification` event with channel `telegram`, the action details as body text, and `actions` array with Approve/Deny/Details buttons

### Previous Story Learnings (3.1)

- **Zod validation for topic config** — Apply same pattern to callback data validation
- **Type imports** — Use `import type` for type-only imports (enforced by ESLint)
- **Callback authorization** — Already implemented in 3.1, supports both group and direct mode. Don't recreate.
- **sendMessageWithFallback** — Existing pattern for topic send failure → non-topic retry. Use for inline keyboard messages too.
- **Test patterns** — Mock grammy `Bot` and `ctx` objects, use `vi.fn()` for all API methods, capture handler references via `bot.on` spy

### Project Structure Notes

- New file: `suites/notifications/services/callback-handler.ts` (callback routing + action handlers)
- Modified: `suites/notifications/services/telegram-bot.ts` (keyboard rendering, callback routing refactor)
- Modified: `packages/shared/src/types/events.ts` (may need `CallbackAction` type export)
- Modified: `suites/notifications/__tests__/telegram-bot.test.ts` (extend with callback tests)
- New file: `suites/notifications/__tests__/callback-handler.test.ts` (unit tests for handler)
- Modified: `suites/notifications/suite.ts` (subscribe to `permission:blocked` events)

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 3, Story 3.2]
- [Source: _bmad-output/planning-artifacts/prd.md — FR21, FR24, NFR21]
- [Source: _bmad-output/planning-artifacts/architecture.md — Telegram enhancements, permission system]
- [Source: suites/notifications/services/telegram-bot.ts — existing callback_query handler, notification routing]
- [Source: packages/core/src/permission-engine/pending-approvals.ts — resolve(), query() methods]
- [Source: packages/core/src/api/routes/approvals.ts — approval resolution pattern, executeApprovedAction()]
- [Source: packages/shared/src/types/events.ts — NotificationEvent.actions, PermissionBlockedEvent]
- [Source: suites/task-management/agents/ticktick-agent.ts — TickTick sub-agent definition]
- [Source: packages/core/src/permission-engine/audit-log.ts — audit entry types]
- [Source: _bmad-output/implementation-artifacts/3-1-telegram-group-with-topic-threads.md — previous story learnings]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Task 1: Created `callback-handler.ts` with `parseCallbackData()` function and `CallbackAction` type. Short prefixes (`t:c:`, `a:y:`, etc.) enforce 64-byte Telegram callback_data limit. 17 unit tests.
- Task 2: Added `handleCallback()` router function, `CallbackDeps` and `CallbackResult` interfaces. Routes by domain prefix (task/approval). Synchronous return for fast 2s response.
- Task 3: Implemented task action handlers (complete, snooze, drop). Uses `agentManager.executeApprovedAction()` fire-and-forget pattern to spawn TickTick sub-agent. Returns updated keyboard with confirmation text.
- Task 4: Implemented approval handlers (approve, deny, details). Uses `pendingApprovals.resolve()` directly per story requirements. Handles ALREADY_RESOLVED and NOT_FOUND error codes. Approval details sent as reply message.
- Task 5: Extended notification event handler in `telegram-bot.ts` to build `InlineKeyboard` from `actions` array. Layout: 3 per row for approvals, 2 per row for tasks. Topic routing preserved with `message_thread_id`.
- Task 6: Refactored `callback_query:data` handler with structured routing via `parseCallbackData()` → `handleCallback()`. Unrecognized formats fall back to legacy `user:chat:message` emit. Full try/catch wrapping. `answerCallbackQuery()` always called.
- Task 7: Added `permission:blocked` event subscription in telegram-bot. Emits `notification` event with Approve/Deny/View Details buttons routed to System topic.
- Task 8: 60 total tests across 2 test files (28 callback-handler + 32 telegram-bot). All pass. Covers parsing, routing, task/approval actions, error handling, keyboard rendering, backward compatibility, and `answerCallbackQuery` guarantees.
- Architecture decision: Callback deps (pendingApprovals, auditLog, agentManager) injected lazily via `baseContext.config` in `index.ts` since services start before these modules are initialized. Deps resolved on first callback via `resolveCallbackDeps()`.

### Code Review Fixes Applied

- **Missing event emission**: Added `permission:approved` and `permission:denied` event emission to `handleApprovalAction()` in callback-handler.ts, mirroring the REST route pattern in approvals.ts. Without this, system components listening for permission events would not be notified of Telegram callback-initiated resolutions.
- **Details lookup on resolved approvals**: Replaced `query().find()` (which only returns unresolved approvals) with new `getById()` method on pending-approvals module. Users can now tap "View Details" on already-resolved approvals without getting "Not found".
- **answerCallbackQuery truncation**: Changed details action to use "Loading details..." as callback answer text instead of full details (which could exceed Telegram's 200-char limit). Full content is still sent as reply message.
- **sessionId propagation**: Added `sessionId` to `PendingApprovalInfo` interface and passed it through to `executeApprovedAction()` and event payloads for proper tracing.
- **Added 1 test**: "shows details for already-resolved approvals" covering the getById fix.

### File List

- `suites/notifications/services/callback-handler.ts` (NEW) — Callback data parser, router, task/approval action handlers
- `suites/notifications/services/telegram-bot.ts` (MODIFIED) — Inline keyboard rendering, structured callback routing, permission:blocked handler
- `suites/notifications/__tests__/callback-handler.test.ts` (NEW) — 29 unit tests for callback handler
- `suites/notifications/__tests__/telegram-bot.test.ts` (MODIFIED) — Extended with 7 new tests for inline keyboards, callback routing, permission:blocked
- `packages/core/src/index.ts` (MODIFIED) — Inject pendingApprovals, auditLog, agentManager into baseContext.config for callback handler
- `packages/core/src/permission-engine/pending-approvals.ts` (MODIFIED) — Added `getById()` method to PendingApprovals interface and implementation
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (MODIFIED) — Story status: ready-for-dev → in-progress → review
