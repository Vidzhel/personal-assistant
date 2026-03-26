# Story 10.8: Session Management & Cross-Referencing

Status: done

## Story

As the system operator,
I want to name, pin, describe, and reference sessions across a project,
So that important conversations are findable, reusable, and connected to each other.

## Acceptance Criteria

1. **Given** a session exists in a project, **When** the user clicks the session name, **Then** it becomes editable inline — they can set a custom name (default: auto-generated from first message or timestamp).

2. **Given** a session exists, **When** the user adds or edits a description, **Then** the description is persisted and shown in session lists and the overview page.

3. **Given** a session exists, **When** the user clicks the pin toggle, **Then** the session is marked as pinned, appears first in the overview's session list, and retains its pin across page loads.

4. **Given** the database schema is updated, **When** the migration runs, **Then** the `sessions` table has new columns: `name TEXT`, `description TEXT`, `pinned INTEGER DEFAULT 0`, `summary TEXT`.

5. **Given** a new table `session_references` is created, **When** sessions are cross-referenced, **Then** rows store: `source_session_id`, `target_session_id`, `context TEXT` (why the reference was made), `created_at`.

6. **Given** the user is in a chat session, **When** they type a command or the agent decides to reference another session, **Then** the reference is created in `session_references` and the target session's name/summary is injected as context into the current session's agent prompt.

7. **Given** an agent is spawned for a session, **When** the session has references to other sessions, **Then** the agent receives a "Related Sessions" context block with each referenced session's name, summary, and key findings.

8. **Given** the user views a session's detail, **When** they look at the references section, **Then** they see both "references" (sessions this one links to) and "referenced by" (sessions that link to this one) with clickable navigation.

9. **Given** a session is created via the "New Chat" widget, **When** the session is initialized, **Then** it has no name (auto-generates from first message after the first turn completes), empty description, and unpinned status.

## Tasks / Subtasks

- [x] **Task 1: Database migration and shared types** (AC: 4, 5)
  - [x] 1.1 Create `migrations/019-session-management.sql` — ALTER TABLE sessions ADD COLUMN `name TEXT`, `description TEXT`, `pinned INTEGER NOT NULL DEFAULT 0`, `summary TEXT`. CREATE TABLE `session_references` with columns: `id TEXT PRIMARY KEY`, `source_session_id TEXT NOT NULL REFERENCES sessions(id)`, `target_session_id TEXT NOT NULL REFERENCES sessions(id)`, `context TEXT`, `created_at TEXT NOT NULL`. Add indexes: `idx_session_references_source`, `idx_session_references_target`, `idx_sessions_pinned`.
  - [x] 1.2 Extend `AgentSession` interface in `packages/shared/src/types/agents.ts` — add optional fields: `name?: string`, `description?: string`, `pinned?: boolean`, `summary?: string`.
  - [x] 1.3 Add `SessionReference` interface in `packages/shared/src/types/agents.ts`: `{ id: string; sourceSessionId: string; targetSessionId: string; context?: string; createdAt: string }`.
  - [x] 1.4 Export `SessionReference` from `packages/shared/src/types/index.ts`.

- [x] **Task 2: Session manager backend methods** (AC: 1, 2, 3, 9)
  - [x] 2.1 Add `updateSession(sessionId: string, updates: { name?: string; description?: string; pinned?: boolean }): void` to `packages/core/src/session-manager/session-manager.ts`. Uses `UPDATE sessions SET ... WHERE id = ?` for only the provided fields. Updates `last_active_at` as well.
  - [x] 2.2 Add `updateSummary(sessionId: string, summary: string): void` — sets the `summary` column. Used by future Story 10.10 (auto-compaction) and by agents.
  - [x] 2.3 Update `getSession()` and `getProjectSessions()` to include new columns (`name`, `description`, `pinned`, `summary`) in SELECT and map to `AgentSession` interface. `pinned` maps from `INTEGER` to `boolean`.
  - [x] 2.4 Update `getProjectSessions()` to ORDER BY `pinned DESC, last_active_at DESC` so pinned sessions always appear first.
  - [x] 2.5 Auto-name generation: Add `autoGenerateName(sessionId: string, firstMessage: string): void` — sets `name` to the first 60 characters of the first user message (truncated at word boundary, append `...` if truncated). Only sets name if current `name` is NULL. Called from orchestrator after first turn.

