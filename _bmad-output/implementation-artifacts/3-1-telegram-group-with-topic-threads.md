# Story 3.1: Telegram Group with Topic Threads

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the mobile user,
I want Raven to operate in a Telegram group with topic threads per domain,
so that conversations are organized by context instead of one noisy stream.

## Acceptance Criteria

1. **Topic-Aware Message Routing (General)** — Given Raven is configured with a Telegram group ID and topic IDs, When a message arrives in the "General" topic, Then it is routed to the orchestrator as a general query with topic context attached (`topicId`, `topicName` fields on the event payload).

2. **Project-Specific Topic Context Injection** — Given a message arrives in a project-specific topic (e.g., "Work", "Personal"), When the orchestrator processes it, Then the project context is injected into the sub-agent prompt using the topic-to-project mapping from config.

3. **System Alert Topic Routing** — Given Raven needs to send a system alert (health alerts, error notifications), When the alert is dispatched via `notification` event, Then it is sent to the "System" topic (`message_thread_id` for system topic), not the General topic.

4. **Graceful Fallback on Missing Permissions** — Given the bot lacks admin permissions in the group or topic operations fail, When topic-specific sending fails, Then the error is logged and the bot falls back to non-topic messaging (sends to the group without `message_thread_id`).

5. **Backward Compatibility** — Given `TELEGRAM_GROUP_ID` is NOT configured but `TELEGRAM_CHAT_ID` IS configured, When the bot starts, Then it operates in legacy 1:1 chat mode exactly as before with no behavior change.

6. **Topic Config via Environment** — Given `TELEGRAM_GROUP_ID` and `TELEGRAM_TOPIC_*` env vars are set, When the bot initializes, Then it parses the topic mapping and uses `message_thread_id` for all outgoing messages routed to specific topics.

7. **Incoming Messages Carry Topic Context** — Given a user sends a message in a specific topic thread, When the `user:chat:message` event is emitted, Then the payload includes `topicId` (number) and `topicName` (string, resolved from config mapping) so downstream handlers know the conversation context.

8. **Agent Results Routed Back to Source Topic** — Given a chat message originated from a specific topic, When the agent task completes and sends a response, Then the response is sent back to the same topic thread the message came from.

## Tasks / Subtasks

