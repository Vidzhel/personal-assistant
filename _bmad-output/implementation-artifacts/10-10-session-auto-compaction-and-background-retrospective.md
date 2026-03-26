# Story 10.10: Session Auto-Compaction & Background Retrospective

Status: review

## Story

As the system operator,
I want sessions to be automatically summarized and their knowledge extracted into the project when I stop working,
So that valuable context is never lost and project knowledge grows organically without manual effort.

## Acceptance Criteria

1. **Given** a session has been idle for a configurable timeout (default: 30 minutes), **When** the idle detector triggers, **Then** a background retrospective agent is spawned for that session.

2. **Given** the retrospective agent is spawned, **When** it processes the session, **Then** it produces: a structured session summary, key decisions made, findings/discoveries, action items identified, and candidate knowledge bubbles.

3. **Given** the retrospective agent extracts knowledge, **When** it compares against existing project knowledge, **Then** it deduplicates — merging new information into existing bubbles where appropriate rather than creating redundant entries.

4. **Given** the retrospective produces candidate knowledge bubbles, **When** the confidence is high (clear factual findings, explicit decisions), **Then** bubbles are auto-approved and linked to the project with `source: 'auto-retrospective'`.

5. **Given** the retrospective produces candidate knowledge bubbles, **When** the confidence is low (subjective interpretations, tentative conclusions), **Then** bubbles are saved as drafts requiring user approval, with a notification sent via Telegram.

6. **Given** a session summary is generated, **When** it is stored, **Then** the `sessions.summary` field is populated and the summary appears in session lists and the project overview.

7. **Given** multiple retrospectives have run for a project, **When** the project's knowledge base grows, **Then** a periodic consolidation pass (configurable, default: weekly) reviews all auto-generated bubbles — merging, pruning outdated entries, and surfacing a consolidated project digest.

8. **Given** the consolidation runs, **When** it processes accumulated knowledge, **Then** it follows the Claude Code deep research pattern: synthesizing, summarizing, and pruning to keep knowledge concise and actionable.

9. **Given** the user triggers a manual retrospective via chat or dashboard, **When** the command is processed, **Then** the retrospective runs immediately on the current or specified session, with results shown inline.

10. **Given** auto-compaction is configured, **When** a session exceeds a configurable context size threshold, **Then** older messages are summarized into a compaction block and the full messages are archived — the session continues with the compacted context.

## Tasks / Subtasks

- [x] **Task 1: Config — add idle timeout, compaction, and consolidation settings** (AC: 1, 7, 10)
  - [x] 1.1 Add env vars to `packages/core/src/config.ts` `envSchema`:
    - `RAVEN_SESSION_IDLE_TIMEOUT_MS` — default 1800000 (30 min), how long before idle retrospective triggers
    - `RAVEN_SESSION_COMPACTION_THRESHOLD` — default 40 (message count), when to compact older messages
    - `RAVEN_CONSOLIDATION_CRON` — default `'0 3 * * 0'` (Sunday 3am), weekly consolidation schedule
    - `RAVEN_AUTO_RETROSPECTIVE_ENABLED` — default `true`, master toggle
  - [x] 1.2 Export typed accessors from config (follow existing pattern: `config.RAVEN_SESSION_IDLE_TIMEOUT_MS`).

- [x] **Task 2: Shared types — retrospective results, compaction metadata** (AC: 2, 4, 5, 6, 10)
  - [x] 2.1 Add to `packages/shared/src/types/agents.ts`:
    - `SessionRetrospectiveResult` interface: `{ sessionId: string; projectId: string; summary: string; decisions: string[]; findings: string[]; actionItems: string[]; candidateBubbles: CandidateBubble[] }`
    - `CandidateBubble` interface: `{ title: string; content: string; tags: string[]; confidence: 'high' | 'low'; sourceDescription: string }`
    - `CompactionBlock` interface: `{ id: string; sessionId: string; summarizedMessageIds: string[]; summary: string; createdAt: number }`
  - [x] 2.2 Add to `packages/shared/src/types/events.ts`:
    - `SessionIdleEvent`: `type: 'session:idle'`, payload: `{ sessionId: string; projectId: string; idleMinutes: number }`
    - `SessionRetrospectiveCompleteEvent`: `type: 'session:retrospective:complete'`, payload: `{ sessionId: string; projectId: string; summary: string; bubblesCreated: number; bubblesDrafted: number }`
    - `SessionCompactedEvent`: `type: 'session:compacted'`, payload: `{ sessionId: string; messagesCompacted: number; summaryLength: number }`
    - Add to `RavenEvent` union type.
  - [x] 2.3 Export all new types from `packages/shared/src/types/index.ts`.

