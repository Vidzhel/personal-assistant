# Story 9.3: Knowledge Gap Detection & Learning Tracks

Status: ready-for-dev

## Story

As the system operator,
I want Raven to identify gaps in my knowledge and suggest learning tracks,
so that I can systematically grow in areas I care about.

## Context

Builds on Epic 6's knowledge engine (embeddings, tag hierarchy, domain classification, retrieval) and Epic 7's proactive intelligence pipeline (insight processing, urgency classification, engagement throttling, Telegram delivery). Story 9.1 established the cross-domain insight pattern — this story adds a second insight source: knowledge gaps detected by analyzing bubble content references and domain coverage.

**What already exists (DO NOT rebuild):**
- Embedding engine: `packages/core/src/knowledge-engine/embeddings.ts` — BGE-small-en-v1.5, 384-dim, cosine similarity, `findSimilar()`, Neo4j vector index
- Tag hierarchy: `packages/core/src/knowledge-engine/tag-tree.ts` — hierarchical tags with domain roots (level 0), child placement via embedding similarity
- Domain classification: `packages/core/src/knowledge-engine/clustering.ts` — `classifyDomains()` using rules from `config/knowledge-domains.json`, stores `IN_DOMAIN` relationships in Neo4j
- Retrieval engine: `packages/core/src/knowledge-engine/retrieval.ts` — multi-tier (chunk vector → linked → cluster siblings → tag cooccurrence), token budget assembly
- Knowledge store: `packages/core/src/knowledge-engine/knowledge-store.ts` — CRUD for bubbles, markdown file I/O
- Insight processor: `suites/proactive-intelligence/services/insight-processor.ts` — dedup via SHA256 suppression hash, confidence threshold (0.6), stores in `insights` table, emits `notification` event
- Cross-domain detector: `suites/proactive-intelligence/services/cross-domain-detector.ts` — latest suite service pattern, listens for events, queries Neo4j, emits insight events
- Data collector: `suites/proactive-intelligence/services/data-collector.ts` — listens for `schedule:triggered`, aggregates signals, fires agent tasks
- Callback handler: `suites/notifications/services/callback-handler.ts` — domain prefix routing (`ki:` for knowledge-insight), action mapping, 64-byte callback data limit
- Urgency classifier: `packages/core/src/notification-engine/urgency-classifier.ts` — `insight:*` events already classified
- Delivery scheduler: `suites/notifications/services/delivery-scheduler.ts` — active hours, engagement throttling
- Telegram bot: `suites/notifications/services/telegram-bot.ts` — `buildInlineKeyboard()` with 2-per-row layout, MarkdownV2 rendering
- Insight store: `packages/core/src/insight-engine/insight-store.ts` — `insertInsight`, `getInsightById`, `updateInsightStatus`, `computeSuppressionHash`, `findRecentByHash`
- Neo4j schema: Bubble nodes with `embedding`, `domains`, `tags`, `contentPreview`; relationships: `HAS_TAG`, `IN_DOMAIN`, `LINKS_TO`, `IN_CLUSTER`, `HAS_CHUNK`

## Acceptance Criteria

1. **Given** the knowledge graph has many bubbles about "event-driven architecture" but none about "saga pattern" despite references in bubble content
   **When** gap detection runs (scheduled weekly or triggered via API)
   **Then** "saga pattern" is identified as a knowledge gap linked to the user's active interest area

2. **Given** gap detection analyzes the tag hierarchy
   **When** a domain has significantly fewer bubbles than peer domains (e.g., "health" has 3 bubbles while "work" has 40)
   **Then** the sparse domain is flagged as a potential area of interest with low coverage

3. **Given** a knowledge gap is identified
   **When** a learning track is generated via LLM sub-agent
   **Then** it suggests 3-5 specific topics to explore, ordered by relevance to existing knowledge, with brief descriptions of why each matters

4. **Given** a learning track suggestion is delivered to Telegram
   **When** the user views it
   **Then** inline buttons offer `[Start Learning] [Save for Later] [Not Interested]`

5. **Given** the user taps `[Start Learning]`
   **When** the learning track is activated
   **Then** a knowledge bubble is created as a "learning track" with `source: 'gap-detection'`, `permanence: 'temporary'`, and the suggested topics as content — serving as a checklist

6. **Given** the user marks a gap as "Not Interested"
   **When** future gap detection runs
   **Then** that gap is excluded from future suggestions (stored in `knowledge_gap_suppressions` SQLite table)

7. **Given** gaps are detected
   **When** results are persisted
   **Then** they are stored in the `knowledge_gaps` SQLite table with fields: `id, topic, domain, confidence, source_bubble_ids, status (active|snoozed|dismissed), created_at, last_detected_at`

## Tasks / Subtasks

