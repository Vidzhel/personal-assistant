# Story 3.3: Gemini Voice Transcription Skill

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the mobile user,
I want to send voice messages that Raven transcribes and processes as commands,
so that I can give instructions hands-free while on the go.

## Acceptance Criteria

1. **Voice Message Forwarded to Gemini** — Given a voice message is sent to Raven in Telegram, When the Telegram bot service receives it, Then the audio is downloaded and forwarded to the Gemini transcription suite for transcription.

2. **Transcription Processed as User Intent** — Given Gemini returns a transcription, When the text is received, Then it is emitted as a `user:chat:message` event through the orchestrator as if the user typed it, preserving topic/project context.

3. **30-Second Timeout** — Given Gemini transcription takes longer than 30 seconds (NFR26), When the timeout fires, Then the user receives "Couldn't transcribe that — please type your message" in the same Telegram topic and no error crashes the system.

4. **Gemini API Unavailable** — Given the Gemini API is unavailable, When a voice message arrives, Then the skill degrades gracefully with a friendly error message to the user ("Voice transcription is temporarily unavailable — please type your message").

5. **Audio Format Support** — Given the user sends a voice message (OGG/Opus format from Telegram), When the audio is downloaded, Then it is passed to Gemini in a supported format (OGG is natively supported by Gemini).

6. **Processing Indicator** — Given a voice message is received, When transcription begins, Then the user sees a "Transcribing voice message..." reply in the same topic, and after transcription completes, sees the transcribed text before it's processed.

7. **Suite Registration** — Given the gemini-transcription suite is enabled in `config/suites.json`, When the system boots, Then the suite loads successfully and registers its agent and MCP server.

8. **Missing API Key Graceful Skip** — Given `GOOGLE_API_KEY` is not set in the environment, When the system boots, Then the gemini-transcription suite is skipped with a warning log, and voice messages receive "Voice transcription not configured" reply.

## Tasks / Subtasks