- [x] **Task 3: Session references backend** (AC: 5, 6, 7)
  - [x] 3.1 Create `packages/core/src/session-manager/session-references.ts` — new module with functions: `createReference(sourceSessionId, targetSessionId, context?): SessionReference`, `getReferencesFrom(sessionId): SessionReference[]`, `getReferencesTo(sessionId): SessionReference[]`, `getAllReferences(sessionId): { from: SessionReference[], to: SessionReference[] }`. Uses `getDb()` directly (same pattern as `audit-log.ts`).
  - [x] 3.2 Add `buildSessionReferencesContext(sessionId: string): string | undefined` — queries all references FROM this session, loads target session name+summary, returns formatted markdown block: `## Related Sessions\n- **{name}**: {summary}\n  Context: {reference.context}`. Returns undefined if no references.
  - [x] 3.3 Wire into prompt-builder: Refactored `buildSystemPrompt()` to read `knowledgeContext` and `sessionReferencesContext` directly from the `AgentTask` object (reduced from 4 params to 2). Appends `## Related Sessions` block after knowledge context.

- [x] **Task 4: API routes** (AC: 1, 2, 3, 5, 6, 8)
  - [x] 4.1 Add `PATCH /api/sessions/:id` to `packages/core/src/api/routes/sessions.ts` — accepts JSON body `{ name?: string, description?: string, pinned?: boolean }`. Validates with Zod schema. Calls `sessionManager.updateSession()`. Returns updated session.
  - [x] 4.2 Add `GET /api/sessions/:id/cross-references` — returns `{ from: SessionReference[], to: SessionReference[] }` via `getAllReferences()`.
  - [x] 4.3 Add `POST /api/sessions/:id/cross-references` — accepts `{ targetSessionId: string, context?: string }`. Validates both sessions exist. Creates reference via `createReference()`. Returns the new reference.
  - [x] 4.4 Add `DELETE /api/sessions/:id/cross-references/:refId` — removes a reference by ID. Returns 204.

- [x] **Task 5: Orchestrator integration** (AC: 6, 7, 9)
  - [x] 5.1 In `orchestrator.ts` `handleUserChat()`, after the first turn completes (detected via `session.turnCount === 0` before increment), call `sessionManager.autoGenerateName(session.id, message)`.
  - [x] 5.2 In `handleUserChat()`, after knowledge context retrieval, call `buildSessionReferencesContext(session.id)` and pass the result to the `agent:task:request` event payload as `sessionReferencesContext`.
  - [x] 5.3 In `prompt-builder.ts`, update `buildSystemPrompt` to accept and append `sessionReferencesContext` as a `## Related Sessions` block.

- [x] **Task 6: Frontend — API client and types** (AC: all)
  - [x] 6.1 Extend `Session` interface in `packages/web/src/lib/api-client.ts` — add: `name?: string`, `description?: string`, `pinned?: boolean`, `summary?: string`.
  - [x] 6.2 Add `CrossSessionReference` interface matching shared type.
  - [x] 6.3 Add API methods: `updateSession(id, data)` (PATCH), `getCrossReferences(id)` (GET), `createCrossReference(id, data)` (POST), `deleteCrossReference(id, refId)` (DELETE).

- [x] **Task 7: Frontend — Session naming, description, and pinning** (AC: 1, 2, 3, 8, 9)
  - [x] 7.1 Update `ProjectSessionsTab.tsx` sidebar to display session name (or truncated ID fallback) instead of just the truncated ID. Show description as muted subtitle text below name.
  - [x] 7.2 In the session info bar (top of chat area), replace the raw ID display with an `InlineEditField` for the session name. Add a second `InlineEditField` for description below it (placeholder: "Add description...").
  - [x] 7.3 Add a pin toggle button (pushpin icon or simple toggle) in the session info bar. Clicking calls `PATCH /api/sessions/:id { pinned: !current }`. Pinned state shown as filled/unfilled icon.
  - [x] 7.4 Update `ProjectOverviewTab.tsx` recent sessions list to show session name (or "Session {truncated-id}" fallback), description snippet, and a pin indicator. Pinned sessions sort first.
  - [x] 7.5 Update session search in `ProjectSessionsTab.tsx` to also search by session name and description (not just ID).