- [ ] Task 1: Database migration for knowledge gaps (AC: 7, 6)
  - [ ] Create `migrations/015-knowledge-gaps.sql`
  - [ ] Table `knowledge_gaps`: `id TEXT PRIMARY KEY, topic TEXT NOT NULL, domain TEXT, confidence REAL NOT NULL, source_bubble_ids TEXT (JSON array), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','snoozed','dismissed')), learning_track_id TEXT, created_at TEXT NOT NULL, last_detected_at TEXT NOT NULL, updated_at TEXT NOT NULL`
  - [ ] Table `knowledge_gap_suppressions`: `id TEXT PRIMARY KEY, gap_topic TEXT NOT NULL, domain TEXT, reason TEXT, created_at TEXT NOT NULL`
  - [ ] Index on `knowledge_gaps(status)` and `knowledge_gaps(domain)`
  - [ ] Index on `knowledge_gap_suppressions(gap_topic)`

- [ ] Task 2: Gap detection service — content reference analysis (AC: 1, 7)
  - [ ] Create `suites/proactive-intelligence/services/gap-detector.ts`
  - [ ] Follow `SuiteService` pattern from `cross-domain-detector.ts`: export default service with `start(context)` and `stop()`
  - [ ] Listen for `schedule:triggered` events (like data-collector pattern) — filter for schedule name `'knowledge-gap-detection'`
  - [ ] Also listen for a new `knowledge:gap-detection:trigger` event for API-triggered runs
  - [ ] **Content reference extraction**: Query Neo4j for all Bubble nodes, extract "referenced topics" from `contentPreview` — look for phrases like "related to X", "see also X", "X pattern", "X framework", mentions of proper nouns/technical terms that don't have a corresponding bubble
  - [ ] Use embedding similarity: for each extracted reference, run `findSimilar()` against existing bubble embeddings — if no bubble has cosine > 0.5, it's a gap candidate
  - [ ] Filter out suppressed gaps: check `knowledge_gap_suppressions` table by topic
  - [ ] Persist detected gaps in `knowledge_gaps` table with status `'active'`
  - [ ] For existing gaps found again: update `last_detected_at` (increase confidence for repeated detections)

- [ ] Task 3: Gap detection — sparse domain analysis (AC: 2, 7)
  - [ ] In the same gap-detector service, after content analysis
  - [ ] Query Neo4j: `MATCH (b:Bubble)-[:IN_DOMAIN]->(d:Domain) RETURN d.name AS domain, count(b) AS bubbleCount`
  - [ ] Calculate mean bubble count across domains; any domain with < 25% of the mean is "sparse"
  - [ ] Create gap entries with `topic: '{domain} knowledge', domain: '{domain}', confidence` proportional to sparseness ratio
  - [ ] Skip domains with 0 bubbles (user may not care about that domain at all)
  - [ ] Filter out suppressed domains from `knowledge_gap_suppressions`

- [ ] Task 4: Learning track generation via LLM sub-agent (AC: 3)
  - [ ] After gap detection completes, for each new gap with confidence >= configurable threshold (env `RAVEN_GAP_CONFIDENCE_THRESHOLD`, default 0.7)
  - [ ] Emit `knowledge:gap:detected` event with gap details
  - [ ] Insight processor handles `knowledge:gap:detected`: builds a prompt for the pattern-analysis agent (existing agent definition in data-collector) asking it to generate 3-5 learning topics ordered by relevance to existing bubbles
  - [ ] Agent response parsed as `AgentInsightResult` — title: "Learning Track: {gap topic}", body: numbered list of suggested topics with brief descriptions
  - [ ] Create insight via `insertInsight()` with `pattern_key: 'learning-track:{topic}'`, dedup via suppression hash
  - [ ] Emit `notification` event for Telegram delivery

- [ ] Task 5: Event type and notification formatting (AC: 4)
  - [ ] Add `KnowledgeGapDetectedEvent` to `packages/shared/src/types/events.ts` — `type: 'knowledge:gap:detected'`, payload: `{ gapId, topic, domain, confidence, sourceBubbleIds, gapType: 'content-reference' | 'sparse-domain' }`
  - [ ] Add `KnowledgeGapTriggerEvent` — `type: 'knowledge:gap-detection:trigger'` (for API-triggered runs)
  - [ ] Add to `RavenEvent` union type
  - [ ] In insight processor, format notification body: "Knowledge gap detected in **{domain}**: **{topic}** — {description of why this gap matters}"
  - [ ] Build actions array: `[{ label: 'Start Learning', action: 'kg:s:{gapId}' }, { label: 'Save for Later', action: 'kg:l:{gapId}' }, { label: 'Not Interested', action: 'kg:n:{gapId}' }]`
  - [ ] `kg:` prefix for knowledge-gap domain (fits 64-byte limit: `kg:s:{uuid}` ≈ 40 bytes)
  - [ ] Set `topicName: 'General'`

