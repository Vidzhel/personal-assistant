# 16 - Kanban Agent Task Board (Story 5.4)

Verify the Kanban task board with four status columns, task cards, detail panel with SSE streaming, and polling.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), some agent tasks exist (trigger a pipeline or send a chat to generate tasks)

## Test Cases — Page Layout

### TASK-01: Page header

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - heading "Agent Tasks"
   - text "Kanban board of active and completed agent tasks."

### TASK-02: Four columns displayed

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot → assert:
   - 4 columns visible: "Queued", "Running", "Completed", "Failed"
   - each column has: colored status dot (w-2 h-2 rounded-full)
   - each column has: label text (text-sm font-semibold)
   - each column has: count badge (numeric, muted background)

### TASK-03: Responsive grid layout

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. snapshot at different viewport widths:
   - desktop (xl): 4 columns side by side (`grid-cols-4`)
   - tablet (md): 2 columns per row (`grid-cols-2`)
   - mobile: 1 column stacked (`grid-cols-1`)

### TASK-04: Empty column state

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with no tasks in a particular status)
2. snapshot → assert:
   - empty columns show "No {status} tasks" text (e.g. "No queued tasks")
   - text is centered, muted color, small font

## Test Cases — Task Cards

### TASK-05: TaskCard display

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with tasks present)
2. snapshot → assert:
   - each task card has: status icon circle (w-7 h-7 rounded-full, colored border)
   - each task card has: skill name (text-sm font-medium)
   - each task card has: relative timestamp (e.g. "2m ago")
   - each task card has: truncated task ID (8 characters, monospace)

### TASK-06: Priority badge display

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with high/urgent priority tasks)
2. snapshot → assert:
   - high/urgent priority tasks show priority badge (colored border, label text)
   - normal/low priority tasks do NOT show a priority badge

### TASK-07: Prompt preview on card

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with tasks that have prompts)
2. snapshot → assert:
   - task cards show truncated prompt text (muted color, single line)

### TASK-08: Duration display on card

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with completed tasks)
2. snapshot → assert:
   - completed task cards show formatted duration

### TASK-09: Failed task error summary on card

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with failed tasks)
2. snapshot → assert:
   - failed task cards show first line of error message in red (var(--error))
   - error text is truncated to single line

### TASK-10: Running task animated indicator

**Steps:**
1. navigate: `http://localhost:4000/tasks` (with a running task)
2. snapshot → assert:
   - running task's status circle has `pipeline-running` CSS class (animated)

## Test Cases — Detail Panel

### TASK-11: Click card opens detail panel

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. click: a task card
3. snapshot → assert:
   - detail panel appears above the kanban grid
   - panel shows: status icon with color
   - panel shows: skill name as heading (text-lg font-bold)
   - panel shows: truncated task ID (8 chars, monospace, muted)
   - "Close" button visible

### TASK-12: Detail panel metadata

**Steps:**
1. click: a task card
2. snapshot → assert:
   - "Status:" label with colored status value
   - "Priority:" label with priority text
   - "Created:" timestamp (if present)
   - "Started:" timestamp (if present)
   - "Completed:" timestamp (if present, for completed tasks)
   - "Duration:" formatted value (if present)

### TASK-13: Detail panel prompt section

**Steps:**
1. click: a task card that has a prompt
2. snapshot → assert:
   - heading "Prompt"
   - full prompt text (not truncated, pre-wrap, muted color)

### TASK-14: Close detail panel

**Steps:**
1. click: a task card → detail opens
2. click: "Close" button
3. snapshot → assert:
   - detail panel removed from page
   - kanban grid still visible

### TASK-15: Detail loading state

**Steps:**
1. click: a task card
2. snapshot (immediately, before fetch completes) → assert:
   - skeleton loading indicator visible (h-6 w-48 animate-pulse)
   - "Close" button available during loading

### TASK-16: Detail error state

**Steps:**
1. click: a task card with an invalid/deleted task ID
2. snapshot → assert:
   - error message visible in red
   - task ID fragment shown (monospace)
   - "Close" button available

## Test Cases — Running Task: SSE Streaming

### TASK-17: Live output for running task

**Steps:**
1. trigger an agent task (e.g. via pipeline or chat)
2. navigate: `http://localhost:4000/tasks`
3. click: the running task card
4. snapshot → assert:
   - heading "Live Output"
   - connected indicator: green animated dot (w-2 h-2, pipeline-running class, var(--success) background)
   - monospace output area (font-mono, pre-wrap)

### TASK-18: SSE streaming content

**Steps:**
1. click: a running task card
2. wait: 5-10 seconds for output chunks
3. snapshot → assert:
   - output area shows streamed text content (not "Waiting for output...")
   - content updates in real-time as chunks arrive

### TASK-19: Waiting for output state

**Steps:**
1. click: a running task card (just started, no output yet)
2. snapshot → assert:
   - text "Waiting for output..." (muted color)

### TASK-20: Auto-scroll behavior

**Steps:**
1. click: a running task card with active output
2. wait: for multiple output chunks
3. observe: output area scrolls to bottom automatically as new content arrives

### TASK-21: SSE connection lifecycle

**Steps:**
1. click: a running task card → SSE connects
2. monitor: network_requests → assert: EventSource to `/api/agent-tasks/<id>/stream`
3. click: "Close" button → detail panel closes
4. monitor: network_requests → assert: SSE connection closed (no more events)

## Test Cases — Completed Task

### TASK-22: Completed task result display

**Steps:**
1. click: a completed task card
2. snapshot → assert:
   - heading "Result"
   - result text displayed in bordered box (pre-wrap, max-height 400px, scrollable)

### TASK-23: Completed task with no result

**Steps:**
1. click: a completed task that has no result string
2. snapshot → assert:
   - text "No result recorded."

## Test Cases — Failed Task

### TASK-24: Failed task error display

**Steps:**
1. click: a failed task card
2. snapshot → assert:
   - heading "Errors"
   - error messages displayed in red (var(--error) color)
   - each error on its own line (pre-wrap)
   - scrollable area (max-height 400px)

### TASK-25: Failed task with no error details

**Steps:**
1. click: a failed task that has no error array
2. snapshot → assert:
   - text "No error details available."

## Test Cases — Cancel Task

### TASK-26: Cancel button for running task

**Steps:**
1. click: a running task card
2. snapshot → assert:
   - "Cancel Task" button visible (red background)
3. click: "Cancel Task" button
4. snapshot → assert:
   - button text changes to "Cancelling..." and becomes disabled
5. monitor: network_requests → assert: cancel API call sent

### TASK-27: Cancel button for queued task

**Steps:**
1. click: a queued task card
2. snapshot → assert:
   - "Cancel Task" button visible

### TASK-28: No cancel button for completed/failed tasks

**Steps:**
1. click: a completed task card
2. snapshot → assert: no "Cancel Task" button
3. click: "Close", then click: a failed task card
4. snapshot → assert: no "Cancel Task" button

## Test Cases — Polling Behavior

### TASK-29: Active tasks polling (3s interval)

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. monitor: network_requests for 10 seconds

**Expected:**
- GET `/api/agent-tasks/active` fires on page load
- Same request repeats every ~3 seconds
- At least 3 requests in 10-second window

### TASK-30: Completed/failed tasks polling (10s interval)

**Steps:**
1. navigate: `http://localhost:4000/tasks`
2. monitor: network_requests for 25 seconds

**Expected:**
- GET `/api/agent-tasks?status=completed&limit=20` fires on page load
- GET `/api/agent-tasks?status=failed&limit=20` fires on page load
- Both repeat every ~10 seconds
- At least 2 requests each in 25-second window
