# 15 - Pipeline Monitor (Story 5.3)

Verify the frontend Pipeline Monitor page with pipeline cards, detail panel, run history, and polling.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), at least one pipeline configured in `config/pipelines/` (e.g. morning-briefing)

## Test Cases — Pipeline List

### PMON-01: Page header

**Steps:**
1. navigate: `http://localhost:4000/pipelines`
2. snapshot → assert:
   - heading "Pipeline Monitor"
   - text "Real-time view of pipeline execution status and health."

### PMON-02: Empty state (no pipelines)

**Steps:**
1. navigate: `http://localhost:4000/pipelines` (with no pipeline YAML files in `config/pipelines/`)
2. snapshot → assert:
   - text "No pipelines configured."
   - code element with text "config/pipelines/"

### PMON-03: Pipeline cards display

**Steps:**
1. navigate: `http://localhost:4000/pipelines` (with pipelines configured)
2. snapshot → assert:
   - at least 1 pipeline card visible
   - each card has: pipeline icon circle (w-8 h-8 rounded-full, pipe "|" character)
   - each card has: pipeline name text (font-medium)
   - each card has: enabled badge ("on" in green, or "off" in muted)
   - each card has: trigger label (e.g. "cron: 0 6 * * *", "manual")

### PMON-04: Pipeline description

**Steps:**
1. navigate: `http://localhost:4000/pipelines`
2. snapshot → assert:
   - pipeline cards with descriptions show description text below the name
   - description text is truncated (single line, muted color)

### PMON-05: Last run status display

**Steps:**
1. navigate: `http://localhost:4000/pipelines` (after triggering a pipeline run)
2. snapshot → assert:
   - pipeline card shows last run status icon (colored mono character)
   - relative timestamp of last run (e.g. "5m ago")

### PMON-06: Running pipeline indicator

**Steps:**
1. trigger a pipeline: `POST http://localhost:4001/api/pipelines/morning-briefing/trigger`
2. navigate: `http://localhost:4000/pipelines` (while pipeline is running)
3. snapshot → assert:
   - running pipeline's status icon has `pipeline-running` CSS class (animated)

### PMON-07: Next run display

**Steps:**
1. navigate: `http://localhost:4000/pipelines` (with a cron-triggered pipeline)
2. snapshot → assert:
   - card shows "Next:" followed by relative timestamp

### PMON-08: Disabled pipeline styling

**Steps:**
1. navigate: `http://localhost:4000/pipelines` (with a disabled pipeline, `enabled: false`)
2. snapshot → assert:
   - disabled pipeline's enabled badge shows "off" text
   - badge has muted color (not green)

### PMON-09: Polling every 5 seconds

**Steps:**
1. navigate: `http://localhost:4000/pipelines`
2. monitor: network_requests for 15 seconds

**Expected:**
- GET `/api/pipelines` fires on page load
- Same request repeats every ~5 seconds
- At least 3 requests in 15-second window

## Test Cases — Detail Panel

### PMON-10: Click card opens detail panel

**Steps:**
1. navigate: `http://localhost:4000/pipelines`
2. click: a pipeline card
3. snapshot → assert:
   - detail panel appears above the card list
   - panel shows pipeline name as heading (text-lg font-bold)
   - "Close" button visible
   - "Run Now" button visible (if pipeline is enabled)

### PMON-11: Detail panel description

**Steps:**
1. click: a pipeline card that has a description
2. snapshot → assert:
   - description text visible in detail panel (muted color)

### PMON-12: Run Now button disabled for disabled pipelines

**Steps:**
1. click: a disabled pipeline card
2. snapshot → assert:
   - "Run Now" button is NOT visible (only shown when `config.enabled` is true)
   - "Close" button still visible

### PMON-13: Close detail panel

**Steps:**
1. click: a pipeline card to open detail
2. click: "Close" button
3. snapshot → assert:
   - detail panel is removed from the page
   - pipeline card list still visible

### PMON-14: Toggle detail panel

**Steps:**
1. click: a pipeline card → detail opens
2. click: the same pipeline card again
3. snapshot → assert:
   - detail panel closes (toggle behavior)

### PMON-15: Recent Runs heading

**Steps:**
1. click: a pipeline card
2. snapshot → assert:
   - heading "Recent Runs" visible inside detail panel

### PMON-16: Recent runs list

**Steps:**
1. trigger a pipeline, wait for completion
2. click: that pipeline's card
3. snapshot → assert:
   - at least 1 run entry visible
   - each run shows: status icon (colored mono character)
   - each run shows: trigger type text (e.g. "manual", "cron")
   - each run shows: relative started time
   - completed runs show: duration

### PMON-17: Empty runs state

**Steps:**
1. click: a pipeline card that has never been triggered
2. snapshot → assert:
   - text "No executions yet."

### PMON-18: Expandable node results

**Steps:**
1. click: a pipeline card with completed runs
2. click: a run entry (to expand)
3. snapshot → assert:
   - expand indicator changes from "+" to "-"
   - node results tree appears (indented list with border-left)
   - each node shows: status icon, node name
   - nodes with duration show: formatted duration

### PMON-19: Collapse run entry

**Steps:**
1. click: an expanded run entry
2. snapshot → assert:
   - node results tree hidden
   - indicator shows "+"

### PMON-20: Failed run error display

**Steps:**
1. click: a pipeline card with a failed run
2. snapshot → assert:
   - failed run entry shows error message in red (var(--error) color)
3. click: the failed run to expand
4. snapshot → assert:
   - node results show which node failed (error text in red)

### PMON-21: Run Now triggers pipeline

**Steps:**
1. click: an enabled pipeline card
2. click: "Run Now" button
3. snapshot → assert:
   - button text changes to "Starting..." and becomes disabled
   - button returns to "Run Now" after request completes
4. monitor: network_requests
   - POST `/api/pipelines/<name>/trigger` was sent

### PMON-22: Runs polling (10s interval)

**Steps:**
1. click: a pipeline card to open detail
2. monitor: network_requests for 25 seconds

**Expected:**
- GET `/api/pipelines/<name>/runs?limit=10` fires when detail opens
- Same request repeats every ~10 seconds
- At least 2 requests in 25-second window