- [ ] Task 6: Callback handler for learning track actions (AC: 5, 6)
  - [ ] Add `kg` (knowledge-gap) domain to `DOMAIN_MAP` in `callback-handler.ts`
  - [ ] Action map: `{ s: 'start-learning', l: 'save-later', n: 'not-interested' }`
  - [ ] `start-learning`: Retrieve gap from `knowledge_gaps` table, create a new knowledge bubble via the knowledge store with `title: 'Learning Track: {topic}', source: 'gap-detection', permanence: 'temporary'`, content = numbered topic checklist from insight body. Update gap status to `'snoozed'`, set `learning_track_id` to new bubble ID. Send confirmation message to Telegram.
  - [ ] `save-later`: Update gap status to `'snoozed'`. Send brief confirmation.
  - [ ] `not-interested`: Update gap status to `'dismissed'`, insert row in `knowledge_gap_suppressions` with `gap_topic` and `domain`. Send confirmation.

- [ ] Task 7: API endpoint for manual trigger (AC: 1)
  - [ ] Add `POST /api/knowledge/gaps/detect` route in existing API routes
  - [ ] Emits `knowledge:gap-detection:trigger` event on the event bus
  - [ ] Returns `{ status: 'triggered' }`
  - [ ] Add `GET /api/knowledge/gaps` route — returns all gaps from `knowledge_gaps` table (with optional `?status=active` filter)

- [ ] Task 8: Schedule configuration and suite registration (AC: all)
  - [ ] Add `'gap-detector'` to `services` array in `suites/proactive-intelligence/suite.ts`
  - [ ] Add schedule entry in `config/schedules.json` (or wherever schedules are configured): `knowledge-gap-detection` with weekly cron `0 3 * * 0` (Sunday 3 AM)
  - [ ] Ensure gap-detector service starts during suite initialization

## Dev Notes

### Architecture Patterns

- **Suite service pattern**: Follow `cross-domain-detector.ts` exactly — `SuiteService` with `start(context)` / `stop()`, import `ServiceContext` from `@raven/core/suite-registry/service-runner.ts`
- **Event-driven schedule**: Data-collector listens for `schedule:triggered` events — gap-detector should do the same, filtering by schedule name
- **MCP isolation**: Gap detection is mostly pure service logic (Neo4j queries + SQLite + event emission). The LLM sub-agent call for learning track generation uses the existing pattern-analysis agent definition — no new MCP servers needed
- **Callback 64-byte limit**: `kg:s:{uuid}` is ~40 bytes, well within limit
- **Insight dedup**: Reuse `computeSuppressionHash` and `findRecentByHash` from insight-store — suppress identical gaps within 7-day window

### Key Existing Code to Reuse

| What | Where | Use |
|------|-------|-----|
| Suite service pattern | `suites/proactive-intelligence/services/cross-domain-detector.ts` | Copy structure exactly |
| Schedule trigger listening | `suites/proactive-intelligence/services/data-collector.ts:245` | Same `schedule:triggered` event pattern |
| Agent task emission | `data-collector.ts:220-235` | Same pattern for LLM sub-agent call |
| Insight storage + dedup | `packages/core/src/insight-engine/insight-store.ts` | `insertInsight`, `computeSuppressionHash`, `findRecentByHash` |
| Notification emit | `insight-processor.ts` notification event pattern | Follow same structure |
| Callback domain routing | `callback-handler.ts` DOMAIN_MAP | Add `kg` prefix |
| Embedding similarity | `packages/core/src/knowledge-engine/embeddings.ts` | `findSimilar()` for gap candidate validation |
| Neo4j bubble queries | `cross-domain-detector.ts` | Similar Cypher patterns |
| Knowledge bubble creation | `packages/core/src/knowledge-engine/knowledge-store.ts` | For creating learning track bubbles |
| Domain config | `config/knowledge-domains.json` | Domain names for sparse analysis |
| DB migration pattern | `migrations/014-cross-domain-thresholds.sql` | Follow same SQL style |

### File Naming & Location

All new files follow kebab-case:
- `suites/proactive-intelligence/services/gap-detector.ts` — main service
- `suites/proactive-intelligence/__tests__/gap-detector.test.ts` — unit tests
- `migrations/015-knowledge-gaps.sql` — schema migration

### Testing Strategy

- **Unit test** for gap detector: mock Neo4j queries (bubble content, domain counts), mock `findSimilar()`, verify correct gap records created and events emitted
- **Unit test** for sparse domain detection: mock domain counts, verify threshold calculation (< 25% of mean)
- **Unit test** for callback handler extension: verify `kg:` prefix parsing and all 3 action handlers
- **Unit test** for learning track bubble creation: verify bubble created with correct source/permanence/content
- Mock the event bus, Neo4j, and SQLite (use temp SQLite via `mkdtempSync` for gap table tests)
- Test files in `suites/proactive-intelligence/__tests__/gap-detector.test.ts` and extend `suites/notifications/__tests__/callback-handler.test.ts`