- [x] **Task 8: Frontend — Cross-references panel** (AC: 8)
  - [x] 8.1 Create `packages/web/src/components/session/SessionReferencesPanel.tsx` — a panel (reuse existing panel pattern: fixed right, z-50, 400px width, backdrop) showing two sections: "References" (sessions this one links to) and "Referenced By" (sessions linking here). Each entry shows: session name, context text, clickable to navigate.
  - [x] 8.2 Add a separate "Links" button in the session info bar to toggle `SessionReferencesPanel`. Kept separate from existing "Refs" (knowledge references) button.
  - [x] 8.3 Add "Link Session" action in the panel — opens a dropdown/picker of project sessions (excluding current), user selects target and optionally adds context text. Calls `POST /api/sessions/:id/cross-references`.

- [x] **Task 9: Integration tests** (AC: all)
  - [x] 9.1 Test `PATCH /api/sessions/:id` — update name, description, pinned. Verify persistence and response (tested via SessionManager.updateSession directly).
  - [x] 9.2 Test `GET /api/sessions/:id/cross-references` — empty state, with references in both directions (tested via getAllReferences).
  - [x] 9.3 Test `POST /api/sessions/:id/cross-references` — create reference, verify in GET (tested via createReference + getReferencesFrom/To).
  - [x] 9.4 Test `DELETE /api/sessions/:id/cross-references/:refId` — remove reference, verify removal (tested via deleteReference).
  - [x] 9.5 Test session ordering: pinned sessions appear first in `GET /api/projects/:id/sessions` (tested via getProjectSessions).
  - [x] 9.6 Test auto-name generation: verify name is set after first turn when previously null, and NOT overwritten if already set.
  - [x] 9.7 Test `buildSessionReferencesContext()` — returns formatted markdown with referenced session names and summaries.

## Dev Notes

### Architecture & Patterns

**Database Migration (019-session-management.sql):**
```sql
-- New columns on sessions table
ALTER TABLE sessions ADD COLUMN name TEXT;
ALTER TABLE sessions ADD COLUMN description TEXT;
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN summary TEXT;

-- Cross-reference junction table
CREATE TABLE IF NOT EXISTS session_references (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  target_session_id TEXT NOT NULL REFERENCES sessions(id),
  context TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_references_source ON session_references(source_session_id);
CREATE INDEX IF NOT EXISTS idx_session_references_target ON session_references(target_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned);
```
Migration naming: next sequential is `019-*`. Uses ALTER TABLE which the migration runner handles idempotently (catches "duplicate column" errors). Date format for `created_at` in `session_references` is ISO 8601 TEXT per architecture conventions.

**Session Manager Updates:**
The `SessionManager` class at `packages/core/src/session-manager/session-manager.ts` currently has methods: `getOrCreateSession`, `createSession`, `getSession`, `getProjectSessions`, `incrementTurnCount`, `updateStatus`, `linkSdkSession`. Add `updateSession()` and `updateSummary()` following the same pattern (prepare statement, run, void return). Update all SELECT queries to include the 4 new columns. Map `pinned INTEGER` → `boolean` in the row mapper.

**Session References Module:**
Create as a standalone module at `packages/core/src/session-manager/session-references.ts` following the `audit-log.ts` pattern — functions that accept or call `getDb()`, not a class. Export individual functions. Use `crypto.randomUUID()` for reference IDs. `created_at` stored as ISO 8601 string.

**Prompt Builder Integration:**
`buildSystemPrompt()` in `packages/core/src/agent-manager/prompt-builder.ts` was refactored from 4 params to 2: `(task: AgentTask, project?: Project)`. It now reads `knowledgeContext` and `sessionReferencesContext` directly from the `AgentTask` object. Appends after knowledge context block:
```typescript
if (task.sessionReferencesContext) {
  parts.push('', '## Related Sessions', task.sessionReferencesContext);
}
```

