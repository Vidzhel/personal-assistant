# Story 9.1: Proactive Cross-Domain Insight Delivery

Status: done

## Story

As the system operator,
I want novel cross-domain connections between knowledge bubbles to be surfaced proactively via Telegram,
so that non-obvious relationships reach me without manually browsing the graph.

## Context

Epic 6 already detects connections via embedding similarity in `link-ops.ts` and emits `knowledge:links:suggested` events from `clustering.ts`. Epic 7 built the full proactive intelligence pipeline with urgency classification, engagement-based throttling, and Telegram delivery. This story wires them together: when a link suggestion crosses domain boundaries, it flows through the insight pipeline and reaches the user as a Telegram notification with interactive buttons.

**What already exists (DO NOT rebuild):**
- Link suggestion engine: `packages/core/src/knowledge-engine/link-ops.ts` — `suggestLinks()` finds similar bubbles (cosine > 0.7), creates `LINKS_TO` relationships in Neo4j with `status: 'suggested'`
- Link event emission: `packages/core/src/knowledge-engine/clustering.ts` (line ~208) — emits `knowledge:links:suggested` with `{ bubbleId, links: [{ targetBubbleId, confidence, relationshipType }] }`
- Domain classification: `packages/core/src/knowledge-engine/clustering.ts` — `classifyDomains()` checks tag/keyword rules from `config/knowledge-domains.json`, stores domains on Bubble nodes
- Insight processor: `suites/proactive-intelligence/services/insight-processor.ts` — deduplication via SHA256 suppression hash, confidence threshold (0.6), stores in `insights` table, emits `notification` event
- Urgency classifier: `packages/core/src/notification-engine/urgency-classifier.ts` — rules for `insight:*` events (>= 0.8 → yellow/tell-when-active, < 0.8 → green/save-for-later)
- Delivery scheduler: `suites/notifications/services/delivery-scheduler.ts` — respects active hours, engagement throttling
- Telegram bot: `suites/notifications/services/telegram-bot.ts` — `buildInlineKeyboard()` with 2-per-row layout, MarkdownV2 rendering
- Callback handler: `suites/notifications/services/callback-handler.ts` — callback data format `domain:action:target`, 64-byte limit, domain/action parsing

## Acceptance Criteria

1. **Given** `knowledge:links:suggested` is emitted and the source bubble and any target bubble are in *different* domains
   **When** the cross-domain insight service processes the event
   **Then** it emits a `knowledge:insight:cross-domain` event with both bubble titles, their domains, the relationship type, and confidence

2. **Given** a `knowledge:insight:cross-domain` event is emitted with confidence >= 0.75 (configurable via `RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD`)
   **When** the insight processor handles it
   **Then** it creates an insight row in the `insights` table with `pattern_key: 'cross-domain:{domainA}-{domainB}'`, deduplicates via suppression hash, and emits a `notification` event for Telegram delivery

3. **Given** a cross-domain insight notification is delivered to Telegram
   **When** the user views it
   **Then** it shows a formatted message with both bubble titles, their domains, and the detected relationship — with inline buttons: `[View in Graph]` `[Interesting]` `[Not Useful]`

4. **Given** the user taps `[View in Graph]`
   **When** the callback is handled
   **Then** a deep link to the dashboard knowledge graph page is sent, pre-filtered to show the two connected bubbles (`/knowledge?highlight={bubbleA},{bubbleB}`)

5. **Given** the user taps `[Not Useful]` on 3+ insights for the same domain pair
   **When** future cross-domain detection runs for that pair
   **Then** the confidence threshold for that specific domain pair is raised by 0.1 (adaptive suppression), stored in `cross_domain_thresholds` SQLite table

6. **Given** a link suggestion is within the same domain
   **When** it is processed
   **Then** it follows existing Epic 6 behavior — no proactive delivery, just stored as a pending suggestion

## Tasks / Subtasks

- [x] Task 1: Cross-domain insight detection service (AC: 1, 6)
  - [x] Create `suites/proactive-intelligence/services/cross-domain-detector.ts`
  - [x] Listen for `knowledge:links:suggested` events on the event bus
  - [x] For each link in the event payload, load both bubbles' domains from Neo4j (`(b:Bubble {id: $id})` → `b.domains`)
  - [x] Compare domains — if source bubble and target bubble have no overlapping domains, this is a cross-domain connection
  - [x] Filter by confidence threshold: `RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD` env var (default 0.75), check per-pair adaptive threshold from `cross_domain_thresholds` table
  - [x] Emit new `knowledge:insight:cross-domain` event with payload: `{ sourceBubble: {id, title, domains}, targetBubble: {id, title, domains}, confidence, relationshipType }`
  - [x] Same-domain links: skip (no-op, existing behavior preserved)