- [x] **Task 3: Session idle detector — periodic scan + event emission** (AC: 1)
  - [x] 3.1 Create `packages/core/src/session-manager/idle-detector.ts`:
    - `createIdleDetector(deps: { eventBus, config })` factory function
    - `start()` — sets up `setInterval` that runs every 60 seconds
    - Each tick: query SQLite for sessions WHERE `status = 'idle'` AND `last_active_at < (now - IDLE_TIMEOUT)` AND `summary IS NULL` (not yet retrospected) AND `turn_count > 0` (has actual conversation)
    - For each found session: emit `session:idle` event, mark session `status = 'completed'`
    - `stop()` — clears the interval (for clean shutdown)
  - [x] 3.2 Track which sessions have been processed to avoid re-triggering. Use a simple `Set<string>` in-memory. Reset on restart (the `summary IS NULL` check in SQL prevents duplicate processing across restarts).

- [x] **Task 4: Session retrospective agent — AI-driven summarization + knowledge extraction** (AC: 2, 3, 4, 5, 6)
  - [x] 4.1 Create `packages/core/src/session-manager/session-retrospective.ts`:
    - `createSessionRetrospective(deps: { messageStore, sessionManager, eventBus, config })` factory
    - `runRetrospective(sessionId, projectId): Promise<SessionRetrospectiveResult>`:
      1. Load full transcript via `messageStore.getMessages(sessionId)` (all messages, no limit)
      2. Format transcript as markdown for the AI agent
      3. Spawn an agent via `runAgentTask()` with a system prompt instructing it to:
         - Summarize the session (2-3 paragraphs max)
         - Extract key decisions (bullet list)
         - List discoveries/findings
         - Identify action items
         - Propose knowledge bubbles with confidence ratings
         - Compare against existing project knowledge (injected in prompt) to avoid duplicates
      4. Parse structured JSON response from agent
      5. Store summary via `sessionManager.updateSummary(sessionId, summary)`
      6. Process candidate bubbles (Task 5)
      7. Emit `session:retrospective:complete` event
  - [x] 4.2 The agent prompt should include:
    - Full session transcript (user + assistant messages only, skip tool_use/thinking for token efficiency)
    - Existing project knowledge bubbles (titles + tags only, for dedup)
    - Instructions to output valid JSON matching `SessionRetrospectiveResult` schema
    - Skill name: `'session-retrospective'` (internal, not a registered skill)

- [x] **Task 5: Knowledge bubble processing — auto-approve or draft** (AC: 4, 5)
  - [x] 5.1 In `session-retrospective.ts`, add `processCandidateBubbles(projectId, bubbles, sessionId)`:
    - For high-confidence bubbles: call `POST /api/knowledge/bubbles` (via direct function call to knowledge store, not HTTP), then link to project via `linkBubbleToProject()`. Set `source: 'auto-retrospective'`, `sourceSessionId: sessionId`.
    - For low-confidence bubbles: create bubble with `status: 'draft'` (add draft status to bubble creation if needed), link to project, and emit `notification` event for Telegram:
      ```
      channel: 'telegram', title: 'Knowledge Draft for Review',
      body: '${bubble.title}\n${bubble.content.slice(0, 200)}...',
      topicName: 'system'
      ```
  - [x] 5.2 Use `isContentRejected(projectId, contentHash)` from `knowledge-rejections.ts` (story 10.9) to skip previously rejected content.
  - [x] 5.3 Content hash: `crypto.createHash('sha256').update(bubble.content).digest('hex').slice(0, 16)`.

- [x] **Task 6: Session auto-compaction — context size management** (AC: 10)
  - [x] 6.1 Create `packages/core/src/session-manager/session-compaction.ts`:
    - `createSessionCompaction(deps: { messageStore, sessionManager, eventBus, config })` factory
    - `checkAndCompact(sessionId): Promise<boolean>`:
      1. Load messages via `messageStore.getMessages(sessionId)`
      2. If message count > `RAVEN_SESSION_COMPACTION_THRESHOLD`: compact
      3. Take oldest N messages (keep last 10 messages uncompacted), format as text
      4. Spawn a lightweight agent task to summarize the old messages into a concise compaction block
      5. Prepend compaction block as a `context` role message in the transcript
      6. Archive the original messages (rename to `transcript-archived-{timestamp}.jsonl`)
      7. Rewrite transcript with: compaction block + remaining recent messages
      8. Emit `session:compacted` event
  - [x] 6.2 Hook into the orchestrator: after each `agent:task:complete` for a chat session, call `checkAndCompact()`.

