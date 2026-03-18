# 20 - Knowledge Graph Visualization (Story 6.7)

Verify the interactive knowledge graph page with force-directed layout, view modes, color dimensions, search, filters, detail panel, bulk actions, and chat panel.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), knowledge bubbles with links/tags/domains/clusters exist in Neo4j (create at least 5-10 bubbles with varied tags and domains)

## Test Cases — Page Layout

### KGRAPH-01: Page loads with graph canvas

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - graph canvas area visible (full-width, fills available height)
   - controls toolbar visible at top (border-bottom)
   - no error overlays

### KGRAPH-02: Sidebar navigation link

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - link "Knowledge" in sidebar
3. click: link "Knowledge"
4. snapshot → assert:
   - URL is `/knowledge`
   - graph page loads

## Test Cases — View Modes

### KGRAPH-03: Five view mode buttons

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - label "View:" visible (text-xs, muted)
   - 5 view mode buttons: "Links", "Tags", "Timeline", "Clusters", "Domains"
   - "Links" is active by default (accent background, white text)

### KGRAPH-04: Switch view modes

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. click: "Tags" button
3. snapshot → assert:
   - "Tags" button now active (accent background)
   - "Links" button now inactive (muted styling)
   - graph re-renders with tag-based layout
4. click: "Clusters" button
5. snapshot → assert:
   - "Clusters" button now active
   - graph re-renders with cluster-based grouping
6. monitor: network_requests → assert:
   - `GET /api/knowledge/graph?view=tags` and `GET /api/knowledge/graph?view=clusters` were called

### KGRAPH-05: All view modes load without errors

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. click each view mode button in sequence: Links → Tags → Timeline → Clusters → Domains
3. for each: snapshot → assert:
   - graph renders nodes
   - no error overlays or blank canvas

## Test Cases — Color Dimensions

### KGRAPH-06: Color dimension selector

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - label "Color:" visible (text-xs, muted)
   - dropdown select with options: "Domain", "Permanence", "Connections", "Recency", "Cluster"
   - "Domain" is selected by default

### KGRAPH-07: Switch color dimension

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. change color dropdown to "Permanence"
3. snapshot → assert:
   - nodes recolor based on permanence (green for robust, blue for normal, yellow for temporary)
   - color legend updates to show permanence entries

### KGRAPH-08: Color legend displays

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - color legend visible (rounded, bg-card background)
   - text "Color: domain" (or current dimension name)
   - legend entries with colored dots (w-2.5 h-2.5 rounded-full) and labels
   - domain legend shows: health, work, finance, personal, tech, default

### KGRAPH-09: Color legend updates on dimension change

**Steps:**
1. change color dropdown to "Recency"
2. snapshot → assert:
   - legend text updates to "Color: recency"
   - legend entries show: "Old" (gray) and "New" (cyan)

## Test Cases — Search

### KGRAPH-10: Search input and button

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - search input with placeholder "Search knowledge..." (text-xs, w-48)
   - "Search" button (accent background, white text)
   - no "Clear" button initially

### KGRAPH-11: Execute search

**Steps:**
1. type: "meeting" in search input
2. click: "Search" button
3. snapshot → assert:
   - "Clear" button appears next to search button
   - color dimension auto-switches to relevance mode
   - matched nodes are highlighted, non-matched nodes dimmed
4. monitor: network_requests → assert:
   - search API call was made

### KGRAPH-12: Search via Enter key

**Steps:**
1. type: "project" in search input
2. press: Enter key
3. snapshot → assert:
   - search executes (same behavior as clicking Search button)

### KGRAPH-13: Clear search

**Steps:**
1. perform a search (as above)
2. click: "Clear" button
3. snapshot → assert:
   - search input cleared
   - "Clear" button disappears
   - color dimension reverts to "domain" (default)
   - all nodes return to normal appearance

### KGRAPH-14: Search with no results

**Steps:**
1. type: "xyznonexistent" in search input
2. click: "Search"
3. snapshot → assert:
   - no nodes highlighted
   - graph still renders (no crash or error)

## Test Cases — Filters

### KGRAPH-15: Filter panel displayed

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - text "Filters:" visible (muted, font-medium)
   - tag filter input with placeholder "Tag..."
   - domain filter input with placeholder "Domain..."
   - 3 permanence checkboxes: "temporary", "normal", "robust"

### KGRAPH-16: Add tag filter

**Steps:**
1. type: "meetings" in Tag filter input
2. press: Enter
3. snapshot → assert:
   - tag chip appears: "meetings x" (accent background, white text)
   - graph filters to show only nodes tagged "meetings"
   - filter count appears: "Filters (1)"

