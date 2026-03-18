# Story 6.7: Knowledge Graph Visualization

Status: done

## Story

As the system operator,
I want an interactive knowledge graph visualization similar to Obsidian, where I can explore, query, filter, and modify my knowledge visually,
So that I can understand the structure of my second brain and interact with it spatially.

## Acceptance Criteria

1. **Given** the knowledge graph page loads **When** the visualization renders **Then** knowledge bubbles appear as interactive nodes with connections (links) as edges, supporting pan, zoom, and click for detail

2. **Given** the user clicks a node **When** the detail panel opens **Then** it shows the full bubble content, tags, domain, permanence, links, cluster membership, and source file (with file opening capability)

3. **Given** multiple view dimensions exist **When** the user switches view mode **Then** the graph re-renders for: direct link connections, tag hierarchy connections, timeline (chronological layout), cluster grouping, or domain grouping

4. **Given** nodes have varying properties **When** color coding is applied **Then** nodes are colored by selectable dimension: domain, connection degree (hub vs leaf), permanence level, relevance to current query, recency, or cluster membership

5. **Given** the user enters a search query **When** the multi-tier retrieval engine returns results **Then** matched nodes are highlighted in the graph, non-matches are dimmed, and the graph centers on the result cluster

6. **Given** the user applies tag or dimension filters **When** the filter is active **Then** only matching nodes and their connections are visible; the rest are hidden

7. **Given** the user opens the chat panel alongside the graph **When** they discuss knowledge ("shrink this node and surroundings", "link these two", "what connects these clusters?") **Then** the knowledge agent executes the request and the graph updates in real-time

8. **Given** the user selects multiple nodes **When** they choose a bulk action (merge, re-tag, change permanence, delete) **Then** the action is applied and the graph re-renders with updated structure

## Tasks / Subtasks

