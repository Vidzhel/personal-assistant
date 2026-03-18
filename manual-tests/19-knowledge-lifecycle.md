# 19 - Knowledge Lifecycle & Retrospective (Story 6.6)

Verify stale bubble detection, snooze tracking, merge execution, retrospective summary generation, and access tracking via REST API endpoints.

Prerequisites: Backend running (`npm run dev:core`), knowledge bubbles exist in Neo4j with varied ages and permanence levels, Neo4j running

## Test Cases — Stale Bubble Detection

### KLC-01: Detect stale bubbles

**Steps:**
1. ensure bubbles exist with `updatedAt` older than 30 days (normal permanence) or older than 7 days (temporary permanence)
2. query stale API:
   ```
   GET http://localhost:4001/api/knowledge/stale
   ```
3. inspect response → assert:
   - returns an array of stale bubble objects
   - each stale bubble has: `id`, `title`, `permanence`, `updatedAt`
   - normal permanence bubbles appear if not updated in 30+ days
   - temporary permanence bubbles appear if not updated in 7+ days

### KLC-02: Robust bubbles never flagged as stale

**Steps:**
1. create a bubble with `permanence: "robust"` and old `updatedAt`
2. query stale API:
   ```
   GET http://localhost:4001/api/knowledge/stale
   ```
3. inspect response → assert:
   - the robust bubble does NOT appear in the stale list

### KLC-03: Recently updated bubbles not flagged

**Steps:**
1. update a bubble so its `updatedAt` is recent
2. query stale API → assert:
   - the recently updated bubble does NOT appear in the stale list

### KLC-04: No stale bubbles returns empty array

**Steps:**
1. ensure all bubbles have recent `updatedAt` or are robust
2. query stale API → assert:
   - returns empty array `[]`

## Test Cases — Snooze Tracking

### KLC-05: Snooze a stale bubble

**Steps:**
1. identify a stale bubble ID from `GET /api/knowledge/stale`
2. snooze it:
   ```
   POST http://localhost:4001/api/knowledge/stale/{bubbleId}/snooze
   { "days": 14 }
   ```
3. inspect response → assert:
   - success response with `snoozedUntil` date (14 days from now)
4. query stale API again → assert:
   - the snoozed bubble no longer appears in the stale list

### KLC-06: Snoozed bubble reappears after expiry

**Steps:**
1. snooze a bubble with `days: 0` (or a very short period for testing)
2. query stale API after the snooze expires → assert:
   - the bubble reappears in the stale list

## Test Cases — Merge Execution

### KLC-07: Merge two bubbles

**Steps:**
1. create two related bubbles:
   ```
   POST http://localhost:4001/api/knowledge/bubbles
   { "title": "Grocery List Monday", "content": "Buy milk, eggs", "tags": ["groceries"], "permanence": "temporary" }
   ```
   ```
   POST http://localhost:4001/api/knowledge/bubbles
   { "title": "Grocery List Tuesday", "content": "Buy bread, butter", "tags": ["groceries"], "permanence": "temporary" }
   ```
2. note both bubble IDs
3. merge them:
   ```
   POST http://localhost:4001/api/knowledge/merge
   { "bubbleIds": ["<id1>", "<id2>"] }
   ```
4. inspect response → assert:
   - success response with merged bubble data
   - merged bubble contains content from both originals
5. query individual bubbles → assert:
   - original bubbles no longer exist (deleted after merge)
   - merged bubble exists with combined content

### KLC-08: Merge re-points links

**Steps:**
1. create 3 bubbles: A, B, C where A links to B and C links to B
2. merge A and B
3. query the merged bubble → assert:
   - links from C now point to the merged bubble (not the deleted B)

### KLC-09: Merge with single bubble fails

**Steps:**
1. attempt merge with only 1 bubble ID:
   ```
   POST http://localhost:4001/api/knowledge/merge
   { "bubbleIds": ["<id1>"] }
   ```
2. inspect response → assert:
   - error response (400 or similar)

## Test Cases — Retrospective

### KLC-10: Query retrospective summary

**Steps:**
1. ensure knowledge activity exists in the past week (bubbles created/updated, links created)
2. query retrospective:
   ```
   GET http://localhost:4001/api/knowledge/retrospective
   ```
3. inspect response → assert:
   - response contains weekly summary data
   - includes counts: bubbles created, bubbles updated, links created
   - includes domain/tag change information

### KLC-11: Retrospective with no activity

**Steps:**
1. query retrospective for a period with no knowledge activity
2. inspect response → assert:
   - response returns with zero counts (empty but valid summary)

### KLC-12: Trigger retrospective manually

**Steps:**
1. trigger manual retrospective:
   ```
   POST http://localhost:4001/api/knowledge/retrospective/trigger
   ```
2. inspect response → assert:
   - success response indicating retrospective was triggered
3. check recent events or notifications → assert:
   - a `knowledge:retrospective:complete` event was emitted

## Test Cases — Access Tracking

### KLC-13: Reading a bubble bumps lastAccessedAt

**Steps:**
1. note the `lastAccessedAt` of a bubble
2. read the bubble:
   ```
   GET http://localhost:4001/api/knowledge/bubbles/{id}
   ```
3. read it again and check `lastAccessedAt` → assert:
   - `lastAccessedAt` has been updated to a more recent timestamp

### KLC-14: Retrieval results bump access tracking

**Steps:**
1. trigger a chat that causes knowledge retrieval (context injection)
2. check the retrieved bubbles' `lastAccessedAt` → assert:
   - timestamps have been updated for bubbles that were included in the context

## Test Cases — Scheduled Pipeline

### KLC-15: Weekly retrospective schedule exists

**Steps:**
1. query schedules:
   ```
   GET http://localhost:4001/api/schedules
   ```
2. inspect response → assert:
   - a schedule exists for the knowledge retrospective
   - schedule triggers weekly (Monday 9am or similar cron pattern)

**Notes:** Story 6.6 is primarily backend. The frontend effects are visible through the knowledge graph page (story 6.7) where merged/snoozed/deleted bubbles reflect the lifecycle changes, and through notifications delivered via Telegram/dashboard when retrospectives complete.