- [x] Task 2: Add event type and wire into insight processor (AC: 2)
  - [x] Add `KnowledgeInsightCrossDomainEvent` interface to `packages/shared/src/types/events.ts` following the existing pattern (extends `BaseEvent`, type `'knowledge:insight:cross-domain'`)
  - [x] Add to `RavenEvent` union type
  - [x] In `suites/proactive-intelligence/services/insight-processor.ts`, add a handler for `knowledge:insight:cross-domain` events
  - [x] Build insight record: `pattern_key: 'cross-domain:${sortedDomains.join("-")}'`, title from bubble titles, body describing the connection
  - [x] Use existing deduplication: `suppression_hash = SHA256([patternKey, sourceBubbleId, targetBubbleId].sort().join('|'))`
  - [x] Store with status `'queued'` if passes checks, emit `notification` event

- [x] Task 3: Telegram message formatting and inline keyboard (AC: 3)
  - [x] Format notification body: "Connection detected between **{titleA}** ({domainA}) and **{titleB}** ({domainB}) — *{relationshipType}* (confidence: {pct}%)"
  - [x] Build actions array with 3 buttons: `[{ label: 'View in Graph', action: 'ki:v:{insightId}' }, { label: 'Interesting', action: 'ki:i:{insightId}' }, { label: 'Not Useful', action: 'ki:n:{insightId}' }]`
  - [x] Callback data format: `ki:` prefix for knowledge-insight domain (fits 64-byte limit)
  - [x] Set `topicName: 'General'`

- [x] Task 4: Callback handler for knowledge insight actions (AC: 4, 5)
  - [x] Add `ki` (knowledge-insight) domain to `DOMAIN_MAP` in `suites/notifications/services/callback-handler.ts`
  - [x] Action map: `{ v: 'view-graph', i: 'interesting', n: 'not-useful' }`
  - [x] `view-graph`: Retrieve insight from DB, extract bubble IDs, send Telegram message with deep link URL `{RAVEN_WEB_URL}/knowledge?highlight={bubbleA},{bubbleB}`, update insight status to `'acted'`
  - [x] `interesting`: Update insight status to `'acted'`, emit `insight:feedback` event with `{ insightId, feedback: 'positive' }`
  - [x] `not-useful`: Update insight status to `'dismissed'`, record domain-pair dismissal in `cross_domain_dismissals` table, check if 3+ dismissals exist for this domain pair → if so, bump adaptive threshold

- [x] Task 5: Adaptive threshold persistence (AC: 5)
  - [x] Create migration `014-cross-domain-thresholds.sql`
  - [x] `domain_pair` key: sort the two domains alphabetically, join with `-`
  - [x] On 3rd dismissal for a pair: increment threshold by 0.1, cap at 0.95
  - [x] Cross-domain detector reads per-pair threshold, falls back to env var default

- [x] Task 6: Dashboard deep link support (AC: 4)
  - [x] In `packages/web/src/app/knowledge/page.tsx`, parse `highlight` query param
  - [x] If `highlight` is present (comma-separated bubble IDs), pass to knowledge store
  - [x] In `packages/web/src/stores/knowledge-store.ts`, add `highlightedNodeIds` state
  - [x] In `KnowledgeGraph.tsx`, when `highlightedNodeIds` is set: center view on those nodes, highlight them, dim others (same behavior as search result highlighting)

- [x] Task 7: Register service in suite boot (AC: all)
  - [x] Add cross-domain detector to `suites/proactive-intelligence/suite.ts` service list
  - [x] Ensure it starts during suite initialization (follows existing pattern of other services in the suite)

## Dev Notes

### Architecture Patterns

- **Suite pattern**: All proactive intelligence code lives under `suites/proactive-intelligence/`. Services are registered in `suite.ts` and started during boot.
- **Event-driven**: Fire-and-forget async. No ordering guarantees. Use event bus `on()` to listen, `emit()` to publish.
- **MCP isolation**: This story needs NO MCPs — it's pure event processing + DB operations. No sub-agents needed.
- **Callback 64-byte limit**: Keep callback data compact. `ki:v:{uuid}` is ~40 bytes, well within limit.

### Key Existing Code to Reuse

| What | Where | Use |
|------|-------|-----|
| Event emission for links | `packages/core/src/knowledge-engine/clustering.ts:208` | Source event to listen for |
| Bubble domain lookup | Neo4j `Bubble.domains` property | Check if cross-domain |
| Insight storage + dedup | `suites/proactive-intelligence/services/insight-processor.ts` | Reuse dedup logic, or call into it |
| Notification emit | `insight-processor.ts:164-218` | Follow same pattern for notification event |
| Keyboard builder | `suites/notifications/services/telegram-bot.ts:62-76` | `buildInlineKeyboard()` |
| Callback parser | `suites/notifications/services/callback-handler.ts:120-147` | Extend `DOMAIN_MAP` with `ki` prefix |
| Graph highlight | `packages/web/src/stores/knowledge-store.ts` | Existing search highlight dims non-matches |
| DB migrations | `packages/core/src/db/migrations/` | Follow numbering convention |
| Urgency rules | `packages/core/src/notification-engine/urgency-classifier.ts` | `insight:*` pattern already classified |

### File Naming & Location

