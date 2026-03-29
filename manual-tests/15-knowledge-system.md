# 15 - Knowledge System (v2)

Validates knowledge graph, context injection, lifecycle management, and retrospective features.

Prerequisites: Both servers running, some knowledge bubbles exist

## Test Cases — Knowledge CRUD

### KN-01: Create a knowledge bubble

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge \
     -H "Content-Type: application/json" \
     -d '{"title": "Test Knowledge", "content": "This is test knowledge for v2", "tags": ["test", "v2"], "domain": "system"}'
   ```
2. assert: status 200 or 201
3. assert: response has `id`, `title`, `content`, `tags`

### KN-02: List knowledge bubbles

**Steps:**
1. curl: `GET http://localhost:4001/api/knowledge`
2. assert: status 200
3. assert: JSON array with knowledge entries

### KN-03: Search knowledge

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge/search \
     -H "Content-Type: application/json" \
     -d '{"query": "test knowledge v2"}'
   ```
2. assert: status 200
3. assert: results include the bubble from KN-01

## Test Cases — Knowledge Context Injection

### KN-04: Chat response includes knowledge context

**Steps:**
1. create knowledge about a topic (e.g., "My calculus exam is on April 5th")
2. start a new chat session
3. send: "When is my calculus exam?"
4. assert: agent response references the knowledge (mentions April 5th)

### KN-05: Knowledge references tracked per session

**Steps:**
1. after a chat that used knowledge context
2. check session debug panel or API
3. assert: references list shows which bubbles were injected
4. assert: each reference has a relevance score

## Test Cases — Knowledge Graph UI

### KN-06: Knowledge graph page loads

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - graph visualization canvas (or list view)
   - view mode buttons (Links, Tags, Timeline, Clusters, Domains)
   - search input
   - filter panel

### KN-07: Graph view modes switch correctly

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. click: each view mode button (Links, Tags, Timeline, Clusters, Domains)
3. assert: graph re-renders for each mode
4. assert: no errors or blank screen on mode switch

### KN-08: Knowledge search from graph page

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. type: search query in search input
3. click: search button (or press Enter)
4. assert: graph highlights or filters to matching nodes
5. clear search
6. assert: graph reverts to full view

### KN-09: Node detail panel

**Steps:**
1. click: a knowledge node in the graph
2. assert: detail panel opens showing:
   - title, content
   - tags
   - domain
   - permanence level
   - linked nodes
3. click: close button
4. assert: panel closes

### KN-10: Filter by tags and domain

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. add a tag filter (e.g., "test")
3. assert: only nodes with that tag shown
4. add a domain filter (e.g., "system")
5. assert: only matching nodes shown
6. click: "Clear all filters"
7. assert: all nodes visible again

## Test Cases — Knowledge Lifecycle

### KN-11: Stale bubble detection

**Steps:**
1. curl: `GET http://localhost:4001/api/knowledge/stale`
2. assert: status 200
3. assert: returns array of stale bubbles (not accessed recently, based on permanence rules)

### KN-12: Merge knowledge bubbles

**Steps:**
1. create 2 similar bubbles
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge/merge \
     -H "Content-Type: application/json" \
     -d '{"bubbleIds": ["{id1}", "{id2}"], "mergedTitle": "Merged Knowledge"}'
   ```
3. assert: status 200
4. assert: merged bubble created, originals removed or linked

### KN-13: Knowledge retrospective

**Steps:**
1. curl: `POST http://localhost:4001/api/knowledge/retrospective/trigger`
2. assert: status 200
3. curl: `GET http://localhost:4001/api/knowledge/retrospective`
4. assert: retrospective summary returned

## Test Cases — Project Knowledge

### KN-14: Link bubble to project

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/knowledge/link \
     -H "Content-Type: application/json" \
     -d '{"bubbleId": "{bubbleId}"}'
   ```
2. assert: status 200
3. curl: `GET http://localhost:4001/api/projects/{projectId}/knowledge`
4. assert: linked bubble appears in project knowledge

### KN-15: Knowledge tab in project detail

**Steps:**
1. navigate to a project detail page
2. click: "Knowledge" tab
3. assert: linked knowledge bubbles displayed
4. assert: data sources section visible
5. assert: option to add/remove knowledge links
