# Story 7.1: Background Pattern Analysis Engine

Status: done

## Story

As the system operator,
I want Raven to analyze patterns across all connected services in the background,
So that insights surface without me having to ask.

## Acceptance Criteria

1. **Pattern Detection with Insight Generation** — Given the pattern analysis runs on schedule, when it detects a meaningful pattern (e.g., "4 meetings this week with zero deep work blocks"), then an insight is generated with a human-readable recommendation.

2. **Low Confidence Storage Without Delivery** — Given a pattern is detected with low confidence, when the confidence score is below the configurable threshold (default 0.6), then the insight is stored in the DB but NOT queued for delivery.

3. **Cross-Service Pattern Detection** — Given the analysis runs across Gmail, TickTick, knowledge data, and conversation history, when a cross-service pattern is found (e.g., emails about a topic correlate with overdue tasks, or repeated conversation topics suggest a knowledge gap), then the insight references the relevant services with specific data points.

4. **Duplicate Suppression** — Given the same pattern was already surfaced within a configurable window (default 7 days), when duplicate detection runs, then the duplicate is suppressed to avoid nagging.

## Tasks / Subtasks

- [x] Task 1: Database migration for insights table (AC: #1, #2, #4)
  - [x] 1.1: Create migration file `migrations/008-insights.sql`
  - [x] 1.2: Create `insights` table (id, pattern_key, title, body, confidence, status, service_sources, suppression_hash, created_at, delivered_at, dismissed_at)
  - [x] 1.3: Add indexes on status, pattern_key, suppression_hash, created_at

- [x] Task 2: Shared types and event definitions (AC: #1, #2, #3)
  - [x] 2.1: Add `Insight` type to `packages/shared/src/types/` (new file `insights.ts`)
  - [x] 2.2: Add `InsightStatus` type: `'pending' | 'queued' | 'delivered' | 'acted' | 'dismissed'`
  - [x] 2.3: Add new event types to `events.ts`: `insight:generated`, `insight:queued`, `insight:suppressed`
  - [x] 2.4: Add Zod schemas for insight event payloads
  - [x] 2.5: Export from shared barrel

- [x] Task 3: Insight store (DB CRUD) (AC: #1, #2, #4)
  - [x] 3.1: Create `packages/core/src/insight-engine/insight-store.ts`
  - [x] 3.2: Implement `insertInsight()`, `getInsightsByStatus()`, `updateInsightStatus()`, `findRecentByHash()`
  - [x] 3.3: Implement suppression hash lookup (SHA-256 of pattern_key + normalized key facts)

- [x] Task 4: Suite scaffold — `suites/proactive-intelligence/` (AC: #1, #2, #3)
  - [x] 4.1: Create `suite.ts` manifest (name: `proactive-intelligence`, capabilities: `['agent-definition', 'event-source', 'services']`)
  - [x] 4.2: Create `schedules.json` with pattern analysis cron (e.g., every 6 hours: `"0 */6 * * *"`)
  - [x] 4.3: Create `actions.json` with actions: `intelligence:generate-insight` (green), `intelligence:deliver-insight` (yellow)
  - [x] 4.4: Add suite constants to `packages/shared/src/suites/constants.ts`
  - [x] 4.5: Enable in `config/suites.json`

- [x] Task 5: Pattern analysis agent definition (AC: #1, #3)
  - [x] 5.1: Create `suites/proactive-intelligence/agents/pattern-analyzer.ts`
  - [x] 5.2: Agent prompt instructs Claude to analyze provided data snapshots for patterns
  - [x] 5.3: Agent returns structured JSON: `{ insights: [{ patternKey, title, body, confidence, serviceSources }] }`
  - [x] 5.4: No MCP servers needed — agent receives pre-fetched data in prompt (keeps context small)

- [x] Task 6: Data collector service (AC: #1, #3)
  - [x] 6.1: Create `suites/proactive-intelligence/services/data-collector.ts`
  - [x] 6.2: On `schedule:triggered` (taskType: `pattern-analysis`), collect data snapshots:
    - Recent events from `events` table (last 7 days, grouped by type)
    - Recent audit log entries (actions taken, outcomes)
    - Recent agent tasks (what was asked, what completed/failed)
    - Knowledge bubbles by domain (counts, recent activity, stale items)
    - Conversation themes from `messages` table (recent user messages across projects, topic frequency)
    - Session activity per project (active/idle projects, conversation frequency, last interaction)
  - [x] 6.3: Format data into a compact text summary for the agent prompt
  - [x] 6.4: Emit `agent:task:request` with collected data as context

- [x] Task 7: Insight processor service (AC: #1, #2, #3, #4)
  - [x] 7.1: Create `suites/proactive-intelligence/services/insight-processor.ts`
  - [x] 7.2: Subscribe to `agent:task:complete` for taskType `pattern-analysis`
  - [x] 7.3: Parse agent result JSON, validate with Zod schema
  - [x] 7.4: For each insight: compute suppression hash, check for duplicates via `findRecentByHash()`
  - [x] 7.5: Store all insights in DB (duplicates stored with status `suppressed`)
  - [x] 7.6: Queue non-duplicate insights above confidence threshold → emit `insight:generated` event
  - [x] 7.7: For queued insights, emit `notification` event to trigger delivery via notifications suite

- [x] Task 8: Tests (AC: #1, #2, #3, #4)
  - [x] 8.1: Integration test: insight-store CRUD with temp SQLite DB
  - [x] 8.2: Unit test: suppression hash generation (same pattern → same hash, different → different)
  - [x] 8.3: Unit test: insight processor — duplicate suppression logic
  - [x] 8.4: Unit test: insight processor — confidence threshold filtering
  - [x] 8.5: Unit test: data collector — snapshot formatting

## Dev Notes

### Architecture: Suite Pattern (NOT Legacy RavenSkill)

This project uses the **modern suite architecture**, not the legacy `RavenSkill` interface. A suite is a directory under `/suites/` with:

| File | Purpose |
|------|---------|
| `suite.ts` | Manifest: name, displayName, capabilities, requiresEnv |
| `agents/*.ts` | Agent definitions using `defineAgent()` from `@raven/shared` |
| `actions.json` | Permission-gated actions (name, defaultTier, reversible) |
| `schedules.json` | Cron schedules (id, name, cron, taskType, enabled) |
| `services/*.ts` | Long-running services (start/stop lifecycle, event subscriptions) |

**Reference implementation:** `/suites/daily-briefing/` — closest pattern to follow. It has a scheduled agent + a service that processes agent results into notifications.

### Data Flow

```
Croner fires schedule:triggered (taskType: "pattern-analysis")
  → Orchestrator finds proactive-intelligence suite
  → data-collector service gathers event/task/knowledge snapshots
  → Orchestrator spawns pattern-analyzer agent with snapshot as prompt context
  → Agent returns JSON array of insights
  → insight-processor service catches agent:task:complete
  → For each insight: hash → dedup check → confidence filter → store in DB
  → Qualifying insights emit notification event → notifications suite delivers via Telegram
```

### Agent Design: Data-In-Prompt (No MCPs)

The pattern-analyzer agent does NOT need MCP servers. Instead:
- The data-collector service pre-fetches all relevant data from SQLite + Neo4j
- Data is formatted into a compact text summary and injected into the agent's system prompt
- Agent uses pure reasoning (no tool calls) to identify patterns and generate insights
- This keeps the agent's context window small and avoids MCP complexity

**Why:** Pattern analysis is a reasoning task, not an action task. The agent doesn't need to call external APIs — it needs to think about data it's given.

### Database: New `insights` Table

```sql
CREATE TABLE insights (
  id TEXT PRIMARY KEY,                    -- crypto.randomUUID()
  pattern_key TEXT NOT NULL,              -- e.g., "meeting-overload", "email-task-correlation"
  title TEXT NOT NULL,                    -- Human-readable title
  body TEXT NOT NULL,                     -- Full insight text with recommendation
  confidence REAL NOT NULL,              -- 0.0 to 1.0
  status TEXT NOT NULL DEFAULT 'pending', -- pending | queued | delivered | acted | dismissed
  service_sources TEXT NOT NULL,          -- JSON array: ["gmail", "ticktick"]
  suppression_hash TEXT NOT NULL,         -- SHA-256 for duplicate detection
  created_at TEXT NOT NULL,               -- ISO 8601
  delivered_at TEXT,                      -- ISO 8601, set when notification sent
  dismissed_at TEXT                       -- ISO 8601, set when user ignores/dismisses
);
CREATE INDEX idx_insights_status ON insights(status);
CREATE INDEX idx_insights_pattern_key ON insights(pattern_key);
CREATE INDEX idx_insights_suppression_hash ON insights(suppression_hash);
CREATE INDEX idx_insights_created_at ON insights(created_at);
```

- `suppression_hash` = SHA-256 of `pattern_key + sorted key facts` — same pattern about the same data = same hash
- Duplicate window: check `created_at` within last 7 days for matching hash
- `status` transitions: `pending → queued → delivered → acted|dismissed`

### Suppression Hash Strategy

```typescript
import { createHash } from 'node:crypto';

function computeSuppressionHash(patternKey: string, keyFacts: string[]): string {
  const normalized = [patternKey, ...keyFacts.sort()].join('|');
  return createHash('sha256').update(normalized).digest('hex');
}
```

The agent must return `keyFacts` (array of strings) per insight — these are the specific data points that define uniqueness. E.g., for "4 meetings, no deep work" → `["meetings:4", "deep-work-blocks:0", "week:2026-W12"]`.

### Event Types to Add

```typescript
// In packages/shared/src/types/events.ts
'insight:generated'    // payload: { insightId, patternKey, title, confidence, serviceSources }
'insight:queued'       // payload: { insightId, patternKey }
'insight:suppressed'   // payload: { insightId, patternKey, reason: 'duplicate' | 'low-confidence' }
```

### Data Collection: What to Gather

The data-collector should query these sources for the analysis window (default: 7 days):

| Source | Query | What to Extract |
|--------|-------|-----------------|
| `events` table | Last 7 days, group by type | Event frequency, peak times, error rates |
| `audit_log` table | Last 7 days | Actions taken, approval patterns, denied actions |
| `agent_tasks` table | Last 7 days | Task types, success/fail rates, duration trends |
| Neo4j knowledge | Bubbles by domain | New knowledge, stale items, cluster changes |
| `pipeline_runs` table | Last 7 days | Pipeline success rates, timing patterns |
| `messages` table | Last 7 days, user role only | Recurring topics, question themes, cross-project patterns |
| `sessions` table | Last 30 days, per project | Active vs idle projects, conversation frequency, last interaction timestamps |

Format as a structured text block (~2000 tokens max) to keep agent context small.

### Notification Integration

Emit standard `notification` events to reuse the existing notifications suite (Telegram bot):

```typescript
eventBus.emit({
  type: 'notification',
  source: 'proactive-intelligence',
  payload: {
    channel: 'telegram',
    title: insight.title,
    body: insight.body,
    actions: [
      { label: 'Useful', callbackData: `insight:acted:${insight.id}` },
      { label: 'Dismiss', callbackData: `insight:dismissed:${insight.id}` }
    ]
  }
});
```

The Telegram bot already handles inline keyboard actions from the `actions` array (established in Epic 3, Story 3.2).

### Confidence Threshold

Default threshold: `0.6` (configurable via suite config in `config/suites.json`):

```json
{
  "proactive-intelligence": {
    "enabled": true,
    "config": {
      "confidenceThreshold": 0.6,
      "analysisIntervalCron": "0 */6 * * *",
      "suppressionWindowDays": 7,
      "maxInsightsPerRun": 5
    }
  }
}
```

### Existing Code to Reuse

| What | Where | How |
|------|-------|-----|
| Suite definition | `@raven/shared` `defineAgent()`, `defineSuite()` | Import and use for manifest/agents |
| Event bus | `packages/core/src/event-bus/` | Subscribe/emit via `ServiceContext.eventBus` |
| Database access | `ServiceContext.db` (DatabaseInterface) | Query events, audit_log, agent_tasks, pipeline_runs |
| Neo4j knowledge | `packages/core/src/knowledge-engine/neo4j-client.ts` | Query bubble counts, domains, stale items |
| Notification dispatch | `suites/notifications/` | Emit `notification` events (already handled) |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` | Cron from `schedules.json` fires `schedule:triggered` |
| Orchestrator routing | Handles `schedule:triggered` → spawns suite agent | No changes needed to orchestrator |
| Suite registry | Auto-discovers from `/suites/` directory | Just add the suite directory |
| Inline keyboards | `suites/notifications/` Telegram bot | `actions` array in notification payload |

### What NOT to Build

- **No urgency tier classification** — that's Story 7.2
- **No engagement-based throttling** — that's Story 7.3
- **No category snooze** — that's Story 7.4
- **No new API endpoints** — insights are delivered via Telegram notifications; dashboard visibility comes later
- **No frontend components** — this is purely backend
- **No MCP servers** — agent uses pre-fetched data in prompt
- **No pipeline definitions** — use simple scheduled agent pattern (like daily-briefing)

### Project Structure Notes

New files to create:
```
suites/proactive-intelligence/
  ├── suite.ts                          # Suite manifest
  ├── agents/
  │   └── pattern-analyzer.ts           # Agent definition
  ├── services/
  │   ├── data-collector.ts             # Gathers data snapshots
  │   └── insight-processor.ts          # Processes agent results, dedup, store
  ├── actions.json                      # Permission-gated actions
  └── schedules.json                    # Cron schedule

packages/core/src/insight-engine/
  └── insight-store.ts                  # SQLite CRUD for insights table

packages/shared/src/types/insights.ts   # Insight type + Zod schema

migrations/008-insights.sql             # New table
```

Modified files:
```
packages/shared/src/types/events.ts     # Add insight:* event types
packages/shared/src/types/index.ts      # Export insights types
packages/shared/src/suites/constants.ts # Add SUITE_PROACTIVE_INTELLIGENCE, AGENT_PATTERN_ANALYZER
config/suites.json                      # Enable new suite
```

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 7, Story 7.1]
- [Source: _bmad-output/planning-artifacts/architecture.md — Event Bus, Scheduling, Naming Patterns]
- [Source: _bmad-output/planning-artifacts/prd.md — FR49-53, Proactive Intelligence]
- [Source: suites/daily-briefing/ — Reference implementation for scheduled agent + service pattern]
- [Source: packages/core/src/knowledge-engine/retrieval.ts — Knowledge query interface]
- [Source: packages/shared/src/suites/define.ts — defineAgent(), defineSuite() API]
- [Source: packages/shared/src/suites/constants.ts — Naming conventions for suites/agents]

### Previous Story Intelligence (6.8)

- **Overlay panel pattern**: Not relevant (this story is backend-only)
- **WebSocket real-time events**: Insight events will flow through the same WebSocket infrastructure — no changes needed
- **Neo4j type safety**: When querying Neo4j for knowledge data, always wrap LIMIT params with `toInteger()` and round topK values with `Math.round()` — learned from bug fixes in recent commits
- **Null-coalescing**: When reading from Neo4j, properties may be `undefined` — always null-coalesce before storing or serializing to YAML/JSON
- **Test suite health**: 746 tests passing, 117 skipped, 6 pre-existing Neo4j testcontainers failures (ignore these)

### Git Intelligence

- Commit style: `feat: descriptive summary` for new features, `fix:` for bugs
- Co-author line required: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Recent work focused on knowledge engine bug fixes — this is the first new feature work since Epic 6 completion
- All recent commits include comprehensive changelog entries

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

None — clean implementation.

### Completion Notes List

- Task 1: Created `migrations/008-insights.sql` with insights table, 4 indexes (status, pattern_key, suppression_hash, created_at)
- Task 2: Added `Insight`, `InsightStatus`, `AgentInsight`, `AgentInsightResult` types with Zod schemas in `packages/shared/src/types/insights.ts`. Added `InsightGeneratedEvent`, `InsightQueuedEvent`, `InsightSuppressedEvent` to events.ts and RavenEvent union. Added `SUITE_PROACTIVE_INTELLIGENCE`, `AGENT_PATTERN_ANALYZER`, and event constants to suites/constants.ts. Exported from all barrels.
- Task 3: Created `packages/core/src/insight-engine/insight-store.ts` with `insertInsight()`, `getInsightsByStatus()`, `updateInsightStatus()`, `findRecentByHash()`, and `computeSuppressionHash()` functions
- Task 4: Created `suites/proactive-intelligence/` with suite.ts, schedules.json (every 6h cron), actions.json (generate-insight green, deliver-insight yellow). Enabled in `config/suites.json` with configurable thresholds.
- Task 5: Created `suites/proactive-intelligence/agents/pattern-analyzer.ts` — haiku model, no tools, maxTurns: 1, structured JSON output prompt
- Task 6: Created `suites/proactive-intelligence/services/data-collector.ts` — listens to `schedule:triggered` for pattern-analysis taskType, collects snapshots from events, agent_tasks, audit_log, pipeline_runs, sessions, knowledge events, conversation volume/topics + insight history, formats compact text, emits `agent:task:request`
- Task 7: Created `suites/proactive-intelligence/services/insight-processor.ts` — listens to `agent:task:complete` for proactive-intelligence, parses JSON, validates with Zod, computes suppression hash, checks confidence threshold, checks duplicate window, stores in DB, emits `insight:generated`/`insight:queued`/`insight:suppressed` events, sends notification via `notification` event for qualifying insights
- Task 8: Created 30 tests across 3 test files: insight-store CRUD (15 tests in `packages/core/src/__tests__/insight-engine.test.ts`), insight-processor logic (7 tests in `suites/proactive-intelligence/__tests__/insight-processor.test.ts`), data-collector snapshot formatting (8 tests in `suites/proactive-intelligence/__tests__/data-collector.test.ts`). All 30 pass.

### Change Log

- 2026-03-18: Implemented Story 7.1 — Background Pattern Analysis Engine (all 8 tasks)
- 2026-03-18: Code review fixes — added missing knowledge/conversation data collection to data-collector, emitted `insight:queued` event, added 15 new tests for insight-processor and data-collector

### File List

New files:
- migrations/008-insights.sql
- packages/shared/src/types/insights.ts
- packages/core/src/insight-engine/insight-store.ts
- packages/core/src/__tests__/insight-engine.test.ts
- suites/proactive-intelligence/suite.ts
- suites/proactive-intelligence/schedules.json
- suites/proactive-intelligence/actions.json
- suites/proactive-intelligence/agents/pattern-analyzer.ts
- suites/proactive-intelligence/services/data-collector.ts
- suites/proactive-intelligence/services/insight-processor.ts
- suites/proactive-intelligence/__tests__/insight-processor.test.ts
- suites/proactive-intelligence/__tests__/data-collector.test.ts

Modified files:
- packages/shared/src/types/events.ts
- packages/shared/src/types/index.ts
- packages/shared/src/suites/constants.ts
- packages/shared/src/suites/index.ts
- config/suites.json