All new files follow kebab-case. New service goes in `suites/proactive-intelligence/services/`. New migration in `packages/core/src/db/migrations/`. Event type in `packages/shared/src/types/events.ts`.

### Testing Strategy

- **Unit test** for cross-domain detector: mock event bus, mock Neo4j bubble reads, verify correct events emitted for cross-domain vs same-domain links
- **Unit test** for adaptive threshold: verify dismissal counting and threshold bumping logic
- **Unit test** for callback handler extension: verify `ki:` prefix parsing and action dispatch
- Mock the event bus and DB — no real Neo4j or SQLite in tests (use temp SQLite via `mkdtempSync` for threshold table tests)
- Test files in `suites/proactive-intelligence/__tests__/cross-domain-detector.test.ts`

### Anti-Patterns to Avoid

- **Do NOT modify `link-ops.ts` or `clustering.ts`** — listen to the existing `knowledge:links:suggested` event, don't change the emission point
- **Do NOT create a new sub-agent** — this is pure service logic (event listener + DB + event emitter), no LLM needed
- **Do NOT add new urgency rules** — existing `insight:*` pattern rules in urgency classifier already handle insight events
- **Do NOT duplicate dedup logic** — reuse or call into the existing `insight-processor.ts` suppression hash approach

### Project Structure Notes

- `suites/` is a separate workspace from `packages/` — it has its own build and test config
- Suites use the same shared types from `@raven/shared`
- Suite services get `db`, `eventBus`, `config` injected at boot via `suite.ts`
- Vitest config for suites: `suites/vitest.config.ts`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 9 — Story 9.1]
- [Source: packages/shared/src/types/events.ts#L595-L605 — KnowledgeLinksSuggestedEvent]
- [Source: packages/shared/src/types/events.ts#L677-L703 — Insight event types]
- [Source: packages/core/src/knowledge-engine/clustering.ts#L208 — links:suggested emission]
- [Source: suites/proactive-intelligence/services/insight-processor.ts — dedup + notification pattern]
- [Source: suites/notifications/services/callback-handler.ts — callback data format + parsing]
- [Source: suites/notifications/services/telegram-bot.ts#L62-76 — buildInlineKeyboard]
- [Source: packages/core/src/notification-engine/urgency-classifier.ts — insight urgency rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All suite tests pass: 184/184 (proactive-intelligence + notifications)
- `npm run check` passes (format, lint, tsc)
- Pre-existing failures in knowledge-* integration tests (require running Neo4j) and email-triage tests (unrelated)

### Completion Notes List
- ✅ Task 1: Created cross-domain detector service — listens for `knowledge:links:suggested`, queries Neo4j for bubble domains, emits `knowledge:insight:cross-domain` for cross-domain links. 9 unit tests.
- ✅ Task 2: Added `KnowledgeInsightCrossDomainEvent` to shared types, wired handler in insight-processor that creates insight records with dedup, emits notification with formatted body + 3-button keyboard. 6 unit tests.
- ✅ Task 3: Implemented as part of Task 2 — notification body format, `ki:` prefix callback actions, `topicName: 'General'`.
- ✅ Task 4: Extended callback handler with `ki` domain — view-graph (deep link with bubble IDs), interesting (positive feedback), not-useful (dismissal + adaptive threshold). Added `getInsightById` to insight-store. 10 unit tests.
- ✅ Task 5: Created migration 014-cross-domain-thresholds.sql. Threshold bumping logic in callback handler, reading in cross-domain detector.
- ✅ Task 6: Added `highlightedNodeIds` to knowledge store, parsed `highlight` query param in knowledge page, integrated dimming/centering in graph-hooks.
- ✅ Task 7: Registered `cross-domain-detector` in proactive-intelligence suite.ts.

### Change Log
- 2026-03-21: Implemented all 7 tasks for story 9.1 — cross-domain insight detection, processing, Telegram delivery with interactive buttons, adaptive thresholds, and dashboard deep links.

### File List
- suites/proactive-intelligence/services/cross-domain-detector.ts (new)
- suites/proactive-intelligence/__tests__/cross-domain-detector.test.ts (new)
- suites/proactive-intelligence/suite.ts (modified — added cross-domain-detector service)
- suites/proactive-intelligence/services/insight-processor.ts (modified — added cross-domain handler)
- suites/proactive-intelligence/__tests__/insight-processor.test.ts (modified — added cross-domain tests)
- suites/notifications/services/callback-handler.ts (modified — added ki domain + handler)
- suites/notifications/__tests__/callback-handler.test.ts (modified — added ki tests)
- packages/shared/src/types/events.ts (modified — added KnowledgeInsightCrossDomainEvent)
- packages/core/src/insight-engine/insight-store.ts (modified — added getInsightById)
- packages/web/src/stores/knowledge-store.ts (modified — added highlightedNodeIds)
- packages/web/src/app/knowledge/page.tsx (modified — parse highlight query param)
- packages/web/src/components/knowledge/graph-hooks.ts (modified — highlight dimming/centering)
- migrations/014-cross-domain-thresholds.sql (new)