### KGRAPH-17: Add domain filter

**Steps:**
1. type: "work" in Domain filter input
2. press: Enter
3. snapshot → assert:
   - domain chip appears: "work x" (accent background, white text)
   - graph filters to show only nodes in "work" domain

### KGRAPH-18: Permanence checkbox filter

**Steps:**
1. check: "robust" checkbox
2. snapshot → assert:
   - only robust permanence nodes shown in graph
   - filter count updates

### KGRAPH-19: Remove filter chip

**Steps:**
1. add a tag filter (e.g. "meetings")
2. click: the "meetings x" chip
3. snapshot → assert:
   - chip removed
   - graph restores unfiltered nodes
   - filter count decreases

### KGRAPH-20: Clear all filters

**Steps:**
1. add multiple filters (tag + domain + permanence checkbox)
2. snapshot → assert: "Clear all" button visible
3. click: "Clear all" button
4. snapshot → assert:
   - all filter chips removed
   - all checkboxes unchecked
   - filter count gone (just "Filters:")
   - graph shows all nodes

### KGRAPH-21: Combined filters

**Steps:**
1. add tag filter "work"
2. check permanence "robust"
3. snapshot → assert:
   - filter count shows "(2)"
   - graph shows only nodes matching BOTH tag "work" AND permanence "robust"

## Test Cases — Bubble Detail Panel

### KGRAPH-22: Click node opens detail panel

**Steps:**
1. navigate: `http://localhost:4000/knowledge` (with bubbles)
2. click: a node on the graph
3. snapshot → assert:
   - detail panel appears on the right side (w-80, border-left)
   - heading "Bubble Detail" (text-sm font-bold)
   - "Close" button visible (text-xs, muted)

### KGRAPH-23: Detail panel content

**Steps:**
1. click: a node on the graph
2. snapshot → assert:
   - bubble title visible (text-sm font-semibold)
   - content text in scrollable area (max-h-48, overflow-y-auto, whitespace-pre-wrap)
   - "Tags:" label with tag chips (accent background, "tag x" format)
   - tag input with placeholder "+ tag"
   - "Domain:" label with domain value
   - "Permanence:" label with dropdown (temporary/normal/robust options)
   - "Cluster:" label with cluster name or "none"

### KGRAPH-24: Detail panel source file

**Steps:**
1. click: a node that has a source file
2. snapshot → assert:
   - "Source:" label with file path text

### KGRAPH-25: Detail panel linked nodes

**Steps:**
1. click: a node that has links to other nodes
2. snapshot → assert:
   - "Linked (N):" label with count
   - list of linked node titles (clickable, accent color)
3. click: a linked node title
4. snapshot → assert:
   - detail panel updates to show the clicked linked node's details

### KGRAPH-26: Edit permanence in detail panel

**Steps:**
1. click: a node to open detail panel
2. change permanence dropdown from current value to a different one (e.g. "robust")
3. snapshot → assert:
   - permanence updates immediately in the dropdown
4. monitor: network_requests → assert:
   - PATCH permanence API call sent

### KGRAPH-27: Add tag in detail panel

**Steps:**
1. click: a node to open detail panel
2. type: "newtag" in the "+ tag" input
3. press: Enter
4. snapshot → assert:
   - new tag chip "newtag x" appears in the tags list
   - tag input clears
5. monitor: network_requests → assert:
   - update API call sent with new tags

### KGRAPH-28: Remove tag in detail panel

**Steps:**
1. click: a node with tags
2. click: a tag chip (e.g. "meetings x")
3. snapshot → assert:
   - tag removed from the list
4. monitor: network_requests → assert:
   - update API call sent with tag removed

### KGRAPH-29: Close detail panel

**Steps:**
1. click: a node to open detail
2. click: "Close" button
3. snapshot → assert:
   - detail panel removed
   - graph canvas takes full width

## Test Cases — Bulk Actions

### KGRAPH-30: Shift-click multi-select

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. click: first node (normal click)
3. shift+click: second node
4. snapshot → assert:
   - bulk action bar appears at bottom center (absolute, shadow-lg, z-10)
   - text "2 selected"
   - preview of selected node titles

### KGRAPH-31: Bulk action buttons

**Steps:**
1. multi-select 2+ nodes
2. snapshot → assert:
   - "Merge" button (accent background, white text)
   - "Re-tag" button (bg-hover)
   - "Permanence" button (bg-hover)
   - "Delete" button (red background, `#ef4444`)
   - "Cancel" button (muted text)