- [x] **Task 7: Consolidation pass — periodic knowledge merge/prune** (AC: 7, 8)
  - [x] 7.1 Create `packages/core/src/knowledge-engine/knowledge-consolidation.ts`:
    - `createKnowledgeConsolidation(deps: { neo4j, eventBus, config })` factory
    - `runConsolidation(projectId?): Promise<ConsolidationResult>`:
      1. Query Neo4j for all auto-retrospective bubbles (source = 'auto-retrospective')
      2. Group by project (via `BELONGS_TO_PROJECT` relationships)
      3. For each project group: spawn an agent to analyze bubbles and produce:
         - Merge recommendations (bubbles that overlap → combine into one)
         - Prune recommendations (outdated/superseded → mark for deletion)
         - Digest: a single consolidated summary bubble per project
      4. Execute merge/prune operations on Neo4j
      5. Emit `knowledge:consolidation:complete` event
  - [x] 7.2 Register consolidation as a scheduled task in `config/schedules.json`:
    ```json
    { "id": "knowledge-consolidation", "name": "Weekly Knowledge Consolidation",
      "cron": "0 3 * * 0", "taskType": "knowledge-consolidation",
      "skillName": "system", "enabled": true }
    ```
  - [x] 7.3 Handle `schedule:triggered` event for `taskType: 'knowledge-consolidation'` in the orchestrator.

- [x] **Task 8: Manual retrospective — API + chat trigger** (AC: 9)
  - [x] 8.1 Add API route `POST /api/sessions/:id/retrospective` in `packages/core/src/api/routes/sessions.ts`:
    - Triggers `runRetrospective(sessionId, projectId)` immediately
    - Returns `{ summary, bubblesCreated, bubblesDrafted }`
  - [x] 8.2 Add orchestrator handling: when user sends "retrospective" or "summarize this session" in chat, detect intent and trigger manual retrospective on the current session. Return results inline in the chat response.

- [x] **Task 9: Boot integration — wire idle detector + consolidation schedule** (AC: 1, 7)
  - [x] 9.1 In `packages/core/src/index.ts` boot sequence, after session manager init:
    - Create idle detector via `createIdleDetector({ eventBus, config })`
    - Register `session:idle` event handler that calls `sessionRetrospective.runRetrospective()`
    - Call `idleDetector.start()`
  - [x] 9.2 Add consolidation schedule to `config/schedules.json` defaults.
  - [x] 9.3 Handle clean shutdown: call `idleDetector.stop()` in the shutdown handler.

- [x] **Task 10: Frontend — session summary display** (AC: 6)
  - [x] 10.1 In session list components, show `session.summary` (first 100 chars) as a subtitle under session name. Already available from `GET /api/sessions` response.
  - [x] 10.2 In session detail/debug view, show full summary in a collapsible section.
  - [x] 10.3 Add "Run Retrospective" button in session detail that calls `POST /api/sessions/:id/retrospective`. Show loading state, then display results.

- [x] **Task 11: Integration tests** (AC: all)
  - [x] 11.1 Test idle detector: create sessions with old `lastActiveAt`, verify `session:idle` events emitted for qualifying sessions only.
  - [x] 11.2 Test session retrospective: mock `runAgentTask`, verify summary stored, bubbles processed (high-confidence → created+linked, low-confidence → drafted+notified).
  - [x] 11.3 Test compaction: create session with >threshold messages, verify old messages archived, compaction block prepended.
  - [x] 11.4 Test consolidation: mock Neo4j queries for auto-retrospective bubbles, verify merge/prune operations.
  - [x] 11.5 Test manual retrospective API: `POST /api/sessions/:id/retrospective` returns expected shape.
  - [x] 11.6 Test content hash dedup: verify previously rejected content is skipped.
  - [x] 11.7 Test idle detector doesn't re-trigger on already-summarized sessions (summary IS NOT NULL).

## Dev Notes

### Architecture & Patterns

