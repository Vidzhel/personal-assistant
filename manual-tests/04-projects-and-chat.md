# 04 - Projects and Chat

Verify project listing, project creation form, project detail page, and chat functionality.

## Prerequisites

- Smoke tests (01) passing
- Backend running with at least some skills loaded (for skill selection in creation form)

## Playwright MCP Tools Used

- `browser_type` — type into form inputs
- `browser_click` — click buttons and cards
- `browser_snapshot` — verify DOM changes after actions
- `browser_press_key` — test Enter key to send messages
- `browser_take_screenshot` — visual verification

## Test Cases — Projects List

### PROJ-01: Projects Page Header

**Steps:**
1. Navigate to `/projects`
2. Take a snapshot

**Expected:**
- "Projects" heading in large bold text
- Subtitle: "Each project has its own chat session and skill context." in muted text
- "New Project" button visible, purple background (#6d28d9), white text

### PROJ-02: Empty State (No Projects)

**Steps:**
1. Navigate to `/projects` when no projects exist in the database

**Expected:**
- Message: "No projects yet. Create one to start chatting with Raven." in muted text
- No project cards visible
- "New Project" button still visible and functional

### PROJ-03: Project Cards Display

**Steps:**
1. Navigate to `/projects` with existing projects
2. Take a snapshot and inspect the project cards

**Expected:**
- Cards arranged in a responsive grid
- Each card has: background #141414, border #262626, rounded corners
- Project name in semibold text
- Description in muted text (if the project has a description)
- Skill badges at bottom of card: each badge has dark background (#1a1a1a), purple text (#6d28d9)

### PROJ-04: New Project Form Toggle

**Steps:**
1. Click the "New Project" button
2. Take a snapshot — verify form appears
3. Click "New Project" button again
4. Take a snapshot — verify form disappears

**Expected:**
- First click: an inline creation form appears below the header
- Second click: the form hides (toggle behavior)
- The button remains visible in both states

### PROJ-05: Creation Form Elements

**Steps:**
1. Click "New Project" to open the form
2. Take a snapshot and inspect the form contents

**Expected:**
- Card container with background #141414 and border
- Text input field: placeholder reads "Project name", dark background (#0a0a0a), border (#262626)
- "Skills:" label in muted text
- Row of skill toggle buttons — one button per loaded skill, showing the skill's display name
- All skill buttons initially unselected: dark background (#0a0a0a), muted text
- "Create" button: purple background (#6d28d9), white text

### PROJ-06: Skill Selection Toggle

**Steps:**
1. Open creation form
2. Click one skill button — take snapshot
3. Click the same skill button again — take snapshot
4. Click two different skill buttons — take snapshot

**Expected:**
- Clicking a skill: toggles to selected state — purple background (#6d28d9), white text
- Clicking again: toggles back to unselected — dark background, muted text
- Multiple skills can be selected simultaneously (each toggles independently)

### PROJ-07: Create Project — Happy Path

**Steps:**
1. Open creation form
2. Click on the name input field and type "Test Project"
3. Click one or more skill buttons to select them
4. Click the "Create" button
5. Take a snapshot of the projects list

**Expected:**
- Form closes after clicking Create
- A new project card appears in the grid
- Card shows name "Test Project"
- Card shows badges for the skills that were selected
- The project count on the Dashboard "Projects" card should increase

### PROJ-08: Create Project — Empty Name Blocked

**Steps:**
1. Open creation form
2. Leave the name input empty (or enter only spaces)
3. Click "Create"
4. Take a snapshot

**Expected:**
- Nothing happens — form stays open
- No new project card appears
- No error message shown (the create is silently prevented)

### PROJ-09: Create Project — No Skills Selected

**Steps:**
1. Open creation form
2. Type a project name (e.g., "No Skills Project")
3. Do NOT click any skill buttons
4. Click "Create"
5. Take a snapshot

**Expected:**
- Project is created successfully
- New card appears with the project name
- Card has no skill badges (empty skills array)
- Form closes after creation

### PROJ-10: Project Card Navigation

**Steps:**
1. Click on any project card in the grid

**Expected:**
- Browser navigates to `/projects/[project-id]`
- URL contains a UUID-format project ID
- "Projects" sidebar link stays highlighted
- Project detail page loads (see CHAT tests below)

## Test Cases — Chat

### CHAT-01: Project Detail Header

**Steps:**
1. Navigate to `/projects/[id]` by clicking a project card
2. Take a snapshot of the header area

**Expected:**
- Header bar at top with a bottom border (#262626)
- Project name displayed in bold text
- Skill badges below the name (dark background #1a1a1a, purple text) — if the project has skills
- Header takes minimal vertical space, rest is chat area

### CHAT-02: Non-Existent Project

**Steps:**
1. Navigate directly to `/projects/does-not-exist` (type URL manually or use browser_navigate)
2. Take a snapshot

**Expected:**
- Shows "Loading project..." text in muted color
- Page does not crash or show an error overlay
- No unhandled errors in console

### CHAT-03: Chat Panel — Empty Conversation

**Steps:**
1. Open a project that has never been chatted with
2. Take a snapshot of the chat area

**Expected:**
- Center-aligned placeholder text: "Start a conversation" in larger text
- Below: "Ask Raven to manage tasks, check email, or plan your day." in smaller muted text
- Chat input bar visible and ready at the bottom of the page

### CHAT-04: Chat Input Bar

**Steps:**
1. Take a snapshot of the bottom of the chat panel

**Expected:**
- Input bar has a top border (#262626)
- Contains a text input: placeholder "Ask Raven...", dark background (#1a1a1a), border (#262626)
- "Send" button next to input: purple background (#6d28d9), white text
- Input takes most of the width; Send button is compact

### CHAT-05: Send Message via Button

**Steps:**
1. Click on the chat input field
2. Type "Hello Raven"
3. Click the "Send" button
4. Take a snapshot

**Expected:**
- A message bubble appears on the right side of the chat area
- Bubble has purple background (#6d28d9) with white text
- Message text reads "Hello Raven"
- Input field is cleared after sending
- Bubble has rounded corners and max width about 80% of the chat area

### CHAT-06: Send Message via Enter Key

**Steps:**
1. Click on the chat input field
2. Type "Test enter key"
3. Press the Enter key
4. Take a snapshot

**Expected:**
- Same as CHAT-05: message appears as a right-aligned purple bubble
- Input field clears after pressing Enter
- Note: This is a text input (not textarea), so Enter always sends

### CHAT-07: Empty Message Blocked

**Steps:**
1. With the input field empty, click "Send"
2. With the input field empty, press Enter
3. Take a snapshot

**Expected:**
- No message bubble appears in either case
- Chat area remains unchanged
- Input stays empty and focused

### CHAT-08: User Message Styling

**Steps:**
1. After sending a message, take a screenshot
2. Inspect the user message bubble

**Expected:**
- Message row is right-aligned (pushed to the right side)
- Bubble background: purple (#6d28d9)
- Text color: white
- No border on user messages
- Max width about 80% of container width
- Text preserves whitespace formatting

### CHAT-09: Assistant Message Styling

**Steps:**
1. Send a message that triggers an assistant response (requires backend agent processing)
2. Wait for the response to stream in
3. Take a screenshot

**Expected:**
- Assistant message appears on the left side (pushed to the left)
- Bubble background: card color (#141414)
- Bubble has a border (#262626)
- Text color: default (#e5e5e5)
- Max width about 80% of container width

### CHAT-10: Message Auto-Scroll

**Steps:**
1. Send enough messages to fill the visible chat area (5-10 messages)
2. Send one more message
3. Observe scroll position

**Expected:**
- Chat view automatically scrolls to show the latest message at the bottom
- Previous messages are scrollable upward
- The newest message is always visible without manual scrolling

### CHAT-11: Chat Layout — Full Height

**Steps:**
1. Take a screenshot of the entire project detail page

**Expected:**
- Page fills the full viewport height
- Header is pinned at the top (does not scroll)
- Chat message area fills the remaining vertical space
- Chat input bar is pinned at the bottom
- No double scrollbars — only the message area scrolls

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 21    |       |
