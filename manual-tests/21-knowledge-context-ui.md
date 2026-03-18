# 21 - Knowledge Context UI & Project Memory (Story 6.8)

Verify the references panel showing injected knowledge context, expandable reference cards with score badges, external URL references, and the project memory editor.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), knowledge bubbles exist, at least one project with chat sessions that have triggered context injection

## Test Cases — References Panel

### KCTX-01: References toggle button

**Steps:**
1. navigate to a project chat page (with a session that has knowledge references)
2. snapshot → assert:
   - a button/toggle to open the references panel is visible

### KCTX-02: Open references panel

**Steps:**
1. click: the references panel toggle
2. snapshot → assert:
   - overlay backdrop appears (semi-transparent, `rgba(0,0,0,0.4)`)
   - panel slides in from the right (fixed, 400px width, z-50)
   - header text "Knowledge References" (text-sm font-bold)
   - close button "×" visible in header

### KCTX-03: Close references panel via close button

**Steps:**
1. open references panel
2. click: "×" close button
3. snapshot → assert:
   - panel and overlay removed
   - chat page visible and interactive

### KCTX-04: Close references panel via overlay

**Steps:**
1. open references panel
2. click: the dark overlay area (outside the panel)
3. snapshot → assert:
   - panel and overlay removed

### KCTX-05: Empty references state

**Steps:**
1. navigate to a session with no knowledge context injected
2. open references panel
3. snapshot → assert:
   - text "No knowledge references for this session." (text-sm, muted)

## Test Cases — Reference Cards

### KCTX-06: Reference cards grouped by task

**Steps:**
1. open references panel for a session with multiple agent tasks
2. snapshot → assert:
   - references grouped under task ID headings
   - each group shows "Task: " followed by truncated task ID (12 chars, or "General" for unknown)
   - groups separated by border-bottom

### KCTX-07: Reference card display

**Steps:**
1. open references panel with references
2. snapshot → assert:
   - each reference card shows:
     - bubble title (text-sm font-medium)
     - score badge (text-xs, font-mono, colored background, white text)
     - snippet text (text-xs, muted color, truncated to ~200 chars)
   - cards are clickable (cursor-pointer, rounded-lg, bg-hover)

### KCTX-08: Score badge colors

**Steps:**
1. open references panel with references of varying scores
2. snapshot → assert:
   - score >= 0.80: green badge (`#22c55e` background)
   - score >= 0.50 and < 0.80: yellow badge (`#eab308` background)
   - score < 0.50: gray badge (`#9ca3af` background)
   - score displayed as 2 decimal places (e.g. "0.85")

### KCTX-09: Reference card tags

**Steps:**
1. open references panel with references that have tags
2. snapshot → assert:
   - tag chips displayed below title: "#tagname" format (text-xs, bg-card, muted color)

### KCTX-10: Expand reference card

**Steps:**
1. open references panel
2. click: a reference card
3. snapshot → assert:
   - full snippet text displayed (not truncated)
   - additional metadata visible:
     - domains (e.g. "Domains: work, personal")
     - permanence label ("Robust", "Normal", or "Temporary")
   - "View Full" link visible (accent color)

### KCTX-11: Collapse reference card

**Steps:**
1. expand a reference card (click it)
2. click: the same reference card again
3. snapshot → assert:
   - card collapses back to truncated view
   - metadata and "View Full" link hidden

### KCTX-12: View Full navigates to knowledge graph

**Steps:**
1. expand a reference card
2. click: "View Full" link
3. snapshot → assert:
   - navigates to `/knowledge?bubbleId={id}`
   - knowledge graph page loads with the bubble selected/highlighted

## Test Cases — External References

### KCTX-13: External references section

**Steps:**
1. open references panel for a session where the assistant included URLs in responses
2. scroll down in the panel
3. snapshot → assert:
   - text "External References" section visible (text-xs, font-medium, muted)
   - each external reference shows:
     - domain label (text-xs, muted, e.g. "github.com")
     - link text or URL (truncated, accent color)
   - links open in new tab (`target="_blank"`)

### KCTX-14: External references deduplication

**Steps:**
1. ensure a session has assistant messages that mention the same URL multiple times
2. open references panel → assert:
   - each URL appears only once (deduplicated)
   - markdown link labels preserved (e.g. `[docs](https://...)` shows "docs" as label)

### KCTX-15: No external references

**Steps:**
1. open references panel for a session with no URLs in messages
2. snapshot → assert:
   - "External References" section not shown (no empty placeholder)

## Test Cases — Project Memory Editor

### KCTX-16: Collapsed state with no memory

**Steps:**
1. navigate to a project that has no system prompt set
2. snapshot → assert:
   - project memory trigger visible: italic text "Set project memory..." (text-xs, muted, pencil icon)
   - text is clickable

### KCTX-17: Collapsed state with existing memory

**Steps:**
1. navigate to a project that has a system prompt set
2. snapshot → assert:
   - project memory trigger shows first 80 characters of the prompt followed by "..." (if longer)
   - text-xs, muted color, pencil icon

### KCTX-18: Expand memory editor

**Steps:**
1. click: the collapsed project memory trigger
2. snapshot → assert:
   - textarea appears (w-full, rounded, text-sm, resizable vertically)
   - textarea placeholder: "Add project memory — instructions/context for all conversations..."
   - textarea pre-filled with existing system prompt (or empty)
   - "Save" button (accent background, white text, text-xs)
   - "Cancel" button (muted text, text-xs)

### KCTX-19: Edit and save project memory

**Steps:**
1. expand memory editor
2. type: "Always respond in a formal tone. Prioritize tasks by urgency."
3. click: "Save" button
4. snapshot → assert:
   - editor collapses back to preview
   - preview shows first 80 chars of saved text
5. monitor: network_requests → assert:
   - update project API call sent with `systemPrompt` payload

### KCTX-20: Save shows loading state

**Steps:**
1. expand memory editor
2. type some text
3. click: "Save" button (throttle network to observe)
4. snapshot (during save) → assert:
   - button text changes to "Saving..." (disabled state)

### KCTX-21: Cancel discards changes

**Steps:**
1. expand memory editor
2. type: "Some new text"
3. click: "Cancel" button
4. snapshot → assert:
   - editor collapses
   - preview shows original text (changes discarded)
5. expand again → assert:
   - textarea shows original value (not the discarded text)

### KCTX-22: Save error handling

**Steps:**
1. expand memory editor
2. disconnect backend or simulate API failure
3. type some text and click "Save"
4. snapshot → assert:
   - error text "Failed to save" visible in red (`#ef4444`)
   - editor remains expanded (not collapsed)
   - original value reverted (optimistic update rolled back)

### KCTX-23: Optimistic UI update

**Steps:**
1. expand memory editor
2. type: "New memory content"
3. click: "Save"
4. observe: the parent component immediately reflects the new value (before API response)
5. if API succeeds: value persists
6. if API fails: value reverts to original

## Test Cases — Real-Time Updates

### KCTX-24: References update on new context events

**Steps:**
1. open references panel for an active session
2. trigger a new chat message that causes context injection
3. observe → assert:
   - references panel automatically refreshes with new references
   - no manual reload needed

### KCTX-25: WebSocket context event triggers refresh

**Steps:**
1. open references panel
2. monitor: WebSocket messages for `agent:message` events with `messageType: "context"`
3. trigger a new agent task in the session
4. assert:
   - WebSocket event received
   - references panel refetches data from API
