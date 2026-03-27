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

## Test Cases — Session Naming (Story 10.8, AC: 1, 9)

### SESS-11: Session auto-generates name from first message

**Steps:**
1. navigate to a project → create new session
2. send: "Help me plan the quarterly review presentation"
3. wait: for response
4. check session list → assert:
   - session name shows something derived from the first message (e.g., "Help me plan the quarterly review...")
   - name is truncated at word boundary (~60 chars) with "..." if needed

### SESS-12: Inline-edit session name

**Steps:**
1. navigate to a project → Sessions tab
2. click: session name text in the session info bar
3. snapshot → assert: name becomes editable (input field)
4. type: "Q1 Review Planning" → press Enter
5. wait: 1s → assert: name updated to "Q1 Review Planning"
6. refresh page → assert: name persists

### SESS-13: New session starts with no name

**Steps:**
1. create a new session
2. assert: session has no name (shows truncated ID as fallback)
3. send first message → assert: auto-generated name appears after first turn

## Test Cases — Session Description (Story 10.8, AC: 2)

### SESS-14: Add session description

**Steps:**
1. navigate to a session in the Sessions tab
2. find description field (placeholder: "Add description..." or similar)
3. click → type: "Planning session for Q1 quarterly review deck"
4. blur or press Enter
5. wait: 1s → assert: description saved
6. check session list → assert: description shown as subtitle

### SESS-15: Edit session description

**Steps:**
1. navigate to a session that already has a description
2. click the description → edit → save
3. assert: updated description persisted

## Test Cases — Session Pinning (Story 10.8, AC: 3)

### SESS-16: Pin a session

**Steps:**
1. navigate to a project → Sessions tab (or Overview tab)
2. click: pin toggle on a session (pushpin icon)
3. wait: 1s → assert:
   - pin icon shows filled/active state
   - session moves to top of list

### SESS-17: Unpin a session

**Steps:**
1. click: pin toggle on a pinned session
2. assert:
   - pin icon returns to unfilled/inactive state
   - session re-sorts by recency (no longer pinned at top)

### SESS-18: Pinned sessions persist across page loads

**Steps:**
1. pin a session (SESS-16)
2. refresh the page
3. assert: session still pinned and at top of list

### SESS-19: Pin via API

**Steps:**
1. curl:
   ```bash
   curl -X PATCH http://localhost:4001/api/sessions/{id} \
     -H "Content-Type: application/json" \
     -d '{"pinned": true}'
   ```
2. assert response: `pinned` = true
3. curl: `GET http://localhost:4001/api/projects/{projectId}/sessions`
4. assert: pinned session appears first in list

## Test Cases — Session Cross-References (Story 10.8, AC: 5, 6, 7, 8)

### SESS-20: Create cross-reference via API

**Steps:**
1. get two session IDs for the same project
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/sessions/{sourceId}/cross-references \
     -H "Content-Type: application/json" \
     -d '{"targetSessionId": "{targetId}", "context": "Related discussion from last week"}'
   ```
3. assert response:
   - status 200 or 201
   - reference has: `id`, `sourceSessionId`, `targetSessionId`, `context`, `createdAt`

### SESS-21: List cross-references

**Steps:**
1. after creating references (SESS-20)
2. curl: `GET http://localhost:4001/api/sessions/{sourceId}/cross-references`
3. assert response:
   - `from` array contains outgoing references
   - `to` array contains incoming references
   - each entry has session name, context, clickable target

### SESS-22: Cross-references panel in UI

**Steps:**
1. navigate to a session with cross-references
2. click: "Links" button in session info bar
3. snapshot → assert:
   - panel opens showing "References" (outgoing) and "Referenced By" (incoming)
   - each entry shows: session name, context text
   - entries are clickable to navigate to referenced session

### SESS-23: Link session from panel

**Steps:**
1. open cross-references panel (SESS-22)
2. click: "Link Session" action
3. snapshot → assert:
   - dropdown/picker of project sessions (excluding current)
4. select a target session, add optional context text
5. click: confirm
6. assert: new reference appears in panel

### SESS-24: Delete cross-reference

**Steps:**
1. curl: `DELETE http://localhost:4001/api/sessions/{sessionId}/cross-references/{refId}`
2. assert: status 204
3. curl: `GET http://localhost:4001/api/sessions/{sessionId}/cross-references`
4. assert: deleted reference no longer appears

### SESS-25: Cross-references injected into agent prompt

**Steps:**
1. create cross-references between sessions (SESS-20)
2. start a new turn in the source session (send a message)
3. check agent task debug/logs → assert:
   - prompt includes "Related Sessions" context block
   - referenced session's name and summary included in the block

### SESS-26: Session search by name and description

**Steps:**
1. navigate to project Sessions tab
2. type in search bar: part of a session name
3. assert: sessions filtered to match the name search
4. clear and search by description keywords
5. assert: sessions filtered by description content
