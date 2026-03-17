# Story 6.6: Knowledge Lifecycle & Retrospective

Status: done

## Story

As the system operator,
I want a weekly knowledge retrospective that summarizes brain changes, surfaces stale knowledge, and lets me decide what to keep, prioritize, remove, or snooze,
So that my second brain stays lean, relevant, and doesn't accumulate noise over time.

## Acceptance Criteria

1. **Weekly retrospective summary** — Given a week has passed since the last retrospective, when the retrospective pipeline triggers (scheduled), then a summary is generated: new bubbles added, bubbles updated, links created, domains changed, tags reorganized — delivered via Telegram or dashboard notification.

2. **Temporary bubble review** — Given knowledge bubbles exist with `temporary` permanence, when the retrospective runs, then each temporary bubble is presented for review: keep (upgrade to `normal`/`robust`), snooze (defer review for N days), or remove (delete bubble + source files from `data/media/`).

3. **Stale detection** — Given knowledge bubbles have not been accessed or referenced for a configurable period (default 30 days for `normal`, 7 days for `temporary`), when stale detection runs, then stale bubbles are surfaced with options: update with fresh content, snooze (stop asking for N days), shrink (merge with related bubbles), or remove completely.

4. **Merge execution** — Given the user chooses to shrink/merge stale knowledge, when the merge is executed, then related stale bubbles are combined into a single summary bubble (via LLM synthesis), old bubbles are removed, and links are re-pointed to the merged bubble.

5. **Robust immunity** — Given the user sets a bubble's permanence to `robust`, when retrieval scoring runs, then robust bubbles receive a priority boost in all retrieval results and are **never** flagged as stale.

6. **Default permanence** — Given knowledge has different permanence levels, when ingestion creates a new bubble, then the default permanence is `normal`; the user can override via API or conversational agent; homework/transient content can be marked `temporary` immediately.

## Tasks / Subtasks