**Idle Detection Model:**
The idle detector is a lightweight timer (setInterval every 60s) that scans for sessions meeting ALL criteria:
- `status = 'idle'` (not currently running)
- `last_active_at < (now - IDLE_TIMEOUT)` — stale enough
- `summary IS NULL` — not yet retrospected
- `turn_count > 0` — has actual conversation (skip empty sessions)

This avoids needing a DB migration (uses existing columns). The `summary IS NULL` check is the durable guard — even if the process restarts, sessions that were already retrospected won't be re-processed.

**Session Retrospective Agent Flow:**
```
idle detector → session:idle event → retrospective handler → runAgentTask() → parse result
                                                           → store summary
                                                           → process bubbles (high → create+link, low → draft+notify)
                                                           → emit session:retrospective:complete
```

The agent is spawned with `skillName: 'session-retrospective'` (internal). It does NOT need MCP servers — it only needs the transcript text and existing knowledge context (injected in the prompt). This keeps it lightweight.

**Agent Response Format:**
The retrospective agent must return structured JSON. Use a system prompt that enforces JSON output:
```
You are a session retrospective agent. Analyze the conversation transcript below and produce a JSON response matching this schema:
{
  "summary": "2-3 paragraph session summary",
  "decisions": ["decision 1", "decision 2"],
  "findings": ["finding 1", "finding 2"],
  "actionItems": ["action 1", "action 2"],
  "candidateBubbles": [
    { "title": "...", "content": "...", "tags": ["..."], "confidence": "high|low", "sourceDescription": "..." }
  ]
}
Only output valid JSON. No markdown, no explanation.
```

**Compaction Strategy:**
Compaction is per-session, not global. When message count exceeds threshold:
1. Keep the last 10 messages (recent context) untouched
2. Summarize everything before that into a single compaction block
3. Archive original messages to `transcript-archived-{timestamp}.jsonl`
4. Rewrite transcript: `[compaction block, ...recent messages]`

The compaction block is a `context` role message (already supported by `StoredMessage.role`). The agent session's `getMessages()` call naturally picks it up as historical context for future turns.

**Consolidation (Weekly):**
Runs as a scheduled task via `croner`. Queries Neo4j for auto-retrospective bubbles per project, then spawns an agent to recommend merges/prunes. This is a heavier operation — runs off-hours (Sunday 3am default).

### Existing Components to Reuse