### Anti-Patterns to Avoid

- **Do NOT modify the embedding engine or tag-tree** — use their existing APIs (`findSimilar()`, Neo4j queries)
- **Do NOT modify clustering.ts or link-ops.ts** — gap detection is a new service that reads existing data
- **Do NOT create new urgency rules** — existing `insight:*` pattern rules in urgency classifier handle all insight events
- **Do NOT duplicate dedup logic** — use `computeSuppressionHash` and `findRecentByHash` from insight-store
- **Do NOT use classes** — follow the functional service pattern from cross-domain-detector
- **Do NOT hard-code domain names** — read from `config/knowledge-domains.json` or Neo4j Domain nodes
- **Do NOT use `console.log`** — use `createLogger('gap-detector')` from `@raven/shared`

### Content Reference Extraction Strategy

For AC 1, extracting "referenced but unexplored topics" from bubble content:
1. Query all Bubble nodes from Neo4j: `MATCH (b:Bubble) RETURN b.id, b.title, b.contentPreview, b.domains`
2. Build a set of known topics from bubble titles (lowercased, normalized)
3. For each bubble's `contentPreview`, extract potential topic references — look for:
   - Quoted terms, bold/italic markers in markdown
   - Technical terms (multi-word capitalized phrases)
   - "related to X", "see also X", "like X" patterns
4. For each candidate not in known topics set, validate via `findSimilar()` — if no existing bubble has cosine > 0.5, it's a genuine gap
5. Group gaps by domain (inherit from the source bubble's domain)
6. This approach is heuristic — don't over-engineer extraction. Simple regex + embedding validation is sufficient

### Previous Story Intelligence (9.1)

Story 9.1 established:
- `ki:` callback prefix pattern in callback-handler.ts — this story adds `kg:` prefix
- Cross-domain detector as a suite service — this story adds gap-detector as another service
- Event → insight-processor → notification pipeline — this story uses the same flow
- `cross_domain_thresholds` / `cross_domain_dismissals` tables — this story adds `knowledge_gaps` / `knowledge_gap_suppressions` tables following the same pattern
- Dashboard deep link support via URL params — learning track bubbles are regular bubbles viewable in the graph
- Tests: 184/184 passing in proactive-intelligence + notifications suites

### Git Intelligence

Recent commits show:
- Story 8.3 (financial tracking) and 8.2 (Drive monitoring) — suite-based architecture with services pattern
- MarkdownV2 fixes for Telegram — use Unicode PUA placeholders for special chars
- `npm run check` must pass (format, lint, tsc)

### Configuration

- Suite config: `config/suites.json` → `proactive-intelligence` section. Gap detection config could be added here or use env vars:
  - `RAVEN_GAP_CONFIDENCE_THRESHOLD` (default 0.7)
  - `RAVEN_GAP_SPARSE_DOMAIN_RATIO` (default 0.25 — domains with < 25% of mean bubble count)
  - `RAVEN_GAP_DETECTION_CRON` (default `0 3 * * 0` — weekly Sunday 3 AM)

### Project Structure Notes

- `suites/` is a separate workspace from `packages/` — it has its own build and test config
- Suites use shared types from `@raven/shared`
- Suite services get `db`, `eventBus`, `config`, `logger`, `projectRoot`, `integrationsConfig` injected via `ServiceContext`
- Vitest config for suites: `suites/vitest.config.ts`
- `.ts` extensions required in imports (enforced by ESLint `no-restricted-syntax`)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.3 — lines 1448-1484]
- [Source: _bmad-output/planning-artifacts/prd.md#FR48 — knowledge gap detection]
- [Source: suites/proactive-intelligence/services/cross-domain-detector.ts — suite service pattern]
- [Source: suites/proactive-intelligence/services/data-collector.ts — schedule:triggered listener pattern]
- [Source: packages/core/src/insight-engine/insight-store.ts — insight CRUD + dedup]
- [Source: suites/notifications/services/callback-handler.ts — callback domain routing]
- [Source: packages/core/src/knowledge-engine/embeddings.ts — findSimilar() API]
- [Source: packages/core/src/knowledge-engine/knowledge-store.ts — bubble creation]
- [Source: config/knowledge-domains.json — domain classification rules]
- [Source: config/suites.json — proactive-intelligence config]
- [Source: migrations/014-cross-domain-thresholds.sql — migration pattern]
- [Source: _bmad-output/implementation-artifacts/9-1-proactive-cross-domain-insight-delivery.md — previous story learnings]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