- [x] Task 1: Create the gemini-transcription suite structure (AC: #7, #8)
  - [x] 1.1 Create `suites/gemini-transcription/suite.ts` — define suite manifest with `defineSuite()`: name `'gemini-transcription'`, capabilities `['agent-definition']` (direct API, no MCP), requiresEnv `['GOOGLE_API_KEY']`
  - [x] 1.2 Add constants to `packages/shared/src/suites/constants.ts`: `SUITE_GEMINI_TRANSCRIPTION = 'gemini-transcription'`, `AGENT_GEMINI_TRANSCRIBER = 'gemini-transcriber'`, `SOURCE_GEMINI = 'gemini'`
  - [x] 1.3 Re-export new constants from `packages/shared/src/suites/index.ts`
  - [x] 1.4 Create `suites/gemini-transcription/actions.json` — declare permission-controlled actions
  - [x] 1.5 Add entry to `config/suites.json`: `"gemini-transcription": { "enabled": true }`

- [x] Task 2: Set up Gemini MCP server (AC: #7)
  - [x] 2.1 N/A — no existing MCP server reliably handles audio transcription
  - [x] 2.2 **Decision: Direct API approach** — using `@google/generative-ai` SDK directly in a service. No MCP needed. Capabilities set to `['agent-definition']`
  - [x] 2.3 N/A — no MCP to validate (service validated via tests)

- [x] Task 3: Create Gemini transcriber agent definition (AC: #1, #2)
  - [x] 3.1 Create `suites/gemini-transcription/agents/gemini-transcriber.ts` — uses `defineAgent()` pattern
  - [x] 3.2 Agent config: name `AGENT_GEMINI_TRANSCRIBER`, model `'haiku'`, maxTurns `3`
  - [x] 3.3 N/A — using direct API approach, no MCP tools
  - [x] 3.4 Service handles transcription directly — agent definition kept for registry/discoverability
  - [x] 3.5 Agent prompt set to transcription-focused instruction

- [x] Task 4: Add voice message handler to Telegram bot (AC: #1, #5, #6)
  - [x] 4.1 Added `handleVoiceMessage` function + `bot.on('message:voice')` handler after `message:text`
  - [x] 4.2 Extract voice metadata: `file_id`, `duration`, `mime_type`, `file_size`
  - [x] 4.3 Authorization check: group mode checks `groupId`, direct mode checks `chatId`
  - [x] 4.4 Download voice file via Telegram File API with `fetch()`. 20MB size limit enforced
  - [x] 4.5 Send "Transcribing voice message..." reply with `message_thread_id`
  - [x] 4.6 Emit `voice:received` event with base64 audio, duration, topic context, replyMessageId
  - [x] 4.7 Also handle `message:video_note` — shares `handleVoiceMessage` function

- [x] Task 5: Create voice transcription service (AC: #1, #2, #3, #4)
  - [x] 5.1 Created `suites/gemini-transcription/services/voice-transcriber.ts` implementing `SuiteService`
  - [x] 5.2 On `start()`: subscribe to `voice:received` events via `eventBus.on()`
  - [x] 5.3 Calls Gemini API with audio data using `model.generateContent()` with inline data
  - [x] 5.4 Uses `@google/generative-ai` SDK with `gemini-2.0-flash` model
  - [x] 5.5 30-second timeout via `AbortController` + `setTimeout` (NFR26)
  - [x] 5.6 On success: emits `notification` (Voice: {transcription}) + `user:chat:message` preserving context
  - [x] 5.7 On timeout: emits notification "Couldn't transcribe that — please type your message"
  - [x] 5.8 On API error: emits notification "Voice transcription is temporarily unavailable" + logs with Pino
  - [x] 5.9 Service listed in suite.ts manifest: `services: ['voice-transcriber']`
  - [x] 5.10 On `stop()`: calls `eventBus.off()`, clears pending timeouts

- [x] Task 6: Add new event type for voice messages (AC: #1)
  - [x] 6.1 Added `VoiceReceivedEvent` interface to `packages/shared/src/types/events.ts`
  - [x] 6.2 Added `VoiceReceivedEvent` to the `RavenEvent` union type
  - [x] 6.3 Added `VoiceReceivedPayloadSchema` Zod schema
  - [x] 6.4 Rebuilt `@raven/shared` successfully

- [x] Task 7: Add `@google/generative-ai` dependency (AC: #1)
  - [x] 7.1 Installed `@google/generative-ai` as root dependency
  - [x] 7.2 Confirmed: pure JS SDK, no MCP needed — service calls API directly
  - [x] 7.3 Added `GOOGLE_API_KEY` to `.env.example`
  - [x] 7.4 API key validation deferred to runtime (tested via mocked unit tests)

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Created `suites/gemini-transcription/__tests__/voice-transcriber.test.ts`
  - [x] 8.2 Unit test: voice event → Gemini API called with correct audio data and mime type
  - [x] 8.3 Unit test: successful transcription → `user:chat:message` + `notification` emitted
  - [x] 8.4 Unit test: AbortError → notification with "Couldn't transcribe" message
  - [x] 8.5 Unit test: network error → notification with "temporarily unavailable" message
  - [x] 8.6 Unit test: auth/quota error → graceful degradation message
  - [x] 8.7 Integration test: telegram-bot.test.ts extended — voice message → `voice:received` event
  - [x] 8.8 Test: voice from unauthorized chat ignored in group mode
  - [x] 8.9 Test: topicId, topicName, projectId preserved through transcription pipeline
  - [x] 8.10 Mocked `@google/generative-ai` as class in all tests — never calls real API
  - [x] 8.11 Test: service skipped when `GOOGLE_API_KEY` not set (via start() early return)

## Dev Notes

### Architecture Constraints

- **Suite-based architecture** — This is a NEW SUITE at `suites/gemini-transcription/`, NOT a new package under `packages/skills/`. The project has evolved from skills to suites. Follow the suite pattern from `suites/task-management/`.
- **MCP Isolation** — The architecture doc says "Gemini MCP server" but no existing MCP server reliably handles audio file transcription. **RECOMMENDED: Use `@google/generative-ai` SDK directly in a service.** This is simpler, more reliable, and still respects MCP isolation (the orchestrator doesn't load any MCP for this — the service handles it independently).
- **Event-driven flow** — Voice messages flow through the event bus: Telegram bot emits `voice:received` → gemini-transcription service processes → emits `user:chat:message` (as if user typed it) + `notification` (to show transcribed text).
- **No classes** — voice-transcriber service exports a `SuiteService` object with `start()/stop()` methods, not a class.
- **30-second timeout is an NFR** (NFR26) — Must be enforced with `AbortController`, not a soft timeout.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Telegram bot service | `suites/notifications/services/telegram-bot.ts` | **EXTEND** with `message:voice` handler |
| Event bus | `packages/core/src/event-bus/event-bus.ts` | **USE** for voice:received → user:chat:message flow |
| Event types | `packages/shared/src/types/events.ts` | **EXTEND** with VoiceReceivedEvent |
| Suite constants | `packages/shared/src/suites/constants.ts` | **EXTEND** with SUITE_GEMINI_TRANSCRIPTION, AGENT_GEMINI_TRANSCRIBER |
| Suite loader | `packages/core/src/suite-registry/suite-loader.ts` | Auto-discovers suites from `suites/` directory |
| Service runner | `packages/core/src/suite-registry/service-runner.ts` | Manages service lifecycle (start/stop) |
| defineSuite() | `packages/shared/src/suites/define.ts` | Factory for suite manifest |
| defineAgent() | `packages/shared/src/suites/define.ts` | Factory for agent definitions |
| Config/suites.json | `config/suites.json` | Suite enable/disable config |
| generateId() | `packages/shared/src/utils/id.ts` | `crypto.randomUUID()` wrapper |
| createLogger() | `packages/shared/src/utils/logger.ts` | Pino logger factory |
| sendMessageWithFallback | `suites/notifications/services/telegram-bot.ts` | Topic send failure → non-topic retry pattern |
| Notification event handler | `suites/notifications/services/telegram-bot.ts` | Already handles `notification` events → sends to Telegram |

### Gemini API Reference (Google AI SDK for Node.js)

```typescript
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Transcribe audio (inline data)
const result = await model.generateContent([
  {
    inlineData: {
      mimeType: 'audio/ogg',  // Telegram voice format
      data: base64AudioData,  // Base64-encoded audio bytes
    },
  },
  'Transcribe this audio message accurately. Return only the transcribed text.',
]);

const transcription = result.response.text();
```

**Supported audio formats:** WAV, MP3, AIFF, AAC, OGG, FLAC
**Telegram voice format:** OGG/Opus — natively supported by Gemini, no conversion needed
**Model recommendation:** `gemini-2.0-flash` — fastest transcription, sufficient accuracy for voice commands
**Max audio size:** ~20MB inline (Telegram voice messages are typically <1MB)

### grammy Voice Message Handling

```typescript
// Voice message object from Telegram
interface Voice {
  file_id: string;        // Use to download the file
  file_unique_id: string; // Unique across time
  duration: number;       // Seconds
  mime_type?: string;     // 'audio/ogg'
  file_size?: number;     // Bytes
}

// Download pattern
bot.on('message:voice', async (ctx) => {
  const voice = ctx.message.voice;
  const file = await ctx.getFile();
  // file.file_path is the server-side path
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString('base64');
});
```

### Voice Transcription Flow

```
User sends voice message in Telegram
  ↓
telegram-bot.ts: bot.on('message:voice')
  ↓ authorization check (group/direct mode)
  ↓ download audio via Telegram File API
  ↓ reply "Transcribing voice message..."
  ↓ emit voice:received event (base64 audio, topic context)
  ↓
gemini-transcription/services/voice-transcriber.ts
  ↓ receives voice:received event
  ↓ call Gemini API with audio data (30s timeout)
  ↓
  ├─ SUCCESS:
  │   ↓ emit notification event: "Voice: {transcription}"
  │   ↓ emit user:chat:message event with transcribed text
  │   ↓ orchestrator processes as normal text command
  │
  ├─ TIMEOUT (30s):
  │   ↓ emit notification: "Couldn't transcribe — please type"
  │
  └─ API ERROR:
      ↓ log error with Pino
      ↓ emit notification: "Voice transcription temporarily unavailable"
```

### Previous Story Learnings (3.2)

- **CallbackDeps lazy resolution** — Services start before all dependencies are initialized. Use lazy resolution pattern (`resolveCallbackDeps()`) if the voice transcriber needs access to components injected after boot.
- **sendMessageWithFallback** — Use this existing pattern when sending notification replies with topic routing to handle topic send failures gracefully.
- **Type imports** — Use `import type` for type-only imports (enforced by ESLint).
- **Test patterns** — Mock grammy `Bot` and `ctx` objects with `vi.fn()`. Capture handler references via `bot.on` spy. Mock all external APIs.
- **Permission gate** — Voice transcription itself is Green-tier (transcription is read-only). The resulting text command may trigger permission-gated actions, but that's handled downstream by the orchestrator.

### Git Intelligence (Recent Commits)

Last 5 commits show Epic 3 work:
- `98ed123` feat: inline keyboard actions & approvals (story 3.2)
- `3392b0b` feat: telegram group with topic threads (story 3.1)
- `715c16d` fix: bugs
- `01192e4` chore: remove pipeline disabled-test
- `83117e3` chore: update pipeline disabled-test

Pattern: commit message format is `feat: <description> (story X.Y)` — follow this for story 3.3.

### Project Structure Notes

- **New directory**: `suites/gemini-transcription/` (new suite)
- **New files**:
  - `suites/gemini-transcription/suite.ts` — suite manifest
  - `suites/gemini-transcription/agents/gemini-transcriber.ts` — agent definition (may be unused if direct API approach)
  - `suites/gemini-transcription/services/voice-transcriber.ts` — transcription service
  - `suites/gemini-transcription/__tests__/voice-transcriber.test.ts` — tests
- **Modified files**:
  - `packages/shared/src/types/events.ts` — add VoiceReceivedEvent
  - `packages/shared/src/suites/constants.ts` — add SUITE_GEMINI_TRANSCRIPTION, AGENT_GEMINI_TRANSCRIBER, MCP_GEMINI, SOURCE_GEMINI
  - `packages/shared/src/suites/index.ts` — re-export new constants
  - `suites/notifications/services/telegram-bot.ts` — add `message:voice` handler
  - `suites/notifications/__tests__/telegram-bot.test.ts` — extend with voice tests
  - `config/suites.json` — enable gemini-transcription suite
  - `.env.example` — add GOOGLE_API_KEY

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 3, Story 3.3]
- [Source: _bmad-output/planning-artifacts/prd.md — FR20, NFR22, NFR26]
- [Source: _bmad-output/planning-artifacts/architecture.md — Gemini MCP server, MCP isolation, error handling patterns]
- [Source: suites/notifications/services/telegram-bot.ts — message:text handler, event emission pattern, sendMessageWithFallback]
- [Source: suites/task-management/suite.ts — defineSuite() pattern]
- [Source: suites/task-management/agents/ticktick-agent.ts — defineAgent() pattern]
- [Source: suites/task-management/mcp.json — MCP declaration pattern]
- [Source: packages/shared/src/types/events.ts — BaseEvent, RavenEvent union, event type patterns]
- [Source: packages/shared/src/suites/constants.ts — suite/agent/mcp constant naming]
- [Source: _bmad-output/implementation-artifacts/3-2-inline-keyboard-actions-and-approvals.md — previous story learnings]
- [Source: _bmad-output/project-context.md — all coding conventions and critical rules]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Task 1: Created gemini-transcription suite structure — suite.ts, actions.json, constants, config entry
- Task 2: Decision made to use direct `@google/generative-ai` SDK instead of MCP (no reliable audio transcription MCP exists). Capabilities set to `['agent-definition']` (dropped `'mcp-server'`). Also dropped `MCP_GEMINI` constant as unnecessary.
- Task 3: Created agent definition at `agents/gemini-transcriber.ts` — kept for registry/discoverability even though service handles transcription directly
- Task 4: Extended `telegram-bot.ts` with `handleVoiceMessage()` function handling both `message:voice` and `message:video_note`. Includes auth checks, 20MB size limit, file download, base64 encoding, and `voice:received` event emission
- Task 5: Created `voice-transcriber.ts` service — subscribes to `voice:received`, calls Gemini with 30s AbortController timeout, emits `notification` + `user:chat:message` on success, handles timeout and API errors with user-friendly messages
- Task 6: Added `VoiceReceivedEvent` interface + `VoiceReceivedPayloadSchema` to shared types, added to `RavenEvent` union
- Task 7: Installed `@google/generative-ai` package, added `GOOGLE_API_KEY` to `.env.example`
- Task 8: Created 8 unit tests for voice-transcriber, 4 integration tests for telegram-bot voice handling. All 411 tests pass (0 regressions). `npm run check` passes (0 errors).

### Change Log

- 2026-03-14: Implemented story 3.3 — Gemini voice transcription skill (all 8 tasks complete)

### File List

- `suites/gemini-transcription/suite.ts` (new)
- `suites/gemini-transcription/actions.json` (new)
- `suites/gemini-transcription/agents/gemini-transcriber.ts` (new)
- `suites/gemini-transcription/services/voice-transcriber.ts` (new)
- `suites/gemini-transcription/__tests__/voice-transcriber.test.ts` (new)
- `packages/shared/src/suites/constants.ts` (modified)
- `packages/shared/src/suites/index.ts` (modified)
- `packages/shared/src/types/events.ts` (modified)
- `suites/notifications/services/telegram-bot.ts` (modified)
- `suites/notifications/__tests__/telegram-bot.test.ts` (modified)
- `config/suites.json` (modified)
- `.env.example` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
- `package.json` (modified — @google/generative-ai added to dependencies)
- `package-lock.json` (modified — @google/generative-ai added)
- `README.md` (modified — added GOOGLE_API_KEY + Telegram group env vars to env table)