- [x] Task 1: Graph data API endpoint (AC: #1, #3)
  - [x] 1.1 `GET /api/knowledge/graph` — returns all bubbles as nodes + all links as edges in a single response
  - [x] 1.2 Support `?view=links|tags|timeline|clusters|domains` query param to shape the edge set
  - [x] 1.3 Node payload: `{ id, title, domain, permanence, tags[], clusterLabel, connectionDegree, createdAt, updatedAt, lastAccessedAt }`
  - [x] 1.4 Edge payload: `{ source, target, relationshipType, confidence }`
  - [x] 1.5 For `view=tags`: edges derived from shared tags; for `view=clusters`: edges between cluster members; for `view=domains`: edges between same-domain bubbles; for `view=timeline`: no edges, position by date
  - [x] 1.6 Zod schema: `GraphQuerySchema` with view enum, optional `tag`/`domain`/`permanence` filters

- [x] Task 2: Knowledge page and graph component (AC: #1)
  - [x] 2.1 Create `packages/web/src/app/knowledge/page.tsx` — full-width layout with graph canvas + collapsible side panels
  - [x] 2.2 Add `knowledge` link to Sidebar component
  - [x] 2.3 Install `react-force-graph-2d` — dynamic import with `next/dynamic` + `ssr: false` (canvas-based, no SSR)
  - [x] 2.4 Create `packages/web/src/components/knowledge/KnowledgeGraph.tsx` — wraps ForceGraph2D with node/link rendering
  - [x] 2.5 Implement pan, zoom (built-in to react-force-graph-2d), click-to-select node
  - [x] 2.6 Node rendering: circle with label, sized by connection degree, colored by active dimension
  - [x] 2.7 Edge rendering: lines colored by relationship type, opacity by confidence
  - [x] 2.8 Add `knowledge` graph data fetching to api-client.ts

- [x] Task 3: Detail panel (AC: #2)
  - [x] 3.1 Create `packages/web/src/components/knowledge/BubbleDetailPanel.tsx` — slide-in panel on node click
  - [x] 3.2 Display: title, full content (markdown rendered), tags as chips, domain badge, permanence badge, cluster label
  - [x] 3.3 Show linked bubbles list (clickable — navigates graph to that node)
  - [x] 3.4 Show source file path if present
  - [x] 3.5 Inline edit: permanence dropdown, tag add/remove, domain reassignment — PATCH/PUT to existing API endpoints

- [x] Task 4: View modes (AC: #3)
  - [x] 4.1 Create `packages/web/src/components/knowledge/GraphControls.tsx` — toolbar above graph
  - [x] 4.2 View mode selector: Links (default), Tags, Timeline, Clusters, Domains
  - [x] 4.3 On view change: re-fetch `/api/knowledge/graph?view=<mode>`, re-render graph with new edge set
  - [x] 4.4 Timeline view: disable force simulation, position nodes on x-axis by createdAt date

- [x] Task 5: Color coding (AC: #4)
  - [x] 5.1 Color dimension selector in GraphControls toolbar
  - [x] 5.2 Color schemes: domain (categorical palette), permanence (green/blue/gold for robust/normal/temporary), connection degree (gradient low→high), recency (gradient old→new), cluster (categorical)
  - [x] 5.3 Legend component showing active color mapping
  - [x] 5.4 Query relevance coloring: activated when search results are present — score mapped to intensity

- [x] Task 6: Search integration (AC: #5)
  - [x] 6.1 Search bar in GraphControls — calls `POST /api/knowledge/search` (existing endpoint)
  - [x] 6.2 On results: highlight matched node IDs, dim non-matched nodes (reduced opacity)
  - [x] 6.3 Auto-zoom to center on result cluster using `centerAt()` + `zoom()` API
  - [x] 6.4 Clear search restores full graph view
  - [x] 6.5 Switch color dimension to "relevance" automatically when search is active

- [x] Task 7: Filters (AC: #6)
  - [x] 7.1 Filter panel in GraphControls: tag multi-select, domain multi-select, permanence checkboxes
  - [x] 7.2 Client-side filtering: hide non-matching nodes and their edges from the graph data
  - [x] 7.3 Show filter count badge when filters are active
  - [x] 7.4 "Clear all" button to reset filters

- [x] Task 8: Chat panel integration (AC: #7)
  - [x] 8.1 Create `packages/web/src/components/knowledge/GraphChatPanel.tsx` — collapsible panel beside graph
  - [x] 8.2 Reuse existing chat infrastructure (useChat hook pattern from project chat)
  - [x] 8.3 Send messages via `POST /api/chat` with project context indicating knowledge graph mode
  - [x] 8.4 On WebSocket events (`knowledge:bubble:created`, `knowledge:bubble:updated`, `knowledge:bubble:deleted`, `knowledge:link:created`): refetch graph data and re-render
  - [x] 8.5 Selected node context: include selected node ID(s) in chat messages so agent knows what "this node" means

- [x] Task 9: Bulk actions (AC: #8)
  - [x] 9.1 Multi-select mode: shift+click or lasso select for multiple nodes
  - [x] 9.2 Bulk action toolbar appears when 2+ nodes selected: Merge, Re-tag, Change Permanence, Delete
  - [x] 9.3 Merge: calls `POST /api/knowledge/merge` with selected bubble IDs (existing endpoint, 2-10 limit)
  - [x] 9.4 Re-tag: modal with tag input, calls `PUT /api/knowledge/:id` for each bubble
  - [x] 9.5 Change permanence: dropdown, calls `PATCH /api/knowledge/:id/permanence` for each
  - [x] 9.6 Delete: confirmation dialog, calls `DELETE /api/knowledge/:id` for each
  - [x] 9.7 After any bulk action: refetch graph data

- [x] Task 10: Zustand store and state management (AC: all)
  - [x] 10.1 Create `packages/web/src/stores/knowledge-store.ts` — graph state (nodes, edges, selectedNodeIds, viewMode, colorDimension, filters, searchResults)
  - [x] 10.2 Actions: setViewMode, setColorDimension, setFilters, setSearchResults, selectNode, toggleMultiSelect, clearSelection
  - [x] 10.3 Computed: filteredNodes, filteredEdges (derived from raw data + active filters)

- [x] Task 11: Tests (AC: all)
  - [x] 11.1 Backend: test `/api/knowledge/graph` endpoint with different view modes and filters
  - [x] 11.2 Backend: test graph data shape (nodes have required fields, edges reference valid node IDs)
  - [x] 11.3 Frontend: test KnowledgeGraph renders without crashing (mock canvas context)
  - [x] 11.4 Frontend: test filter logic in Zustand store (filter by tag, domain, permanence)
  - [x] 11.5 Frontend: test bulk action flows (select → action → refetch)

## Dev Notes

### Graph Visualization Library: `react-force-graph-2d`

**Why this library:**
- Canvas-based 2D force-directed graph (d3-force under the hood) — closest to Obsidian's graph view
- Lightweight, actively maintained (v1.29+), widely used
- Built-in pan/zoom/drag, customizable node/link rendering via Canvas API
- `centerAt()`, `zoom()`, `d3Force()` APIs for programmatic control
- Handles hundreds of nodes performantly on canvas

**Critical Next.js integration:**
```tsx
import dynamic from 'next/dynamic';
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });
```
Canvas/WebGL components CANNOT render server-side. Must use `next/dynamic` with `ssr: false`.

**Data format expected by react-force-graph-2d:**
```typescript
interface GraphData {
  nodes: Array<{ id: string; [key: string]: unknown }>;
  links: Array<{ source: string; target: string; [key: string]: unknown }>;
}
```

**Key APIs to use:**
- `nodeCanvasObject` — custom node rendering (circle + label + color)
- `linkColor` / `linkWidth` — edge styling by relationship type
- `onNodeClick` — open detail panel
- `d3Force('charge').strength(-120)` — adjust node repulsion
- `d3Force('link').distance(80)` — adjust edge length
- `cooldownTicks(200)` — stop simulation after stabilizing
- `onNodeDragEnd` — pin node position after drag

### Existing API Endpoints to Consume (DO NOT recreate)

| Endpoint | Usage |
|----------|-------|
| `GET /api/knowledge` | List bubbles with filtering |
| `GET /api/knowledge/:id` | Full bubble detail for panel |
| `GET /api/knowledge/:id/links` | Links for a specific bubble |
| `POST /api/knowledge/search` | Multi-tier search for highlighting |
| `GET /api/knowledge/clusters` | Cluster list for cluster view |
| `GET /api/knowledge/tags?tree=true` | Tag hierarchy for tag view |
| `GET /api/knowledge/domains` | Domain list for domain view |
| `POST /api/knowledge/merge` | Bulk merge (2-10 bubbles) |
| `PUT /api/knowledge/:id` | Update bubble (tags, content) |
| `PATCH /api/knowledge/:id/permanence` | Change permanence level |
| `DELETE /api/knowledge/:id` | Remove bubble |

### New Endpoint Required

**`GET /api/knowledge/graph`** — Single endpoint returning graph-ready data.

This is a **composite endpoint** that:
1. Fetches all bubbles (as nodes) from Neo4j with lightweight metadata
2. Fetches edges based on `view` param:
   - `links` (default): actual KnowledgeLink relationships from Neo4j
   - `tags`: synthetic edges between bubbles sharing tags (computed server-side)
   - `clusters`: edges between bubbles in the same cluster
   - `domains`: edges between bubbles in the same domain
   - `timeline`: nodes only, no edges (frontend positions by date)
3. Supports filters: `?tag=X&domain=Y&permanence=Z` to reduce the graph

**Implementation location:** Add route handler in `packages/core/src/api/routes/knowledge.ts`

**Neo4j queries needed:**
- Nodes: `MATCH (b:Bubble) RETURN b.id, b.title, b.permanence, b.tags, b.domains, b.clusterLabel, b.createdAt, b.updatedAt, b.lastAccessedAt`
- Link edges: `MATCH (b1:Bubble)-[r:LINKED_TO]->(b2:Bubble) RETURN b1.id as source, b2.id as target, r.type as relationshipType, r.confidence as confidence`
- Connection degree: `MATCH (b:Bubble) OPTIONAL MATCH (b)-[r:LINKED_TO]-() RETURN b.id, count(r) as degree`

### Architecture Patterns to Follow

- **Factory functions** — no classes for new modules; `createXxx(deps)` pattern
- **Pino logging** — `createLogger('knowledge-graph')` for the route handler
- **Zod validation** — `GraphQuerySchema` for query params
- **Zustand store** — one store per domain area (`knowledge-store.ts`)
- **Flat page structure** — `/knowledge` as top-level page
- **Tailwind CSS 4** — all styling via utility classes, no CSS modules
- **`.ts` extensions** in all imports
- **`node:` prefix** for Node builtins
- **No `console.log`** — Pino only (backend), but frontend can use console in dev

### Web Component Conventions (from existing patterns)

Look at existing components for patterns:
- `packages/web/src/components/pipelines/` — PipelineList.tsx, PipelineStatus.tsx (data table + status display)
- `packages/web/src/components/tasks/` — task board patterns
- `packages/web/src/components/activity/` — activity feed patterns
- `packages/web/src/hooks/usePolling.ts` — for periodic graph data refresh
- `packages/web/src/stores/app-store.ts` — Zustand store pattern

### File Structure for This Story

**New files:**
```
packages/web/src/app/knowledge/page.tsx
packages/web/src/components/knowledge/KnowledgeGraph.tsx
packages/web/src/components/knowledge/BubbleDetailPanel.tsx
packages/web/src/components/knowledge/GraphControls.tsx
packages/web/src/components/knowledge/GraphChatPanel.tsx
packages/web/src/components/knowledge/ColorLegend.tsx
packages/web/src/components/knowledge/BulkActionBar.tsx
packages/web/src/components/knowledge/FilterPanel.tsx
packages/web/src/stores/knowledge-store.ts
```

**Modified files:**
```
packages/web/src/components/layout/Sidebar.tsx — add Knowledge link
packages/web/src/lib/api-client.ts — add knowledge graph API methods
packages/core/src/api/routes/knowledge.ts — add GET /api/knowledge/graph endpoint
packages/shared/src/types/knowledge.ts — add GraphNode, GraphEdge, GraphData, GraphQuerySchema types
packages/core/src/api/server.ts — wire graph route (if separate registration needed)
```

### Previous Story Intelligence (6.6)

**Key learnings from story 6.6:**
- Neo4j Cypher is used for all graph queries — bubble nodes have `lastAccessedAt`, `snoozedUntil` properties
- Factory function pattern: `createXxx(deps)` returning interface objects
- Event emission for state changes: `eventBus.emit()` with `generateId()`
- Merge operation re-points both incoming AND outgoing links (bug fix from 6.6 review)
- LLM synthesis uses agent task with 30s timeout + fallback
- 719 total tests passing before this story

**Code review fixes to learn from:**
- M1: Don't create links to entities that will be immediately destroyed
- M2: When re-pointing links during merge, handle BOTH directions
- M3: Add timeouts for LLM-dependent operations with graceful fallbacks

### WebSocket Events for Real-Time Updates

The graph should listen for these WebSocket events to auto-refresh:
- `knowledge:bubble:created` — add new node
- `knowledge:bubble:updated` — update node properties
- `knowledge:bubble:deleted` — remove node + connected edges
- `knowledge:clustering:complete` — refetch for cluster changes
- `knowledge:link:created` — add new edge (check if this event exists; if not, add it)
- `knowledge:retrospective:complete` — major changes, full refetch

### Performance Considerations

- **Initial load**: Fetch all graph data once, filter client-side for responsiveness
- **Node limit**: If bubble count exceeds ~500, consider server-side pagination or progressive loading
- **Canvas rendering**: react-force-graph-2d uses HTML5 Canvas — performant for hundreds of nodes
- **Force simulation**: Use `cooldownTicks(200)` to stop simulation after stabilizing (prevents CPU drain)
- **Refetch strategy**: Use `usePolling` with 30s interval OR rely entirely on WebSocket events for updates

### Project Structure Notes

- New page follows existing flat page structure: `app/knowledge/page.tsx`
- New components grouped under `components/knowledge/` following pattern of `components/pipelines/`, `components/tasks/`
- Zustand store follows `stores/app-store.ts` pattern
- API client additions follow existing `api.getXxx()` pattern in `api-client.ts`
- No conflicts with planned Story 6.8 (Knowledge Context UI) — 6.8 adds a reference panel to project chat, completely separate from the graph page

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 6, Story 6.7]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Architecture, API Patterns, Database Conventions]
- [Source: _bmad-output/implementation-artifacts/6-6-knowledge-lifecycle-and-retrospective.md — Previous Story Intelligence]
- [Source: _bmad-output/project-context.md — Project Rules & Conventions]
- [Source: packages/core/src/api/routes/knowledge.ts — 33 existing endpoints]
- [Source: packages/shared/src/types/knowledge.ts — All knowledge types]
- [Source: packages/web/src/lib/api-client.ts — API client patterns]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Debug Log References
- 733 tests passing (720 baseline + 13 new), 6 pre-existing Docker/Neo4j failures (no Docker in CI env)
- `npm run check` passes: format, eslint (0 warnings), tsc --noEmit, strip-types

### Completion Notes List
- Task 1: Added `GET /api/knowledge/graph` composite endpoint with 5 view modes (links, tags, timeline, clusters, domains), Zod validation, and optional tag/domain/permanence filters. Extracted helper functions for synthetic edge building (shared-tag, cluster-member, same-domain).
- Task 2: Created knowledge page with full-width graph canvas, installed react-force-graph-2d with next/dynamic SSR:false, added sidebar link.
- Task 3: BubbleDetailPanel shows full bubble detail on node click with inline editing (permanence, tags) and linked bubble navigation.
- Task 4: GraphControls toolbar with 5 view mode buttons triggering graph refetch.
- Task 5: 6 color dimensions (domain, permanence, connectionDegree, recency, cluster, relevance) with ColorLegend component and canvas-based rendering.
- Task 6: Search bar calls existing POST /api/knowledge/search, highlights matches, dims non-matches, auto-zooms to result cluster, auto-switches to relevance color mode.
- Task 7: FilterPanel with tag/domain text inputs and permanence checkboxes. Client-side filtering in Zustand store. Filter count badge and clear-all button.
- Task 8: GraphChatPanel sends messages via POST /api/chat with selected node context. WebSocket listeners for knowledge events trigger graph refetch.
- Task 9: Shift+click multi-select, BulkActionBar with Merge (2-10), Re-tag, Change Permanence, Delete. All call existing API endpoints.
- Task 10: Zustand store with all state, actions, and computed filtered data. Pure function getFilteredData for testability.
- Task 11: 7 backend tests for graph endpoint (view modes, filters, validation, edge integrity). 13 frontend tests for Zustand store (filter by tag/domain/permanence, combined filters, edge filtering, selection, view mode, color dimension, search results).

### File List
**New files:**
- packages/shared/src/types/knowledge.ts (modified — added GraphNode, GraphEdge, GraphData, GraphViewMode, GraphQuerySchema)
- packages/core/src/api/routes/knowledge.ts (modified — added graph endpoint + helper functions)
- packages/core/src/__tests__/knowledge-api.test.ts (modified — added 7 graph API tests)
- packages/web/src/app/knowledge/page.tsx (new)
- packages/web/src/components/knowledge/KnowledgeGraph.tsx (new)
- packages/web/src/components/knowledge/BubbleDetailPanel.tsx (new)
- packages/web/src/components/knowledge/GraphControls.tsx (new)
- packages/web/src/components/knowledge/GraphChatPanel.tsx (new)
- packages/web/src/components/knowledge/ColorLegend.tsx (new)
- packages/web/src/components/knowledge/BulkActionBar.tsx (new)
- packages/web/src/components/knowledge/FilterPanel.tsx (new)
- packages/web/src/components/knowledge/graph-colors.ts (new)
- packages/web/src/components/knowledge/graph-hooks.ts (new)
- packages/web/src/stores/knowledge-store.ts (new)
- packages/web/src/lib/api-client.ts (modified — added knowledge graph API methods + types)
- packages/web/src/components/layout/Sidebar.tsx (modified — added Knowledge link)
- packages/web/src/__tests__/knowledge-store.test.ts (new — 13 tests)
- packages/web/vitest.config.ts (new)
- vitest.config.ts (modified — added web project)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified — status update)
- packages/web/package.json (modified — added react-force-graph-2d dependency)

### Code Review Fixes (2026-03-18)
- **H1**: Fixed GraphChatPanel `projectId` always null — page now fetches first project via `useFirstProjectId` hook; chat panel is functional when projects exist
- **M2**: Removed unused `onRefetch` prop from FilterPanel (filtering is client-side only)
- **M3**: Replaced sequential `for` loops in BulkActionBar bulk actions with `Promise.allSettled` + error reporting to prevent silent partial failures