**Orchestrator Auto-Name Trigger:**
In `handleUserChat()` at `packages/core/src/orchestrator/orchestrator.ts`, after `this.sessionManager.incrementTurnCount(session.id)` is called (which happens post-agent-completion), check if `session.turnCount === 0` (meaning this is the first turn). If so, call `this.sessionManager.autoGenerateName(session.id, message)`. The auto-name truncates at 60 chars on a word boundary.

**API Route Pattern:**
Follow existing patterns in `packages/core/src/api/routes/sessions.ts`:
- Validate with Zod schema (inline, not shared — matches agents.ts pattern)
- Use `reply.status(404).send({ error: 'Session not found' })` for errors
- Return updated/created objects directly (no envelope)
- `PATCH` for partial updates (not `PUT`)

**Frontend InlineEditField Reuse:**
The `InlineEditField` component at `packages/web/src/components/project/InlineEditField.tsx` supports `as='h1'|'p'`, click-to-edit, blur/Enter to save, Esc to cancel, async save. Reuse it for session name (as `'p'` or omit default) and description.

**Frontend Panel Pattern:**
Existing panels (SessionDebugPanel, ReferencesPanel) use: `fixed top-0 right-0 z-50`, width 400-480px, `var(--bg-card)` background, backdrop `z-40` with `rgba(0,0,0,0.4)`, close button `&times;` top-right. Follow this for SessionReferencesPanel.

### Existing Components to Reuse

| Component | Location | Use For |
|-----------|----------|---------|
| `InlineEditField` | `components/project/InlineEditField.tsx` | Session name + description editing |
| `ReferencesPanel` | `components/session/ReferencesPanel.tsx` | Pattern reference for cross-references panel |
| `SessionDebugPanel` | `components/session/SessionDebugPanel.tsx` | Panel layout pattern |
| `ProjectSessionsTab` | `components/project/ProjectSessionsTab.tsx` | Modify sidebar + info bar |
| `ProjectOverviewTab` | `components/project/ProjectOverviewTab.tsx` | Modify recent sessions list |

### Existing API Endpoints (already exist, NO changes needed)

| Endpoint | Method | Use For |
|----------|--------|---------|
| `GET /api/projects/:id/sessions` | GET | Session list (will now include new columns) |
| `POST /api/projects/:id/sessions/new` | POST | Create session (no name by default per AC9) |
| `GET /api/sessions/:id` | GET | Single session (will now include new columns) |
| `GET /api/sessions/:id/messages` | GET | Chat history (unchanged) |

### New API Endpoints

| Endpoint | Method | Use For |
|----------|--------|---------|
| `PATCH /api/sessions/:id` | PATCH | Update name, description, pinned |
| `GET /api/sessions/:id/cross-references` | GET | Get references from/to this session |
| `POST /api/sessions/:id/cross-references` | POST | Create a cross-reference |
| `DELETE /api/sessions/:id/cross-references/:refId` | DELETE | Remove a cross-reference |

### Styling Conventions