- [x] Task 1: Add topic configuration env vars and types (AC: #5, #6)
  - [x] 1.1 Add env vars to `packages/core/src/config.ts` schema: `TELEGRAM_GROUP_ID` (optional string), `TELEGRAM_TOPIC_GENERAL` (optional string, numeric ID), `TELEGRAM_TOPIC_SYSTEM` (optional string, numeric ID), `TELEGRAM_TOPIC_MAP` (optional string, JSON map of `topicName→topicId`)
  - [x] 1.2 Add `.env.example` entries for new Telegram group/topic vars with comments
  - [x] 1.3 Update `suites/notifications/suite.ts` — keep `requiresEnv` as `['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']` (backward compat), add optional group vars

- [x] Task 2: Extend event types with topic context (AC: #1, #7)
  - [x] 2.1 Extend `UserChatMessageEvent` payload in `packages/shared/src/types/events.ts` — add optional `topicId?: number` and `topicName?: string` fields
  - [x] 2.2 Extend `NotificationEvent` payload — add optional `topicName?: string` field to control which topic receives the notification

- [x] Task 3: Refactor telegram-bot service for group+topic support (AC: #1, #2, #3, #4, #5, #6, #7, #8)
  - [x] 3.1 Parse topic config on startup: read `TELEGRAM_GROUP_ID`, `TELEGRAM_TOPIC_GENERAL`, `TELEGRAM_TOPIC_SYSTEM`, `TELEGRAM_TOPIC_MAP` (JSON string → `Record<string, number>`)
  - [x] 3.2 Determine operating mode: `group` (if `TELEGRAM_GROUP_ID` set) or `direct` (legacy, `TELEGRAM_CHAT_ID` only)
  - [x] 3.3 In `group` mode: listen for messages in the group, extract `message_thread_id` from incoming `ctx.message`, resolve topic name from the reverse map (topicId→topicName)
  - [x] 3.4 Emit `user:chat:message` with `topicId` and `topicName` in payload
  - [x] 3.5 Set `projectId` from topic-to-project mapping (topic name may map to a project ID, fallback to `PROJECT_TELEGRAM_DEFAULT`)
  - [x] 3.6 Refactor `sendMessage()` to accept optional `messageThreadId?: number` — used for topic-targeted sends
  - [x] 3.7 Create helper `getTopicThreadId(topicName: string): number | undefined` — resolves topic name to `message_thread_id` from config
  - [x] 3.8 In `group` mode, validate bot is a member of the group on startup — log error if not

- [x] Task 4: Route outgoing messages to correct topic (AC: #3, #8)
  - [x] 4.1 In `notification` event handler: if `topicName` is specified in payload → send to that topic; if event is `system:health:alert` → always send to System topic; else → send to General topic
  - [x] 4.2 In `agent:task:complete` event handler: read `topicId` from original task context and reply to the same topic thread
  - [x] 4.3 For both handlers: wrap `sendMessage` in try/catch — on failure with topic, retry without `message_thread_id` (AC: #4 fallback)

- [x] Task 5: Wire up topic context to orchestrator (AC: #2)
  - [x] 5.1 In `packages/core/src/orchestrator/orchestrator.ts`: when processing `user:chat:message` with `topicId`/`topicName`, include topic context in the prompt builder context (e.g., "This message is from the '{topicName}' topic thread")
  - [x] 5.2 Ensure `topicId` is preserved through the agent task lifecycle so the response can be routed back to the correct topic

- [x] Task 6: Tests (AC: all)
  - [x] 6.1 Unit tests in `suites/notifications/__tests__/telegram-bot.test.ts`:
    - Group mode: incoming message with `message_thread_id` emits event with `topicId` and `topicName`
    - Group mode: incoming message without `message_thread_id` (general/no-topic) still works
    - Direct mode: behaves identically to current implementation
    - `sendMessage` with `messageThreadId` includes it in API call
    - Fallback: topic send failure retries without topic
    - Notification routing: system alerts go to System topic
    - Agent response routes back to source topic
  - [x] 6.2 Mock grammy `Bot` and `ctx` objects — never connect to real Telegram
  - [x] 6.3 Test topic config parsing: valid JSON map, empty map, malformed JSON logs warning

## Dev Notes

### Architecture Constraints

- **Suite-based architecture** — Telegram lives in `suites/notifications/`. The bot is a **SuiteService** (`start`/`stop` interface). Do NOT create a new package or skill — extend the existing service.
- **MCP Isolation** — The telegram-bot service is NOT an MCP server. It's a long-running service (grammy polling). No MCP changes needed.
- **Event Bus fire-and-forget** — All outgoing notifications use `eventBus.emit()`. The bot subscribes to `notification` and `agent:task:complete` events. No request/response patterns.
- **No classes** — Keep the service as a module-level object with `start`/`stop` functions (matches existing pattern).
- **grammy ^1.41.1** — Already installed. grammy supports Telegram Forum Topics API natively. Use `ctx.api.sendMessage(groupId, text, { message_thread_id: topicId })` for topic-targeted messages.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Telegram bot service | `suites/notifications/services/telegram-bot.ts` | **EXTEND THIS** — add group/topic mode |
| Telegram notifier agent | `suites/notifications/agents/telegram-notifier.ts` | No changes needed |
| Telegram actions | `suites/notifications/actions.json` | May add `telegram:send-topic-message` action |
| Suite manifest | `suites/notifications/suite.ts` | May need `requiresEnv` update |
| Event types | `packages/shared/src/types/events.ts` | Extend `UserChatMessageEvent` and `NotificationEvent` payloads |
| Config schema | `packages/core/src/config.ts` | Add `TELEGRAM_GROUP_ID`, `TELEGRAM_TOPIC_*` env vars |
| Event bus | `packages/core/src/event-bus/event-bus.ts` | No changes |
| Orchestrator | `packages/core/src/orchestrator/orchestrator.ts` | Inject topic context into prompt |
| Constants | `packages/shared/src/suites/constants.ts` | May add `PROJECT_TELEGRAM_*` project IDs for topic mapping |

### grammy Forum Topics API Reference

```typescript
// Send message to a specific topic thread
await bot.api.sendMessage(groupId, text, {
  message_thread_id: topicThreadId,  // number
  parse_mode: 'MarkdownV2',
});

// Incoming messages in a topic have ctx.message.message_thread_id
bot.on('message:text', async (ctx) => {
  const topicId = ctx.message.message_thread_id; // number | undefined
  // undefined means "General" topic or non-forum group
});
```

### Environment Variable Design

```bash
# Group mode (new)
TELEGRAM_GROUP_ID=-1001234567890        # Telegram group/supergroup ID (negative number)
TELEGRAM_TOPIC_GENERAL=1               # General topic thread ID (usually 1)
TELEGRAM_TOPIC_SYSTEM=42               # System alerts topic thread ID
TELEGRAM_TOPIC_MAP='{"Work":5,"Personal":7,"Finance":12}'  # JSON: topicName → threadId

# Direct mode (legacy, still supported)
TELEGRAM_CHAT_ID=123456789             # Direct chat with bot
```

### Key Implementation Decisions

1. **Operating modes**: `group` vs `direct` — determined at startup based on whether `TELEGRAM_GROUP_ID` is set. Both modes share the same service, branching on this flag.
2. **Topic mapping is config-driven** — `TELEGRAM_TOPIC_MAP` is a JSON string env var mapping human-readable topic names to numeric thread IDs. This avoids DB complexity.
3. **Authorization in group mode**: Check `ctx.chat.id === groupId` instead of `ctx.from.id === chatId`. All messages in the configured group are accepted.
4. **`message_thread_id`** is the grammy/Telegram API field for forum topic threads. The "General" topic typically has `message_thread_id = 1` or may be `undefined`.
5. **Backward compatibility is critical** — the bot must work identically in direct mode. Zero regressions.

### Project Structure Notes

- Main change is in `suites/notifications/services/telegram-bot.ts` (extend existing ~118 lines)
- Secondary changes in `packages/shared/src/types/events.ts` (extend payload types)
- Config changes in `packages/core/src/config.ts` (add env vars)
- Orchestrator change in `packages/core/src/orchestrator/orchestrator.ts` (topic context injection)
- Test file: `suites/notifications/__tests__/telegram-bot.test.ts` (new)

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 3, Story 3.1]
- [Source: _bmad-output/planning-artifacts/prd.md — FR19, NFR21, NFR24]
- [Source: _bmad-output/planning-artifacts/architecture.md — Telegram Bot Architecture section]
- [Source: suites/notifications/services/telegram-bot.ts — existing bot implementation]
- [Source: packages/shared/src/types/events.ts — UserChatMessageEvent, NotificationEvent]
- [Source: packages/core/src/config.ts — env schema, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
- [Source: packages/shared/src/suites/define.ts — SuiteService interface, defineAgent]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 358 tests pass (20 new telegram-bot tests), 0 regressions
- `npm run check` passes: 0 errors, 146 warnings (all pre-existing)
- Build succeeds for shared + core + web

### Completion Notes List
- Task 1: Added 4 optional env vars to config.ts schema (TELEGRAM_GROUP_ID, TELEGRAM_TOPIC_GENERAL, TELEGRAM_TOPIC_SYSTEM, TELEGRAM_TOPIC_MAP). Updated .env.example. Suite requiresEnv kept as-is for backward compat.
- Task 2: Extended UserChatMessageEvent with optional topicId/topicName. Extended NotificationEvent with optional topicName.
- Task 3: Refactored telegram-bot.ts from 118 to ~260 lines. Added dual operating mode (group/direct), topic config parsing, reverse topic map, projectId resolution from topic names, getTopicThreadId helper, group membership validation on startup. Exported parseTopicConfig and getTopicThreadId for testability.
- Task 4: Notification handler routes to specified topicName or defaults to General. system:health:alert always routes to System topic. agent:task:complete routes back to source topic via projectId→topicId tracking. sendMessageWithFallback retries without message_thread_id on failure.
- Task 5: Orchestrator injects topic context into prompt ("[Context: This message is from the 'X' topic thread]"). topicId preserved through projectId mapping in the bot service.
- Task 6: 20 comprehensive tests covering group mode, direct mode, topic routing, fallback behavior, config parsing, group membership validation. Tests use mocked grammy Bot. Created suites/vitest.config.ts and registered in root vitest config.

### File List
- packages/core/src/config.ts (modified — added 4 env vars)
- packages/core/src/__tests__/config.test.ts (modified — added 2 tests for topic env vars)
- packages/shared/src/types/events.ts (modified — extended UserChatMessageEvent and NotificationEvent)
- packages/core/src/orchestrator/orchestrator.ts (modified — topic context injection in prompt)
- suites/notifications/services/telegram-bot.ts (modified — full group+topic rewrite, review fixes: Zod validation, type imports, callback auth)
- suites/notifications/__tests__/telegram-bot.test.ts (new — 25 tests, +5 from review: stop cleanup, callback auth, topic map validation)
- suites/vitest.config.ts (new — vitest project config for suites)
- vitest.config.ts (modified — added suites project)
- .env.example (modified — added group/topic env vars)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified — story status sync)

### Change Log
- 2026-03-14: Story 3.1 implemented — Telegram group with topic threads support
- 2026-03-14: Code review fixes — H1: removed `as unknown` casts, imported canonical event types; H2: added callback_query auth checks for group/direct mode; H3: added Zod validation for TELEGRAM_TOPIC_MAP values; M1: replaced inline types with imported types; M2: added stop() cleanup test; M3: updated File List with sprint-status.yaml; M4: added callback_query auth tests + topic map validation test
