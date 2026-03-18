# 17 - Execution Metrics (Story 5.5)

Verify the Execution Metrics dashboard with period selector, summary cards, per-skill and per-pipeline breakdown tables, and the pipeline YAML preview in chat.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), some agent tasks and pipeline runs exist (trigger a pipeline or send chats to generate data)

## Test Cases — Page Layout

### MET-01: Page header

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. snapshot → assert:
   - heading "Execution Metrics"
   - text "Task and pipeline performance overview."

### MET-02: Sidebar navigation link

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - link "Metrics" in sidebar
3. click: link "Metrics"
4. snapshot → assert:
   - heading "Execution Metrics"
   - URL is `/metrics`

### MET-03: Loading skeleton

**Steps:**
1. navigate: `http://localhost:4000/metrics` (throttle network to slow 3G)
2. snapshot (before data loads) → assert:
   - 4 skeleton placeholders visible (`animate-pulse`, `h-20`, `rounded-lg`)
   - no summary cards yet

## Test Cases — Period Selector

### MET-04: Period buttons displayed

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. snapshot → assert:
   - 4 period buttons visible: "1h", "24h", "7d", "30d"
   - "24h" button is active by default (accent background, white text)
   - other buttons have muted styling (`var(--bg-hover)`, `var(--text-muted)`)

### MET-05: Switching period

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. click: "7d" button
3. snapshot → assert:
   - "7d" button now active (accent background)
   - "24h" button now inactive (muted styling)
4. click: "1h" button
5. snapshot → assert:
   - "1h" button now active
   - "7d" button now inactive

### MET-06: Period change triggers data refresh

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. monitor: network_requests
3. click: "7d" button

**Expected:**
- GET `/api/metrics?period=7d` request fired
- summary cards and tables update with new data

## Test Cases — Summary Cards

### MET-07: Four summary cards displayed

**Steps:**
1. navigate: `http://localhost:4000/metrics` (with task/pipeline data)
2. snapshot → assert:
   - 4 cards in a grid (`grid-cols-2 md:grid-cols-4`)
   - card labels: "Total Tasks", "Task Success Rate", "Avg Task Duration", "Pipeline Runs"
   - each card has a large bold value (`text-2xl font-bold`)
   - each card has a muted label (`text-xs`, `var(--text-muted)`)

### MET-08: Summary card values format

**Steps:**
1. navigate: `http://localhost:4000/metrics` (with data)
2. snapshot → assert:
   - "Total Tasks" shows a number (e.g. "5")
   - "Task Success Rate" shows a percentage (e.g. "80%")
   - "Avg Task Duration" shows formatted duration or "-" if no data
   - "Pipeline Runs" shows a number

### MET-09: Summary cards with no data

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. click: "1h" (choose a period with no activity)
3. snapshot → assert:
   - "Total Tasks" shows "0"
   - "Task Success Rate" shows "0%"
   - "Avg Task Duration" shows "-"
   - "Pipeline Runs" shows "0"

## Test Cases — Breakdown Tables

### MET-10: Per-Skill table displayed

**Steps:**
1. navigate: `http://localhost:4000/metrics` (with data)
2. snapshot → assert:
   - heading "Per-Skill Breakdown"
   - table headers: "Skill", "Count", "Success Rate", "Avg Duration"
   - at least 1 row with skill name, numeric count, percentage, duration

### MET-11: Per-Pipeline table displayed

**Steps:**
1. navigate: `http://localhost:4000/metrics` (with pipeline run data)
2. snapshot → assert:
   - heading "Per-Pipeline Breakdown"
   - table headers: "Pipeline", "Count", "Success Rate", "Avg Duration"
   - at least 1 row with pipeline name, numeric count, percentage, duration

### MET-12: Tables side by side on desktop

**Steps:**
1. navigate: `http://localhost:4000/metrics` (desktop viewport)
2. snapshot → assert:
   - two tables in a 2-column grid layout (`grid-cols-1 lg:grid-cols-2`)
   - Per-Skill on left, Per-Pipeline on right

### MET-13: Empty table state

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. select a period with no data
3. snapshot → assert:
   - tables show "No data for this period" (centered, muted text)

## Test Cases — Polling

### MET-14: Auto-refresh every 10 seconds

**Steps:**
1. navigate: `http://localhost:4000/metrics`
2. monitor: network_requests for 25 seconds

**Expected:**
- GET `/api/metrics?period=24h` fires on page load
- Same request repeats every ~10 seconds
- At least 2 requests in 25-second window

## Test Cases — Pipeline YAML Preview in Chat

### MET-15: YAML preview renders in chat

**Steps:**
1. navigate to a project chat page
2. send a message that asks the assistant to create a pipeline (e.g. "Create a pipeline that runs every morning at 6am")
3. wait: for assistant response containing YAML
4. snapshot → assert:
   - pipeline preview card visible (rounded-lg border)
   - header text "Pipeline YAML" (muted, text-xs)
   - YAML content displayed in monospace (`font-mono text-xs`)

### MET-16: YAML preview action buttons

**Steps:**
1. trigger a YAML preview in chat (as above)
2. snapshot → assert:
   - "Save" button visible (accent background, white text)
   - "Edit" button visible (bg-hover background)
   - "Cancel" button visible (muted text)

### MET-17: Edit mode in YAML preview

**Steps:**
1. trigger a YAML preview in chat
2. click: "Edit" button
3. snapshot → assert:
   - textarea appears (editable, `font-mono text-xs`)
   - YAML content is editable
   - action buttons still visible

### MET-18: Save pipeline from preview

**Steps:**
1. trigger a YAML preview in chat
2. click: "Save" button
3. snapshot → assert:
   - text "Saving..." appears briefly
   - then text "Saved" appears (green, `var(--success)`)
4. monitor: network_requests → assert: save API call sent

### MET-19: Cancel YAML preview

**Steps:**
1. trigger a YAML preview in chat
2. click: "Cancel" button
3. snapshot → assert:
   - preview card is dismissed from chat

### MET-20: Save error display

**Steps:**
1. trigger a YAML preview in chat
2. remove the `name:` line from the YAML (click Edit, delete it)
3. click: "Save" button
4. snapshot → assert:
   - error message text visible in red (`var(--error)`)
   - text "Missing pipeline name" or similar error