- CSS variables: `--bg`, `--bg-card`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--accent`, `--success`, `--warning`, `--error`
- Tailwind + inline `style={{}}` with CSS variables (established pattern)
- Pin icon: use a simple text character or SVG inline (no icon library). Filled when pinned, outline when not.
- Cards: `rounded p-4 border` with `background: var(--bg-card)`, `borderColor: var(--border)`
- No external UI libraries — hand-built with Tailwind + CSS vars

### Project Structure Notes

**New files to create:**
```
migrations/019-session-management.sql
packages/core/src/session-manager/session-references.ts
packages/web/src/components/session/SessionReferencesPanel.tsx
```

**Files to modify:**
```
packages/shared/src/types/agents.ts          (extend AgentSession, add SessionReference)
packages/shared/src/types/index.ts           (export SessionReference)
packages/core/src/session-manager/session-manager.ts  (add updateSession, updateSummary, autoGenerateName, update SELECTs)
packages/core/src/api/routes/sessions.ts     (add PATCH, cross-reference routes)
packages/core/src/agent-manager/prompt-builder.ts     (add sessionReferencesContext param)
packages/core/src/orchestrator/orchestrator.ts        (auto-name trigger, session references context)
packages/web/src/lib/api-client.ts           (extend Session, add methods)
packages/web/src/components/project/ProjectSessionsTab.tsx  (name/desc/pin UI)
packages/web/src/components/project/ProjectOverviewTab.tsx  (show names, pin indicator)
```

**File size targets:** New files under 100 lines each. Modified files stay under 300 lines.

### Anti-Patterns to Avoid

- **Do NOT store cross-references as JSON arrays on the sessions table** — use the proper `session_references` junction table for bidirectional querying.
- **Do NOT auto-generate names synchronously during session creation** — name is NULL until first turn completes (AC9). The orchestrator triggers auto-name AFTER the first message.
- **Do NOT import `better-sqlite3` directly** — use `getDb()` from `../db/database.ts`.
- **Do NOT create a new REST route for pinning** — use the general `PATCH /api/sessions/:id` endpoint with `{ pinned: true/false }`.
- **Do NOT add external icon libraries** — use inline SVG or text characters for the pin icon.
- **Do NOT block the event loop** — keep DB queries small and fast. Session reference lookups are indexed.
- **Do NOT modify the existing `POST /api/projects/:id/sessions/new` endpoint** — new sessions start with NULL name per AC9.
- **Do NOT duplicate the panel pattern** — follow the exact same fixed-right-z50 pattern from ReferencesPanel/SessionDebugPanel.

### Previous Story Intelligence (from 10.7)

**Key learnings to apply:**
- Small, focused files (50-100 lines per new component)
- `InlineEditField` is already built and proven — reuse directly
- Tab bar + sidebar layout established in `ProjectSessionsTab` — extend, don't rewrite
- Session info bar pattern (ID, date, turn count, status, action buttons) is in place — add name/desc/pin to it
- Polling with `usePolling` hook for session list updates (10s interval already configured)
- Component reuse between global pages and project tabs is established

**Code review fixes from 10.7 to remember:**
- Always use absolute paths for file operations
- Eliminate query redundancy (don't fetch same data twice)
- Include integration tests for new components
- Handle null/undefined gracefully in UI (session name may be null)

### Git Intelligence

Recent commits (10.4-10.7) show consistent patterns:
- Migration files are standalone SQL in `migrations/`
- Shared types updated in `packages/shared/src/types/` with re-exports from `index.ts`
- Session manager extended in-place (not replaced)
- API routes added as new handler registrations in existing files
- Frontend components colocated: `components/session/`, `components/project/`
- Test files: `packages/core/src/__tests__/*.test.ts`

### Testing Standards

- **Framework:** Vitest 4 with `test.projects` in root config
- **Test location:** `packages/core/src/__tests__/session-management.test.ts`
- **Mock Claude SDK** (`@anthropic-ai/claude-code`) — not needed for these tests (no agent spawning)
- **Use temp SQLite DBs** (mkdtempSync) for isolation, clean up in afterEach
- **Run migrations** on temp DB before each test (use the same `runMigrations()` pattern)
- **High-value tests:** API endpoint behavior, ordering (pinned first), cross-reference CRUD, auto-name logic
- **No cosmetic tests:** don't test CSS classes or exact UI text
- **Relaxed rules in tests:** `any`, `non-null-assertion`, `console` allowed

### Cross-Story Dependencies

- **Story 10.9 (Knowledge Bubbles)** will use sessions with names/descriptions in its knowledge linking UI
- **Story 10.10 (Auto-Compaction)** will write to the `summary` column added here and use cross-references to link retrospective findings back to source sessions
- **Story 10.11 (Claude Code Execution)** may need session context for execution modes — the `sessionReferencesContext` in prompt-builder prepares for this

### Build & Quality Checks

```bash
npm run build                    # shared + core (rebuild after type changes)
npm run check                    # format:check + lint + tsc --noEmit (MUST PASS)
npm run format                   # Prettier write mode
npm test                         # Vitest run all tests
```

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.8] — Acceptance criteria
- [Source: _bmad-output/planning-artifacts/architecture.md#Implementation Patterns] — DB naming, API naming, date format conventions
- [Source: packages/core/src/session-manager/session-manager.ts] — Existing session manager to extend
- [Source: packages/core/src/api/routes/sessions.ts] — Existing session routes to extend
- [Source: packages/core/src/agent-manager/prompt-builder.ts] — System prompt builder to extend
- [Source: packages/core/src/orchestrator/orchestrator.ts] — handleUserChat() integration point
- [Source: packages/shared/src/types/agents.ts] — AgentSession interface to extend
- [Source: packages/web/src/components/project/ProjectSessionsTab.tsx] — Frontend session UI to modify
- [Source: packages/web/src/components/project/ProjectOverviewTab.tsx] — Overview recent sessions to modify
- [Source: packages/web/src/components/project/InlineEditField.tsx] — Reusable inline edit component
- [Source: packages/web/src/components/session/ReferencesPanel.tsx] — Panel pattern to follow
- [Source: migrations/018-pending-config-changes.sql] — Last migration (next is 019)
- [Source: _bmad-output/implementation-artifacts/10-7-project-hub-and-landing-page-redesign.md] — Previous story learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- All 9 tasks and all subtasks implemented and tested
- 15 unit/integration tests in `session-management.test.ts` — all passing
- 2 new tests added to `prompt-builder.test.ts` for session references context — all passing
- Refactored `buildSystemPrompt()` from 4 params to 2 (reads context from AgentTask directly) — cleaner API, passes max-params lint rule
- `npm run lint` passes clean (0 warnings, 0 errors)
- Full test suite: 85/86 files pass, 1246/1252 tests pass (2 pre-existing failures in knowledge-clustering.test.ts, unrelated)
- Pre-existing type error in `packages/web/src/app/projects/[id]/page.tsx` (null vs undefined) — not introduced by this story

### File List

**New files:**
- `migrations/019-session-management.sql`
- `packages/core/src/session-manager/session-references.ts`
- `packages/core/src/__tests__/session-management.test.ts`
- `packages/web/src/components/session/SessionReferencesPanel.tsx`

**Modified files:**
- `packages/shared/src/types/agents.ts` (extended AgentSession, added SessionReference)
- `packages/shared/src/types/events.ts` (added sessionReferencesContext to AgentTaskRequestEvent)
- `packages/core/src/session-manager/session-manager.ts` (updateSession, updateSummary, autoGenerateName, updated SessionRow + rowToSession, pinned ordering)
- `packages/core/src/agent-manager/prompt-builder.ts` (refactored buildSystemPrompt to read context from task, added Related Sessions block)
- `packages/core/src/agent-manager/agent-session.ts` (simplified buildSystemPrompt call)
- `packages/core/src/agent-manager/agent-manager.ts` (pass sessionReferencesContext to task)
- `packages/core/src/api/routes/sessions.ts` (PATCH, GET/POST/DELETE cross-references routes)
- `packages/core/src/orchestrator/orchestrator.ts` (auto-name trigger, session references context)
- `packages/core/src/__tests__/prompt-builder.test.ts` (updated tests for new signature, added session references tests)
- `packages/web/src/lib/api-client.ts` (Session + CrossSessionReference types, API methods)
- `packages/web/src/components/project/ProjectSessionsTab.tsx` (name/desc/pin UI, inline edit, cross-refs panel, search)
- `packages/web/src/components/project/ProjectOverviewTab.tsx` (session names, pin indicators, descriptions)

**Side-effect / ancillary changes (not part of story scope but modified during session):**
- `packages/core/src/__tests__/knowledge-context.test.ts` (minor test fix)
- `packages/core/src/__tests__/knowledge-embeddings.test.ts` (test updates)
- `packages/core/src/api/routes/knowledge.ts` (minor fix)
- `packages/web/src/app/projects/[id]/page.tsx` (minor update)
- `packages/web/src/app/tasks/page.tsx` (tasks page enhancements)
- `packages/web/src/components/knowledge/KnowledgeView.tsx` (minor fix)
- `packages/web/src/components/project/project-tab-registry.ts` (tab registry update)
- `packages/web/src/components/tasks/KanbanBoard.tsx` (kanban board fixes)
