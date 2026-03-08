# 09 - Sessions

Verify session lifecycle, selector UI, copy ID, and debug panel functionality.

## Prerequisites

- Smoke tests (01) passing
- Backend running with at least one project created
- Projects and Chat tests (04) passing

## Playwright MCP Tools Used

- `browser_click` — click buttons and dropdowns
- `browser_snapshot` — verify DOM changes after actions
- `browser_take_screenshot` — visual verification
- `browser_press_key` — keyboard interactions

## Test Cases

### SESS-01: Session Selector Shows Current Session Info

**Steps:**
1. Navigate to `/projects/{id}` for an existing project
2. Take a snapshot of the session selector bar

**Expected:**
- Session selector bar visible below the project header
- Shows truncated session ID (first 8 chars, monospace, dimmed)
- Shows session creation date
- Shows turn count (e.g. "0 turns")
- Dropdown arrow visible

### SESS-02: Session Dropdown Lists All Sessions

**Steps:**
1. Navigate to a project with multiple sessions
2. Click the session selector button

**Expected:**
- Dropdown appears below the selector
- Each session shows truncated ID, creation date, turn count, and status
- Active session is highlighted with `bg-hover` background
- Dropdown is scrollable if many sessions (max-height 256px)

### SESS-03: New Session Creates and Switches (No 400)

**Steps:**
1. Navigate to a project page
2. Note the current session ID
3. Click "New Session" button

**Expected:**
- No error (no 400 status)
- Session selector updates to show the new session
- New session has 0 turns
- Previous session appears in the dropdown
- Chat area clears (no messages from previous session)

### SESS-04: Switching Sessions Loads Correct Message History

**Steps:**
1. Send a message in the current session (e.g. "Hello session A")
2. Click "New Session" to create a second session
3. Send a different message (e.g. "Hello session B")
4. Open the session dropdown and switch back to the first session

**Expected:**
- Messages from session A are loaded (shows "Hello session A")
- Messages from session B are not visible
- Switching back to session B shows "Hello session B"

### SESS-05: Copy Session ID Copies Full ID to Clipboard

**Steps:**
1. Navigate to a project with an active session
2. Click the clipboard icon (📋) next to the session ID

**Expected:**
- Button text briefly changes to "Copied!" for ~1.5 seconds
- Full session UUID is copied to clipboard (not just the truncated 8-char version)
- Button reverts to clipboard icon after timeout

### SESS-06: Debug Button Opens Debug Panel

**Steps:**
1. Navigate to a project with an active session
2. Click the bug icon (🐛) button next to "New Session"

**Expected:**
- Dark overlay appears covering the main content
- Debug panel slides in from the right (480px wide)
- Panel header shows "Session Debug" and truncated session ID
- "Copy All" button visible in header
- Close button (×) visible in header

### SESS-07: Debug Panel Shows Session, Messages, Tasks, Audit Sections

**Steps:**
1. Open the debug panel for a session that has some messages/tasks
2. Examine the panel content

**Expected:**
- 4 collapsible sections: Session, Messages, Tasks, Audit
- Each section shows a count badge
- Session section is expanded by default
- Other sections are collapsed by default
- Clicking a section header toggles its content
- Content is pre-formatted JSON

### SESS-08: Debug Panel Copy Buttons Work

**Steps:**
1. Open the debug panel
2. Click the "Copy" button on individual sections
3. Click the "Copy All" button in the header

**Expected:**
- Section copy: copies that section's JSON to clipboard
- Copy All: copies the entire debug data to clipboard
- Brief "Copied!" feedback on section copy buttons

### SESS-09: New Session Archives Previous Active Sessions

**Steps:**
1. Navigate to a project with an active session
2. Note the current session's status in the dropdown
3. Click "New Session"
4. Open the dropdown again

**Expected:**
- New session is now the first item and is active
- Previous session still appears in the list
- Session list is ordered by most recent first

### SESS-10: Empty Project Shows "No Session" in Selector

**Steps:**
1. Create a new project
2. Navigate to the project page before any session is created
3. Observe the session selector

**Expected:**
- Selector shows "No session" text
- Dropdown shows "No sessions yet" when opened
- "New Session" button is visible and functional
- Debug button is disabled (no session to debug)
- Copy ID button is not visible (no session)