### KGRAPH-32: Merge bulk action

**Steps:**
1. multi-select 2 nodes
2. click: "Merge" button
3. confirm: browser confirmation dialog
4. snapshot → assert:
   - merged nodes disappear, single merged node appears
   - selection cleared
   - bulk action bar removed

### KGRAPH-33: Re-tag bulk action

**Steps:**
1. multi-select 2+ nodes
2. click: "Re-tag" button
3. snapshot → assert:
   - tag input appears with placeholder "tag1, tag2..."
   - "Apply" button appears
4. type: "important, review"
5. click: "Apply"
6. snapshot → assert:
   - re-tag input closes
   - graph refreshes

### KGRAPH-34: Change permanence bulk action

**Steps:**
1. multi-select 2+ nodes
2. click: "Permanence" button
3. snapshot → assert:
   - permanence dropdown appears (temporary/normal/robust)
   - "Apply" button appears
4. select: "robust"
5. click: "Apply"
6. snapshot → assert:
   - permanence dropdown closes
   - graph refreshes

### KGRAPH-35: Delete bulk action

**Steps:**
1. multi-select 2+ nodes
2. click: "Delete" button
3. confirm: browser confirmation dialog
4. snapshot → assert:
   - deleted nodes removed from graph
   - selection cleared
   - bulk action bar removed

### KGRAPH-36: Cancel bulk selection

**Steps:**
1. multi-select 2+ nodes
2. click: "Cancel" button
3. snapshot → assert:
   - selection cleared
   - bulk action bar removed
   - all nodes return to normal state

### KGRAPH-37: Merge limited to 10 nodes

**Steps:**
1. multi-select 11+ nodes
2. snapshot → assert:
   - "Merge" button is NOT visible (limit is 10)
   - other bulk actions (Re-tag, Permanence, Delete) still visible

## Test Cases — Chat Panel

### KGRAPH-38: Chat toggle button

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. snapshot → assert:
   - "Chat" button visible at bottom-right (accent background, white text, shadow-lg)

### KGRAPH-39: Open chat panel

**Steps:**
1. click: "Chat" button
2. snapshot → assert:
   - chat panel opens on the right side (w-80, border-left)
   - heading "Knowledge Chat" (text-sm font-bold)
   - "Close" button visible
   - message area (empty initially)
   - input with placeholder "Ask about knowledge..."
   - "Send" button (accent background)

### KGRAPH-40: Send message in chat

**Steps:**
1. open chat panel
2. type: "What are my recent notes about?"
3. click: "Send" button
4. snapshot → assert:
   - user message appears (right-aligned, accent background, white text)
   - "Thinking..." indicator appears (muted text)
5. wait: for response
6. snapshot → assert:
   - assistant message appears (left-aligned, bg-card background)
   - "Thinking..." indicator removed

### KGRAPH-41: Send via Enter key

**Steps:**
1. open chat panel
2. type: "Summarize my knowledge"
3. press: Enter
4. snapshot → assert:
   - message sends (same as clicking Send)

### KGRAPH-42: Context from selected nodes

**Steps:**
1. click: a node on the graph to select it
2. open chat panel
3. snapshot → assert:
   - text "Context: 1 node selected" visible above input (text-xs, muted)
4. type and send a message
5. verify: the selected node's context was included in the chat request

### KGRAPH-43: Close chat panel

**Steps:**
1. open chat panel
2. click: "Close" button
3. snapshot → assert:
   - chat panel closes
   - "Chat" toggle button reappears at bottom-right

## Test Cases — WebSocket Updates

### KGRAPH-44: Real-time graph updates

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. in another tab/terminal, create a new bubble:
   ```
   POST http://localhost:4001/api/knowledge/bubbles
   { "title": "New Test Bubble", "content": "Created for WS test", "tags": ["test"] }
   ```
3. observe the knowledge graph page → assert:
   - graph automatically refreshes to include the new bubble (no manual reload needed)

### KGRAPH-45: WebSocket channels

**Steps:**
1. navigate: `http://localhost:4000/knowledge`
2. monitor: WebSocket messages
3. trigger knowledge changes (create, update, delete bubble; trigger clustering)
4. assert: events received on channels:
   - `knowledge:bubble:created`
   - `knowledge:bubble:updated`
   - `knowledge:bubble:deleted`
   - `knowledge:clustering:complete`
   - `knowledge:link:created`
   - `knowledge:retrospective:complete`
