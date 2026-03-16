# Story 5.2: Activity Timeline

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the dashboard user,
I want to see a chronological timeline of all autonomous Raven actions with filtering,
So that I know exactly what happened while I wasn't watching.

## Acceptance Criteria

1. **Rich Timeline Display** — Given Raven has processed emails, updated tasks, and run pipelines today, When the user opens the activity page, Then all events appear in reverse chronological order with timestamps, skill-derived icons/badges, and human-readable descriptions (not raw JSON).

2. **Skill/Source Filter** — Given the user selects a filter for `source=gmail`, When the filter is applied, Then only Gmail-related activity entries are shown. The filter dropdown is populated from the distinct `source` values in the events table.

3. **Event Type Filter** — Given the user selects a filter for a specific event type (e.g., `pipeline:complete`), When the filter is applied, Then only matching event types are shown.

4. **Live Polling Updates** — Given new activity occurs while the page is open, When the polling interval triggers (5s), Then new entries appear at the top without page reload (already working via `usePolling` from story 5.1).

5. **Empty State** — Given no events match the current filters, When the page renders, Then a clear "No matching events" message is shown.

## Tasks / Subtasks

- [x] Task 1: Add `source` query parameter to the events API (AC: #2)
  - [x] 1.1 In `packages/core/src/api/routes/events.ts`, add `source?: string` to the `Querystring` type
  - [x] 1.2 Add filter logic: `if (req.query.source) { conditions.push('source = ?'); params.push(req.query.source); }`
  - [x] 1.3 This enables filtering by skill name (events store the skill name in `source` column)

- [x] Task 2: Add distinct sources endpoint (AC: #2)
  - [x] 2.1 In `packages/core/src/api/routes/events.ts`, add `GET /api/events/sources` returning `string[]`
  - [x] 2.2 Query: `SELECT DISTINCT source FROM events ORDER BY source` — returns all unique source values for the filter dropdown
  - [x] 2.3 Register this route BEFORE the parameterized `/api/events` route to avoid conflicts (Fastify matches routes by registration order; `/api/events/sources` is a static route that must be registered before `/api/events` which uses query params)

- [x] Task 3: Update `api-client.ts` with new API methods (AC: #2, #3)
  - [x] 3.1 Add `source?: string` to `getEvents()` params — append to URLSearchParams
  - [x] 3.2 Add `getEventSources(): Promise<string[]>` method — calls `GET /api/events/sources`

- [x] Task 4: Create event display helpers (AC: #1)
  - [x] 4.1 Create `packages/web/src/lib/event-helpers.ts` — utility functions for event presentation
  - [x] 4.2 `getEventIcon(type: string): string` — maps event type prefix to a display character/icon
  - [x] 4.3 `getEventColor(type: string): string` — maps event type prefix to CSS variable color
  - [x] 4.4 `formatEventDescription(event: EventRecord): string` — produces human-readable one-line description from event type + payload
  - [x] 4.5 `formatRelativeTime(timestamp: number): string` — human-friendly relative time

- [x] Task 5: Redesign activity page with rich timeline (AC: #1, #2, #3, #4, #5)
  - [x] 5.1 Rewrite `packages/web/src/app/activity/page.tsx` — complete redesign
  - [x] 5.2 Filter state: `useState` for `selectedSource` and `selectedType`
  - [x] 5.3 Build the polling URL dynamically from filters
  - [x] 5.4 Load distinct sources via second `usePolling` call (30s refresh)
  - [x] 5.5 Type filter dropdown derived from loaded events (client-side)
  - [x] 5.6 Rich event cards with icon circle, description, source badge, relative time
  - [x] 5.7 Empty state: "No matching events" / "No events recorded yet"
  - [x] 5.8 Loading state: skeleton placeholders on first load

- [x] Task 6: Tests (AC: #1, #2)
  - [x] 6.1 Add tests to `packages/core/src/__tests__/api.test.ts` (extend existing test file):
    - Test: `GET /api/events?source=gmail` returns only gmail-sourced events
    - Test: `GET /api/events/sources` returns distinct source values
  - [x] 6.2 No frontend tests needed — the page is a straightforward UI composition using the already-tested `usePolling` hook and backend API. Verify through browser testing.

## Dev Notes

### Architecture Constraints

- **Flat page structure** — `/activity` is a top-level route, self-contained page (architecture doc: "Each view is top-level")
- **No classes** — all utilities are plain functions
- **usePolling for data refresh** — story 5.1 established this pattern. DO NOT revert to manual `setInterval`
- **No Zustand coupling in the hook** — components own the decision to write to stores. Activity page can use polling data directly
- **CSS variables for theming** — use `var(--bg-card)`, `var(--border)`, `var(--text-muted)`, etc. from `globals.css`. DO NOT use hardcoded colors
- **Tailwind CSS 4** — use utility classes, no custom CSS files
- **No new npm dependencies** — everything needed is already available

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| Events API route | `packages/core/src/api/routes/events.ts` | **EXTEND** — add `source` query param filter + new `/events/sources` endpoint |
| usePolling hook | `packages/web/src/hooks/usePolling.ts` | **USE** — already works, returns `{ data, loading, error, refresh }` |
| api-client.ts | `packages/web/src/lib/api-client.ts` | **EXTEND** — add `source` param to `getEvents()`, add `getEventSources()` |
| EventRecord type | `packages/web/src/lib/api-client.ts:118` | **USE** — `{ id, type, source, projectId, payload, timestamp }` |
| Activity page | `packages/web/src/app/activity/page.tsx` | **REWRITE** — current page is minimal, just raw JSON display |
| globals.css | `packages/web/src/app/globals.css` | **USE** — CSS variables for colors, card styling patterns |
| Sidebar | `packages/web/src/components/layout/Sidebar.tsx` | **REFERENCE** — Activity is already in nav as `/activity` with `>` icon |

### Events Table Schema

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,       -- e.g., 'email:new', 'pipeline:complete', 'agent:task:complete'
  source TEXT NOT NULL,     -- e.g., 'gmail', 'ticktick', 'orchestrator', 'scheduler', 'pipeline-engine'
  project_id TEXT,
  payload TEXT NOT NULL,    -- JSON blob
  timestamp INTEGER NOT NULL -- Unix milliseconds
);
```

Indexed on `type` and `timestamp`. The `source` column is the skill/component name. This is what the user sees as "skill filter" in the AC — map `skillName` filter to `source` column.

### Current Events API Query Params

Already supported: `since`, `type`, `projectId`, `limit`. Need to add: `source`.

### Event Type Taxonomy (for formatEventDescription)

Event types use colon-separated prefix convention. Common prefixes from `packages/shared/src/types/events.ts`:
- `email:` — email:new, email:triage:processed, email:triage:action-items, email:action-extract:completed, email:reply:send
- `pipeline:` — pipeline:started, pipeline:complete, pipeline:failed, pipeline:step:complete, pipeline:step:failed
- `agent:` — agent:task:request, agent:task:complete, agent:message
- `schedule:` — schedule:triggered
- `permission:` — permission:approved, permission:blocked, permission:denied
- `task-management:` — task-management:autonomous:completed, task-management:autonomous:failed, task-management:manage-request
- `voice:` — voice:received
- `media:` — media:received
- `notification` — notification
- `config:` — config:reloaded, config:pipelines:reloaded
- `system:` — system:health:alert

### Design Pattern Reference (Current Activity Page)

The current page uses:
- `var(--bg-card)` for card background with `1px solid var(--border)` border
- `var(--accent)` for highlighted text
- `var(--text-muted)` for secondary text
- `rounded-lg` for card corners
- `p-3` padding, `gap-3` spacing
- Font mono for type badges

Follow the same dark theme aesthetic but upgrade from raw JSON to rich timeline cards.

### Key Design Decisions

1. **Server-side filtering** — Source and type filters are passed as query params to the API (not client-side filter). This is efficient and reuses the existing SQL query builder pattern. The `usePolling` URL changes when filters change, triggering a fresh fetch.

2. **Dynamic filter URL** — Build the polling URL from filter state: `usePolling<EventRecord[]>(\`/events?limit=200${source ? \`&source=${source}\` : ''}${type ? \`&type=${type}\` : ''}\`, 5000)`. The `usePolling` hook already resets when URL changes.

3. **Separate event-helpers.ts** — Keeps the page file clean (under 300 lines) and makes helpers reusable for the dashboard ActivityFeed component and future Kanban board (story 5.4).

4. **Character icons, not emoji** — The existing Sidebar uses ASCII characters (`~`, `#`, `>`, `@`, `*`, `%`) for icons. Activity timeline should match this aesthetic with similar character-based icons in styled circles.

5. **Limit 200 events** — Default to 200 events (up from current 100) for the timeline view to show more history. API max is 500.

### Previous Story Intelligence (5.1)

- `usePolling` hook is at `packages/web/src/hooks/usePolling.ts` — generic, returns `{ data, loading, error, refresh }`
- Hook tracks `loading` state only on first fetch (prevents flicker)
- Dashboard page pattern: `const { data } = usePolling<EventRecord[]>('/events?limit=100', 5000)`
- Activity page already imports `usePolling` — extend the URL building, don't change the hook
- Story 5.1 already refactored activity page to use `usePolling` — build on that, don't revert
- api-client.ts `API_URL` = `process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api'`
- `usePolling` prefixes URL with `API_URL` — pass relative paths starting with `/`

### Git Intelligence

Recent commits show:
- ESLint strict compliance required (`npm run check` must pass)
- `.ts` extensions in imports enforced by ESLint rule
- Pino logging required (no console.log)
- Pattern: `feat: <description> (story X.Y)` for commit messages

### NFR Compliance

- **NFR15 (200ms API):** SQL query with index on `source` column not needed — table scan on small events table is fast enough for single-user. If perf becomes an issue later, add `CREATE INDEX idx_events_source ON events(source)`
- **NFR18 (Non-blocking I/O):** All data fetching via async `usePolling` + async Fastify handler
- **NFR29 (Structured logging):** Use `createLogger('events')` in the route file if adding logging

### Project Structure Notes

- **New files:**
  - `packages/web/src/lib/event-helpers.ts` — event display utility functions
- **Modified files:**
  - `packages/core/src/api/routes/events.ts` — add `source` filter + `/events/sources` endpoint
  - `packages/web/src/lib/api-client.ts` — add `source` param, `getEventSources()` method
  - `packages/web/src/app/activity/page.tsx` — full redesign with rich timeline + filters
- **No changes to:**
  - `packages/shared/src/types/` — no new types needed
  - Database/migrations — no schema changes (source column already exists)
  - `usePolling` hook — use as-is

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 5, Story 5.2]
- [Source: _bmad-output/planning-artifacts/prd.md — FR27: Activity timeline]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Architecture (usePolling + flat page), Data refresh strategy (Zustand + usePolling hook)]
- [Source: _bmad-output/project-context.md — TypeScript ESM, Fastify patterns, CSS variables]
- [Source: _bmad-output/implementation-artifacts/5-1-polling-and-sse-infrastructure-hooks.md — usePolling hook design, refactored activity page]
- [Source: packages/core/src/api/routes/events.ts — Current events API with type/since/projectId/limit filters]
- [Source: packages/web/src/app/activity/page.tsx — Current minimal activity page using usePolling]
- [Source: packages/web/src/lib/api-client.ts — API client, EventRecord type, getEvents()]
- [Source: packages/web/src/app/globals.css — CSS variables: --bg-card, --border, --accent, --text-muted, --success, --warning, --error]
- [Source: packages/shared/src/types/events.ts — All RavenEvent type definitions with payload shapes]
- [Source: migrations/001-initial-schema.sql — events table schema with type, source, payload, timestamp columns]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- ESLint guardrail rules required extracting components (FilterBar, EventCard, TimelineList) and using lookup maps instead of if-chains to satisfy `max-lines-per-function`, `complexity`, and `no-magic-numbers` rules.

### Completion Notes List

- Task 1: Added `source` query parameter to events API route with SQL filter
- Task 2: Added `GET /api/events/sources` endpoint returning distinct source values, registered before parameterized route
- Task 3: Extended api-client.ts with `source` param on `getEvents()` and new `getEventSources()` method
- Task 4: Created `event-helpers.ts` with `getEventIcon`, `getEventColor`, `formatEventDescription`, `formatRelativeTime` — all using lookup maps to satisfy complexity rules
- Task 5: Redesigned activity page with rich timeline cards, source/type filter dropdowns, loading skeletons, and differentiated empty states. Extracted FilterBar, EventCard, and TimelineList as separate components.
- Task 6: Added 2 API integration tests — source filter and distinct sources endpoint. 608 total tests pass, 0 regressions.

### Code Review Fixes

- **M1**: Added `/events/types` server endpoint to decouple type filter dropdown from filtered event data. Activity page now uses server-side types list instead of client-derived, preventing dropdown self-collapse.
- **L1**: Added try/catch on `JSON.parse(r.payload)` in `mapEventRow` — falls back to `{}` on malformed data.
- **L2**: Sources endpoint test now inserts its own data explicitly instead of relying on prior test's inserts.
- **L3**: Added `aria-label` attributes to filter select elements. Extracted `FilterSelect` helper component.
- Added test for new `/events/types` endpoint.
- 609 total tests pass, 0 regressions.

### File List

- `packages/core/src/api/routes/events.ts` — modified (added source filter, /events/sources endpoint, extracted buildEventQuery + mapEventRow)
- `packages/core/src/__tests__/api.test.ts` — modified (added source filter + sources endpoint tests)
- `packages/web/src/lib/api-client.ts` — modified (added source param, getEventSources method)
- `packages/web/src/lib/event-helpers.ts` — new (event display utility functions)
- `packages/web/src/app/activity/page.tsx` — modified (complete redesign with filters + rich timeline)
- `packages/web/src/components/activity/EventCard.tsx` — new (event card component)
- `packages/web/src/components/activity/FilterBar.tsx` — new (filter bar component)
- `packages/web/src/components/activity/TimelineList.tsx` — new (timeline list + skeleton components)