- [x] **Task 1: Access tracking on Bubble nodes** (AC: #3, #5)
  - [x] 1.1 Add `lastAccessedAt` property to Bubble nodes in Neo4j
  - [x] 1.2 Update `knowledge-store.ts` `getById()` to bump `lastAccessedAt` on read
  - [x] 1.3 Update retrieval engine to bump `lastAccessedAt` when bubbles appear in search results
  - [x] 1.4 Add migration or property-set on startup for existing bubbles (set to `updatedAt`)

- [x] **Task 2: Staleness detection engine** (AC: #3, #5)
  - [x] 2.1 Create `packages/core/src/knowledge-engine/knowledge-lifecycle.ts`
  - [x] 2.2 Implement `detectStaleBubbles()` — Neo4j query: `normal` permanence + `lastAccessedAt` < (now - 30 days), `temporary` permanence + `lastAccessedAt` < (now - 7 days). Never include `robust`.
  - [x] 2.3 Implement configurable thresholds via env vars `RAVEN_STALE_DAYS_NORMAL` (default 30) and `RAVEN_STALE_DAYS_TEMPORARY` (default 7)
  - [x] 2.4 Implement snooze tracking — add `snoozedUntil` property on Bubble node; exclude snoozed bubbles from stale detection
  - [x] 2.5 Return `StaleBubble[]` with bubble metadata + `daysSinceAccess` + `reason`

- [x] **Task 3: Retrospective summary generator** (AC: #1)
  - [x] 3.1 Create `packages/core/src/knowledge-engine/retrospective.ts`
  - [x] 3.2 Implement `generateRetrospectiveSummary(since: string)` — queries Neo4j for: bubbles created/updated since date, links created, domain/tag changes
  - [x] 3.3 Return structured `RetrospectiveSummary` with counts and highlights (no LLM needed for stats)
  - [x] 3.4 Format summary as markdown for delivery via notification event

- [x] **Task 4: Lifecycle action handlers** (AC: #2, #3, #4)
  - [x] 4.1 Implement `snoozeBubble(id, days)` — sets `snoozedUntil` on Bubble node
  - [x] 4.2 Implement `removeBubbleWithMedia(id)` — deletes bubble via knowledge store + cleans up source files from `data/media/` if `sourceFile` is set
  - [x] 4.3 Implement `mergeBubbles(bubbleIds)` — uses LLM agent to synthesize content, creates new bubble with `derived-from` links, removes old bubbles, re-points incoming links to merged bubble
  - [x] 4.4 Implement `upgradePermanence(id, newLevel)` — updates bubble permanence (wraps existing `PATCH /api/knowledge/:id/permanence`)

- [x] **Task 5: REST API endpoints** (AC: #1, #2, #3, #4)
  - [x] 5.1 `GET /api/knowledge/stale` — returns stale bubbles with configurable `?days=` override
  - [x] 5.2 `POST /api/knowledge/:id/snooze` — body: `{ days: number }`
  - [x] 5.3 `POST /api/knowledge/merge` — body: `{ bubbleIds: string[] }`
  - [x] 5.4 `GET /api/knowledge/retrospective` — returns weekly summary; optional `?since=` ISO date
  - [x] 5.5 `POST /api/knowledge/retrospective/trigger` — manually trigger retrospective

- [x] **Task 6: Scheduled retrospective pipeline** (AC: #1)
  - [x] 6.1 Add default schedule: `knowledge:retrospective` task type, cron `0 9 * * 1` (Monday 9am)
  - [x] 6.2 Handle `schedule:triggered` with `taskType === 'knowledge:retrospective'` in orchestrator
  - [x] 6.3 On trigger: run stale detection + retrospective summary, emit `notification` event with formatted summary for Telegram/dashboard delivery
  - [x] 6.4 Include temporary bubble review list and stale bubble list in the notification

- [x] **Task 7: Event types and shared types** (AC: all)
  - [x] 7.1 Add to `packages/shared/src/types/knowledge.ts`: `StaleBubble`, `RetrospectiveSummary`, `SnoozeSchema`, `MergeBubblesSchema`
  - [x] 7.2 Add to `packages/shared/src/types/events.ts`: `KnowledgeRetrospectiveCompleteEvent`, `KnowledgeStaleBubblesDetectedEvent`
  - [x] 7.3 Add event types to `RavenEvent` union

- [x] **Task 8: Tests** (AC: all)
  - [x] 8.1 Unit tests for staleness detection (different permanence thresholds, snooze exclusion, robust immunity)
  - [x] 8.2 Unit tests for retrospective summary generation (counts, date filtering)
  - [x] 8.3 Integration tests for merge flow (LLM mock → synthesis → link re-pointing → old bubble removal)
  - [x] 8.4 Integration tests for snooze + remove with media cleanup
  - [x] 8.5 Integration test for API endpoints (stale, snooze, merge, retrospective)
  - [x] 8.6 Integration test for scheduled retrospective trigger via event bus

## Dev Notes

### Architecture Patterns to Follow

- **Factory function pattern** (no classes): `createKnowledgeLifecycle(deps)` and `createRetrospective(deps)` returning interface objects — same as `createKnowledgeStore`, `createMergeEngine`, `createContextInjector`
- **Neo4j for all graph queries**: Staleness detection, link re-pointing, and merge operations are all Neo4j Cypher queries. Do NOT use SQLite for knowledge data — it's Neo4j only since story 6.3 migration
- **Pino structured logging**: `createLogger('knowledge-lifecycle')` and `createLogger('retrospective')`
- **Event emission**: Use `eventBus.emit()` with `generateId()` for event IDs, `Date.now()` for timestamps
- **Async with error handling**: All handlers wrapped with `.catch()` — see orchestrator pattern

### Existing Code to Reuse (DO NOT Reinvent)

- **`knowledge-store.ts`** — `remove()` for bubble deletion, `getById()` for bubble reads, `update()` for permanence changes
- **`merge-ops.ts`** — `resolveMerge('accept')` for executing existing merge suggestions. The merge detection (`detectMerges()`) is already built — reuse it, don't rebuild
- **`link-ops.ts`** — Has link management functions. Use for re-pointing links during merge
- **`neo4j-client.ts`** — `query()`, `queryOne()`, `run()`, `withTransaction()` — use for all Cypher operations
- **`embeddings.ts`** — `generateEmbedding()` for the merged bubble's embedding after synthesis
- **`chunking.ts`** — `indexBubbleChunks()` for re-indexing the merged bubble's content
- **`context-injector.ts`** — Reference pattern for retrieving and formatting knowledge context
- **`knowledge-agent.ts`** — Reference pattern for agent definition creation with WebFetch to local REST API
- **Orchestrator `handleSchedule()`** — Existing pattern at line 118 shows how scheduled tasks are routed via `suiteRegistry.findSuiteForTaskType(taskType)`

### Key Technical Decisions

1. **`lastAccessedAt` tracking**: Add as Neo4j Bubble node property. Bump on `getById()` and when a bubble appears in retrieval results. For existing bubbles without this property, initialize to `updatedAt` value via a startup migration query:
   ```cypher
   MATCH (b:Bubble) WHERE b.lastAccessedAt IS NULL SET b.lastAccessedAt = b.updatedAt
   ```

2. **Snooze tracking**: Add `snoozedUntil` property (ISO 8601 string or null) to Bubble node. Stale detection query excludes bubbles where `snoozedUntil > now`.

3. **Merge synthesis**: Use agent task (via `agent:task:request` event) with LLM to generate merged content. The orchestrator should handle `knowledge:retrospective` task type by running stale detection + summary generation inline (not via agent), then use agent only for merge synthesis when user requests it.

4. **Retrospective delivery**: Emit a `notification` event with `channel: 'all'` containing the formatted markdown summary. The existing Telegram skill and web dashboard already consume notification events.

5. **Media cleanup on remove**: When deleting a bubble with `sourceFile` set, also delete the file from `data/media/` if it exists. Use `node:fs/promises` `unlink()` with error handling (file may already be gone).

6. **Schedule registration**: Add to `config/schedules.json` (or the `defaultSchedules` array in `index.ts`) with `id: 'knowledge-retrospective'`, `taskType: 'knowledge:retrospective'`, `cron: '0 9 * * 1'`.

### Database: Neo4j Properties to Add

On `Bubble` nodes:
- `lastAccessedAt: string` (ISO 8601) — tracks last read/retrieval access
- `snoozedUntil: string | null` (ISO 8601) — snooze expiry for stale detection

No new node types needed. No SQLite changes needed.

### New Event Types

```typescript
interface KnowledgeRetrospectiveCompleteEvent extends BaseEvent {
  type: 'knowledge:retrospective:complete';
  payload: {
    period: { since: string; until: string };
    bubblesCreated: number;
    bubblesUpdated: number;
    linksCreated: number;
    staleBubblesCount: number;
    temporaryBubblesCount: number;
  };
}

interface KnowledgeStaleBubblesDetectedEvent extends BaseEvent {
  type: 'knowledge:stale:detected';
  payload: {
    staleBubbleIds: string[];
    count: number;
  };
}
```

### New Shared Types

```typescript
interface StaleBubble {
  id: string;
  title: string;
  permanence: Permanence;
  lastAccessedAt: string;
  daysSinceAccess: number;
  reason: 'temporary-expired' | 'normal-stale';
  tags: string[];
  domains: string[];
}

interface RetrospectiveSummary {
  period: { since: string; until: string };
  bubblesCreated: { count: number; titles: string[] };
  bubblesUpdated: { count: number; titles: string[] };
  linksCreated: number;
  domainsChanged: number;
  tagsReorganized: number;
  staleBubbles: StaleBubble[];
  temporaryBubbles: StaleBubble[];
}

const SnoozeSchema = z.object({
  days: z.number().int().min(1).max(365),
});

const MergeBubblesSchema = z.object({
  bubbleIds: z.array(z.string().uuid()).min(2).max(10),
});
```

### Project Structure Notes

New files to create:
- `packages/core/src/knowledge-engine/knowledge-lifecycle.ts` — staleness detection, snooze, media cleanup
- `packages/core/src/knowledge-engine/retrospective.ts` — summary generation, retrospective orchestration
- `packages/core/src/__tests__/knowledge-lifecycle.test.ts` — all lifecycle + retrospective tests

Files to modify:
- `packages/shared/src/types/knowledge.ts` — add `StaleBubble`, `RetrospectiveSummary`, `SnoozeSchema`, `MergeBubblesSchema`
- `packages/shared/src/types/events.ts` — add `KnowledgeRetrospectiveCompleteEvent`, `KnowledgeStaleBubblesDetectedEvent`, add to `RavenEvent` union
- `packages/core/src/knowledge-engine/knowledge-store.ts` — bump `lastAccessedAt` in `getById()`
- `packages/core/src/knowledge-engine/retrieval.ts` — bump `lastAccessedAt` when bubbles returned in results
- `packages/core/src/api/routes/knowledge.ts` — add stale, snooze, merge, retrospective endpoints
- `packages/core/src/orchestrator/orchestrator.ts` — handle `knowledge:retrospective` task type in `handleSchedule()`
- `packages/core/src/index.ts` — wire lifecycle + retrospective modules, add default schedule

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 6.6 section]
- [Source: _bmad-output/planning-artifacts/architecture.md — Knowledge System, Scheduler, Event Bus sections]
- [Source: _bmad-output/planning-artifacts/prd.md — FR42-45, Journey 3 overnight knowledge maintenance]
- [Source: _bmad-output/implementation-artifacts/6-5-knowledge-management-agent-and-context-injection.md — Context injector pattern, orchestrator async handlers]
- [Source: packages/core/src/knowledge-engine/merge-ops.ts — Existing merge engine with vector similarity]
- [Source: packages/core/src/knowledge-engine/knowledge-store.ts — CRUD operations, Neo4j transaction patterns]
- [Source: packages/core/src/scheduler/scheduler.ts — Croner job registration, default schedule seeding]
- [Source: packages/core/src/orchestrator/orchestrator.ts:118 — handleSchedule() routing pattern]
- [Source: packages/shared/src/types/events.ts — Event type definitions and RavenEvent union]
- [Source: _bmad-output/project-context.md — All coding conventions and anti-patterns]

### Previous Story Intelligence (6.5)

**Key learnings to apply:**
- Regex global flag can cause state leaks — avoid `g` flag in parsers or reset between matches
- Always add NaN guards when parsing env var numbers: `const val = isNaN(parsed) ? DEFAULT : parsed`
- All orchestrator async handlers MUST be wrapped with `.catch()` — events silently drop errors
- Knowledge context retrieval failure must NEVER block the main operation (graceful degradation)
- WebFetch to local REST API is the preferred pattern for agent access to knowledge data (no MCP needed)
- When adding event payload fields, thread through the full chain: shared types → event emission → consumer

**Files touched in 6.5 that may need modification:**
- `orchestrator.ts` — will need new handler for `knowledge:retrospective` task type
- `index.ts` — will need lifecycle + retrospective wiring
- `packages/shared/src/types/events.ts` — new event types
- `packages/shared/src/types/knowledge.ts` — new shared types

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- Build: `npm run build` — passes (shared + core + web)
- Lint: `npm run check` — passes (format + eslint + tsc --noEmit)
- Tests: 23 new tests all pass, 719 total tests pass (6 pre-existing Docker failures unchanged)

### Completion Notes List
- **Task 1**: Added `lastAccessedAt` property to Bubble nodes. Set on insert, bumped on `getById()` read and retrieval search results. Backfill migration in `neo4j-client.ts ensureSchema()` sets existing bubbles' `lastAccessedAt` to `updatedAt`.
- **Task 2**: Created `knowledge-lifecycle.ts` with `detectStaleBubbles()` using Neo4j Cypher query. Configurable thresholds via `RAVEN_STALE_DAYS_NORMAL` (30) and `RAVEN_STALE_DAYS_TEMPORARY` (7) env vars with NaN guards. Excludes `robust` permanence and snoozed bubbles.
- **Task 3**: Created `retrospective.ts` with `generateSummary()` querying Neo4j for period stats, `formatSummaryMarkdown()` for readable output, and `runFullRetrospective()` emitting notification + completion events.
- **Task 4**: Implemented `snoozeBubble()`, `removeBubbleWithMedia()` (with `node:fs/promises` `unlink()` for media cleanup), `mergeBubbles()` (creates merged bubble, derived-from links, re-points incoming links, removes old bubbles, generates embedding + chunks), and `upgradePermanence()`.
- **Task 5**: Added 5 REST endpoints: `GET /api/knowledge/stale`, `POST /api/knowledge/:id/snooze`, `POST /api/knowledge/merge`, `GET /api/knowledge/retrospective`, `POST /api/knowledge/retrospective/trigger`.
- **Task 6**: Added `knowledge-retrospective` schedule to `config/schedules.json` (Monday 9am). Orchestrator handles `knowledge:retrospective` task type inline (no agent), running `retrospective.runFullRetrospective()`.
- **Task 7**: Added `StaleBubble`, `RetrospectiveSummary`, `SnoozeSchema`, `MergeBubblesSchema` to shared types. Added `KnowledgeRetrospectiveCompleteEvent`, `KnowledgeStaleBubblesDetectedEvent` to events and `RavenEvent` union.
- **Task 8**: 24 tests covering staleness detection (thresholds, robust immunity, snooze exclusion), retrospective summary (counts, date filtering, markdown formatting), merge flow (LLM synthesis, incoming + outgoing link re-pointing, cleanup), snooze + remove with media, schema validation, and scheduled trigger via event bus.

### Change Log
- 2026-03-17: Story 6.6 implementation complete — knowledge lifecycle & retrospective
- 2026-03-17: Code review fixes — M1: removed dead derived-from links (destroyed by DETACH DELETE); M2: added outgoing link re-pointing during merge; M3: added LLM synthesis via agent task with 30s timeout fallback to concatenation

### File List
New files:
- `packages/core/src/knowledge-engine/knowledge-lifecycle.ts`
- `packages/core/src/knowledge-engine/retrospective.ts`
- `packages/core/src/__tests__/knowledge-lifecycle.test.ts`

Modified files:
- `packages/shared/src/types/knowledge.ts` — added StaleBubble, RetrospectiveSummary, SnoozeSchema, MergeBubblesSchema
- `packages/shared/src/types/events.ts` — added KnowledgeRetrospectiveCompleteEvent, KnowledgeStaleBubblesDetectedEvent, updated RavenEvent union
- `packages/core/src/knowledge-engine/knowledge-store.ts` — lastAccessedAt on insert and getById
- `packages/core/src/knowledge-engine/retrieval.ts` — bumpAccessTimestamps on search results
- `packages/core/src/knowledge-engine/neo4j-client.ts` — lastAccessedAt backfill migration
- `packages/core/src/api/routes/knowledge.ts` — stale, snooze, merge, retrospective endpoints
- `packages/core/src/api/server.ts` — added knowledgeLifecycle and retrospective to ApiDeps
- `packages/core/src/orchestrator/orchestrator.ts` — inline handler for knowledge:retrospective schedule
- `packages/core/src/index.ts` — wired lifecycle, retrospective, linkEngine
- `config/schedules.json` — added knowledge-retrospective schedule
