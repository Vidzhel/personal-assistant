# 09 - Sessions

Verify session lifecycle, selector UI, copy ID, and debug panel functionality.

Prerequisites: Smoke tests (01) and Projects/Chat tests (04) passing, at least one project exists

## Test Cases

### SESS-01: Session selector shows current session info

**Steps:**
1. navigate to `/projects/:id` for an existing project
2. snapshot → assert:
   - text matching truncated session ID (8-char monospace)
   - text showing turn count (e.g., "0 turns")

### SESS-02: Session dropdown lists all sessions

**Steps:**
1. navigate to a project with multiple sessions
2. click: session selector button (dropdown trigger)
3. snapshot → assert:
   - multiple session entries visible
   - each entry shows: truncated ID, turn count

### SESS-03: New session creates and switches

**Steps:**
1. navigate to a project page
2. snapshot → note current session ID
3. click: button "New Session"
4. wait: 2s
5. snapshot → assert:
   - session ID changed (different from noted ID)
   - text "0 turns" (new session)
   - NOT text from previous session's messages (chat area cleared)

### SESS-04: Switching sessions loads correct messages

**Steps:**
1. type: textbox "Ask Raven..." ← "Hello session A"
2. press: Enter → wait: 1s
3. snapshot → assert: text "Hello session A"
4. click: button "New Session" → wait: 2s
5. type: textbox "Ask Raven..." ← "Hello session B"
6. press: Enter → wait: 1s
7. snapshot → assert: text "Hello session B", NOT text "Hello session A"
8. click: session selector → click: first/previous session entry → wait: 1s
9. snapshot → assert: text "Hello session A", NOT text "Hello session B"

### SESS-05: Copy session ID

**Steps:**
1. navigate to a project with an active session
2. click: copy button (clipboard icon next to session ID)
3. wait: 1s
4. snapshot → assert:
   - text "Copied!" (brief feedback)

**Notes:** Full UUID should be copied to clipboard, not the truncated 8-char version.

### SESS-06: Debug button opens debug panel

**Steps:**
1. navigate to a project with an active session
2. click: debug button (bug icon)
3. snapshot → assert:
   - text "Session Debug"
   - button with close label (× or Close)
   - text "Copy All"

### SESS-07: Debug panel shows all sections

**Steps:**
1. open debug panel (SESS-06)
2. snapshot → assert:
   - text "Session"
   - text "Messages"
   - text "Tasks"
   - text "Audit"
   - each section shows count badge

**Notes:** Sections are collapsible. Session section expanded by default, others collapsed.

### SESS-08: Debug panel copy buttons

**Steps:**
1. open debug panel
2. click: "Copy All" button
3. wait: 1s
4. snapshot → assert: text "Copied!" feedback

### SESS-09: New session archives previous

**Steps:**
1. navigate to a project with an active session
2. snapshot → note session ID
3. click: button "New Session" → wait: 2s
4. click: session selector dropdown
5. snapshot → assert:
   - 2+ session entries in dropdown
   - new session listed first (most recent)

### SESS-10: Empty project shows no session

**Steps:**
1. create a new project → navigate to it
2. snapshot → assert:
   - text "No session" OR text indicating no active session
   - button "New Session" visible