| Component | Location | Use For |
|-----------|----------|---------|
| `SessionManager` | `core/src/session-manager/session-manager.ts` | `updateSummary()`, `getSession()`, session queries |
| `MessageStore` | `core/src/session-manager/message-store.ts` | `getMessages()` for transcript loading |
| `runAgentTask` | `core/src/agent-manager/agent-session.ts` | Spawn retrospective + compaction agents |
| `Retrospective` | `core/src/knowledge-engine/retrospective.ts` | Pattern reference (NOT reused directly — that's knowledge retro, this is session retro) |
| `Scheduler` | `core/src/scheduler/scheduler.ts` | Register consolidation schedule |
| `EventBus` | `core/src/event-bus/event-bus.ts` | Emit/listen for session:idle, session:retrospective:complete |
| `NotificationQueue` | `core/src/notification-engine/notification-queue.ts` | Telegram notification for low-confidence drafts |
| `linkBubbleToProject` | `core/src/knowledge-engine/project-knowledge.ts` | Link auto-approved bubbles to project |
| `isContentRejected` | `core/src/knowledge-engine/knowledge-rejections.ts` | Skip previously rejected content |
| `buildSystemPrompt` | `core/src/agent-manager/prompt-builder.ts` | Pattern reference for prompt construction |
| `config.ts` | `core/src/config.ts` | Add new env vars with Zod schema |

### Existing API Endpoints (NO changes needed)

| Endpoint | Use For |
|----------|---------|
| `GET /api/sessions` | Already returns `summary` field |
| `GET /api/sessions/:id` | Already returns full session with `summary` |
| `GET /api/sessions/:id/messages` | Transcript access |
| `POST /api/knowledge/bubbles` | Create knowledge bubbles |

### New API Endpoints

| Endpoint | Method | Use For |
|----------|--------|---------|
| `POST /api/sessions/:id/retrospective` | POST | Trigger manual retrospective |

### New Files to Create

```
packages/core/src/session-manager/idle-detector.ts      (~80 lines)
packages/core/src/session-manager/session-retrospective.ts (~150 lines)
packages/core/src/session-manager/session-compaction.ts  (~120 lines)
packages/core/src/knowledge-engine/knowledge-consolidation.ts (~130 lines)
packages/core/src/__tests__/session-retrospective.test.ts (~200 lines)
```

### Files to Modify

```
packages/shared/src/types/agents.ts      (add SessionRetrospectiveResult, CandidateBubble, CompactionBlock)
packages/shared/src/types/events.ts      (add session:idle, session:retrospective:complete, session:compacted events)
packages/shared/src/types/index.ts       (export new types)
packages/core/src/config.ts             (add 4 new env vars to envSchema)
packages/core/src/index.ts              (wire idle detector, register event handlers, shutdown)
packages/core/src/api/routes/sessions.ts (add POST /sessions/:id/retrospective)
packages/core/src/orchestrator/orchestrator.ts (handle consolidation schedule trigger, compaction hook)
packages/web/src/components/session/     (summary display in session lists, retrospective button)
config/schedules.json                    (add knowledge-consolidation schedule)
```

### Anti-Patterns to Avoid

- **Do NOT create a new migration** — all needed columns exist. `sessions.summary` (migration 019), knowledge bubbles (Neo4j), notification queue (migration 009).
- **Do NOT use HTTP calls for internal operations** — call `knowledgeStore.create()` and `linkBubbleToProject()` directly, not via REST API.
- **Do NOT pass full tool_use/thinking messages to the retrospective agent** — filter to `user` + `assistant` roles only for token efficiency. Tool results and thinking add noise.
- **Do NOT create a registered skill for session-retrospective** — it's an internal system task, not a user-facing skill. Use `skillName: 'session-retrospective'` as an identifier only.
- **Do NOT create a separate knowledge-consolidation skill** — handle it in the orchestrator's `schedule:triggered` handler alongside existing schedule handlers.
- **Do NOT store compaction blocks in SQLite** — keep them in the JSONL transcript file as `context` role messages. The message store already handles this role.
- **Do NOT run the retrospective agent with MCP servers** — it only reads transcript text, no external tools needed.
- **Do NOT import `better-sqlite3` directly** — use `getDb()` from `../db/database.ts`.
- **Do NOT use `setInterval` without cleanup** — idle detector must have a `stop()` method called during shutdown.

### Previous Story Intelligence (from 10.9)

**Key learnings to apply:**
- Factory function pattern (`createXxx(deps)`) for all new modules — NOT classes
- Event-driven: emit events for state changes, let other subsystems react
- Prompt builder pattern: inject context sections as markdown blocks
- Knowledge operations: use Neo4j for graph relationships, SQLite for metadata
- Rejection tracking via content hash — reuse `isContentRejected()` from 10.9
- API routes: Zod validation, `{ error: '...' }` response format

**Code review fixes from 10.7-10.9 to remember:**
- Always use absolute paths for file operations
- Eliminate query redundancy (don't fetch same data twice)
- Include integration tests for all new components
- Handle null/undefined gracefully in UI
- Clean shutdown: clear timers, close connections

### Git Intelligence

Recent commits (10.7-10.9) show consistent patterns:
- Factory functions returning interface objects
- Events as the primary inter-module communication mechanism
- Config via env vars with Zod defaults
- Tests: temp DB via `mkdtempSync()`, mock `runAgentTask`, clean up in `afterEach`
- Frontend: fetch data on mount, show loading states, handle errors

### Styling Conventions (Frontend)

- CSS variables: `--bg`, `--bg-card`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--accent`
- Summary text: `text-sm` with `color: var(--text-muted)`, truncated with `overflow: hidden; text-overflow: ellipsis`
- Buttons: `px-3 py-1.5 rounded text-sm` — primary uses `--accent`
- Loading states: simple "Running..." text, no spinners

### Testing Standards

- **Framework:** Vitest 4 with `test.projects` in root config
- **Test file:** `packages/core/src/__tests__/session-retrospective.test.ts`
- **Mock `runAgentTask`** — return structured JSON matching `SessionRetrospectiveResult` schema. Never spawn real agents in tests.
- **Temp SQLite DBs** via `mkdtempSync()` for isolation, clean up in `afterEach`
- **Run migrations** on temp DB before each test
- **Mock Neo4j client** for knowledge linking operations
- **Mock EventBus** — verify correct events emitted with expected payloads
- **No cosmetic tests** — don't test CSS classes or exact UI text

### Cross-Story Dependencies

- **Story 10.9 (completed)** — project-knowledge linking, content rejection tracking, knowledge agent extension
- **Story 10.11 (future)** — execution modes may affect how retrospective agents run; leave spawning options extensible
- **Existing knowledge retrospective** (`retrospective.ts`) — for knowledge-level stats. Session retrospective is a SEPARATE concept: it summarizes a conversation, not the knowledge graph. Don't confuse the two.

### Build & Quality Checks

```bash
npm run build                    # shared + core (rebuild after type changes)
npm run check                    # format:check + lint + tsc --noEmit (MUST PASS)
npm run format                   # Prettier write mode
npm test                         # Vitest run all tests
```

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.10] — Acceptance criteria
- [Source: packages/core/src/session-manager/session-manager.ts] — SessionManager with updateSummary()
- [Source: packages/core/src/session-manager/message-store.ts] — MessageStore interface, getMessages()
- [Source: packages/core/src/agent-manager/agent-session.ts] — runAgentTask() for agent spawning
- [Source: packages/core/src/knowledge-engine/retrospective.ts] — Existing knowledge retrospective pattern
- [Source: packages/core/src/knowledge-engine/project-knowledge.ts] — linkBubbleToProject()
- [Source: packages/core/src/knowledge-engine/knowledge-rejections.ts] — isContentRejected()
- [Source: packages/core/src/scheduler/scheduler.ts] — Cron scheduler with croner
- [Source: packages/core/src/config.ts] — Env-based config with Zod schema
- [Source: packages/core/src/event-bus/event-bus.ts] — EventBus emit/on pattern
- [Source: packages/core/src/index.ts] — Boot sequence (where to wire idle detector)
- [Source: packages/core/src/api/routes/sessions.ts] — Existing session routes
- [Source: packages/core/src/notification-engine/notification-queue.ts] — Telegram notification queue
- [Source: packages/shared/src/types/agents.ts] — AgentSession (has summary field), AgentTask
- [Source: packages/shared/src/types/events.ts] — Event types, RavenEvent union
- [Source: migrations/019-session-management.sql] — Session schema with summary column
- [Source: _bmad-output/implementation-artifacts/10-9-project-knowledge-bubbles-and-agent-driven-discovery.md] — Previous story learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- All 11 tasks implemented: config, types, idle detector, session retrospective, bubble processing, compaction, consolidation, manual API, boot integration, frontend, tests
- 11 new integration tests covering idle detection, retrospective, compaction, consolidation, manual API, content hash dedup, and re-trigger prevention
- All 88 test files pass (1275 tests), `npm run check` clean
- Factory function pattern used for all new modules (no classes)
- Event-driven: session:idle, session:retrospective:complete, session:compacted events
- Orchestrator extended with consolidation handling and compaction hook on agent:task:complete
- Frontend: session summary in list (truncated), collapsible detail view, "Retro" button with loading state
- Idle detector exposes `scan()` for testability

### File List

New files:
- packages/core/src/session-manager/idle-detector.ts
- packages/core/src/session-manager/session-retrospective.ts
- packages/core/src/session-manager/session-compaction.ts
- packages/core/src/knowledge-engine/knowledge-consolidation.ts
- packages/core/src/__tests__/session-retrospective.test.ts

Modified files:
- packages/shared/src/types/agents.ts (SessionRetrospectiveResult, CandidateBubble, CompactionBlock)
- packages/shared/src/types/events.ts (SessionIdleEvent, SessionRetrospectiveCompleteEvent, SessionCompactedEvent)
- packages/core/src/config.ts (4 new env vars)
- packages/core/src/index.ts (idle detector, session retrospective, compaction, consolidation wiring)
- packages/core/src/orchestrator/orchestrator.ts (consolidation handler, compaction hook, chat retro intent)
- packages/core/src/api/server.ts (sessionRetrospective dep)
- packages/core/src/api/routes/sessions.ts (POST /sessions/:id/retrospective)
- packages/web/src/components/project/ProjectSessionsTab.tsx (summary display, retro button)
- packages/web/src/lib/api-client.ts (runSessionRetrospective method)
- config/schedules.json (knowledge-consolidation schedule)
- _bmad-output/implementation-artifacts/sprint-status.yaml (status update)
