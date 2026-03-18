# Changelog

## 2026-03-18 — Browser Test Bug Fixes

Six bugs identified across 21 manual browser test files. Core UI pages (dashboard, projects, activity, sessions, pipelines, kanban, metrics) all passed. Failures were concentrated in knowledge engine features (stories 6.4-6.8) and CORS configuration.

### Bugs Found and Fixed

#### 1. CORS: PUT/PATCH/DELETE blocked (test file: 18, 19, 20, 21)
- **File:** `packages/core/src/api/server.ts`
- **Bug:** `cors({ origin: true })` only allows GET, HEAD, POST by default. All PUT/PATCH/DELETE requests from the browser were blocked by CORS preflight.
- **Fix:** Added explicit `methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']` to CORS config.

#### 2. Neo4j LIMIT float parameter error (test file: 20)
- **Files:** `packages/core/src/knowledge-engine/retrieval.ts`, `packages/core/src/knowledge-engine/embeddings.ts`
- **Bug:** Neo4j driver passes JS numbers as floats to Cypher LIMIT/topK params. Neo4j requires integers for LIMIT clauses and vector index topK.
- **Fix:** Used `toInteger($limit)` in Cypher LIMIT clauses; wrapped topK with `Math.round()` at call sites.

#### 3. PUT `/api/knowledge/:id` returns 500 (test file: 19)
- **File:** `packages/core/src/api/routes/knowledge.ts`
- **Bug:** `return bubble;` without explicit `reply.send()` caused Fastify serialization to fail on undefined properties in the bubble object.
- **Fix:** Changed to `return reply.status(HTTP_STATUS.OK).send(bubble);`.

#### 4. `days=0` silently ignored in stale query (test file: 21)
- **File:** `packages/core/src/api/routes/knowledge.ts`
- **Bug:** `days && !isNaN(days)` treats `0` as falsy, so `?days=0` was ignored instead of returning all bubbles.
- **Fix:** Changed to `days !== undefined && !isNaN(days)`.

#### 5. NAV-01 test spec outdated (test file: 02)
- **File:** `manual-tests/02-navigation-and-layout.md`
- **Bug:** Expected 8 sidebar links but actual sidebar has 10 (Metrics and Knowledge were added in stories 5.5 and 6.7).
- **Fix:** Updated to expect 10 links: Dashboard, Projects, Activity, Pipelines, Tasks, Metrics, Schedules, Skills, Knowledge, Settings.

#### 6. React duplicate key warnings in ActivityFeed (test file: 18)
- **File:** `packages/web/src/components/dashboard/ActivityFeed.tsx`
- **Bug:** `key={item.id}` produced React duplicate key warnings when WebSocket delivered the same event ID multiple times.
- **Fix:** Added deduplication check (`prev.some(p => p.id === event.id)`) in the state updater before inserting new events.

---

## 2026-03-18 — Browser Test Bug Fixes (Round 2)

Re-running tests 02/18/19/20/21 after round 1 fixes revealed 4 additional pre-existing bugs. Three fixed, one confirmed already resolved by round 1 PUT fix.

### Bugs Found and Fixed

#### 7. Sidebar active state broken on initial load (NAV-02/NAV-03) (test file: 02)
- **File:** `packages/web/src/components/layout/Sidebar.tsx`
- **Bug:** `usePathname()` returns `null` during SSR/initial render. `pathname === item.href` fails on null, and `pathname.startsWith()` throws.
- **Fix:** `usePathname() ?? '/'` — Dashboard active by default during SSR.

#### 8. Knowledge page WebSocket channel mismatch (KGRAPH-44/45) (test file: 18)
- **File:** `packages/web/src/app/knowledge/page.tsx`
- **Bug:** Subscribed to specific event type channels (`knowledge:bubble:created`, etc.) but WS handler maps all non-project events to `'global'`. Channels never matched.
- **Fix:** Changed `WS_CHANNELS` to `['global']` (same as working ActivityFeed).

#### 9. `lastAccessedAt` missing from API response (KLC-13) (test file: 21)
- **Files:** `packages/shared/src/types/knowledge.ts`, `packages/core/src/knowledge-engine/knowledge-store.ts`
- **Bug:** `lastAccessedAt` stored in Neo4j and used by stale detection but missing from `KnowledgeBubble` interface and `getById()`/`update()` return values.
- **Fix:** Added `lastAccessedAt: string | null` to `KnowledgeBubble` interface; included in `getById()`, `insert()`, and `update()` returns.

#### 10. Tag add/remove 500 error (KGRAPH-27/28) (test file: 20)
- **Status:** Confirmed fixed by round 1 PUT serialization fix (#3 above). No additional code change needed.

#### 11. PUT update crashes on bubbles with undefined `source` (KGRAPH-27/28)
- **File:** `packages/core/src/knowledge-engine/knowledge-store.ts`
- **Bug:** `node.source` from Neo4j is `undefined` (not `null`) for bubbles created by merge (which doesn't set `source`). The YAML frontmatter serializer (`writeBubbleFile`) can't serialize `undefined`. `sourceFile` and `sourceUrl` had `?? null` fallbacks but `source` didn't.
- **Fix:** Added `?? null` fallback: `input.source !== undefined ? input.source : (node.source ?? null)`.
- **Note:** This is separate from the round 1 PUT fix (#3 — reply.send). That fix addressed Fastify response serialization; this fix addresses YAML file writing.

#### NOT a bug: KGRAPH-25 (linked nodes in detail panel)
- **Status:** UI correctly renders linked nodes when edges exist. Test node simply had no links.

### Test Results

| Test File | Area | Before | After |
|-----------|------|--------|-------|
| 01 - Smoke Tests | Core | PASS | PASS |
| 02 - Navigation | Layout | FAIL | PASS |
| 03-17 | Various core features | PASS | PASS |
| 18 - Knowledge Dashboard | Knowledge UI | FAIL | PASS |
| 19 - Knowledge CRUD | Knowledge API | FAIL | PASS |
| 20 - Knowledge Retrieval | Vector search | FAIL | PASS |
| 21 - Knowledge Lifecycle | Stale/merge | FAIL | PASS |
