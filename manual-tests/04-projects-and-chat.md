# 04 - Projects and Chat

Verify project listing, creation form, project detail page, and chat functionality.

Prerequisites: Smoke tests (01) passing, backend running with skills loaded

## Test Cases — Projects List

### PROJ-01: Projects page header

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. snapshot → assert:
   - heading "Projects"
   - text "Each project has its own chat session and skill context."
   - button "New Project"

### PROJ-02: Empty state (no projects)

**Steps:**
1. navigate: `http://localhost:4000/projects` (when no projects exist)
2. snapshot → assert:
   - text "No projects yet"
   - button "New Project"

### PROJ-03: Project cards display

**Steps:**
1. navigate: `http://localhost:4000/projects` (with existing projects)
2. snapshot → assert:
   - at least 1 project name visible
   - each project card contains: project name text

### PROJ-04: New Project form toggle

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: button "New Project" → snapshot → assert:
   - textbox "Project name"
   - button "Create"
3. click: button "New Project" → snapshot → assert:
   - NOT textbox "Project name" (form hidden)

### PROJ-05: Creation form elements

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: button "New Project"
3. snapshot → assert:
   - textbox "Project name"
   - text "Skills:"
   - button "Create"
   - 1+ skill toggle buttons (skill names as button labels)

### PROJ-06: Skill selection toggle

**Steps:**
1. open creation form
2. snapshot → find first skill button
3. click: first skill button → snapshot → assert: skill button shows selected state
4. click: same skill button → snapshot → assert: skill button shows unselected state

**Notes:** Selected/unselected state may appear as different aria attributes or text styling in the accessibility tree.

### PROJ-07: Create project — happy path

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: button "New Project"
3. type: textbox "Project name" ← "Test Project"
4. click: first skill button (optional)
5. click: button "Create"
6. wait: 2s
7. snapshot → assert:
   - text "Test Project"
   - NOT textbox "Project name" (form closed)

### PROJ-08: Create project — empty name blocked

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: button "New Project"
3. click: button "Create" (without entering a name)
4. snapshot → assert:
   - textbox "Project name" (form still open)

### PROJ-09: Create project — no skills selected

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: button "New Project"
3. type: textbox "Project name" ← "No Skills Project"
4. click: button "Create" (without selecting any skills)
5. wait: 2s
6. snapshot → assert:
   - text "No Skills Project"

### PROJ-10: Project card navigation

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: first project card link
3. snapshot → assert:
   - heading with project name
   - button "Overview" or tab bar with "Overview" active
   - button "Tasks"
   - button "Knowledge"
   - button "Sessions"
   - button "New Chat"
   - NOT textbox "Ask Raven..." (chat input is on Sessions tab, not Overview)

**Notes:** Project detail page uses a hub/tabbed layout (Story 10.7). Chat is accessible via "New Chat" button or Sessions tab.

## Test Cases — Chat

### CHAT-01: Project detail header

**Steps:**
1. navigate to a project by clicking its card
2. snapshot → assert:
   - project name visible
   - skill badges visible (if project has skills)

### CHAT-02: Non-existent project

**Steps:**
1. navigate: `http://localhost:4000/projects/does-not-exist`
2. snapshot → assert:
   - text "Loading project..." OR text indicating project not found
   - NOT text "Error" (no crash)
3. check: console_messages → NOT "TypeError", NOT "Unhandled"

### CHAT-03: Chat panel — empty conversation

**Steps:**
1. open a project that has never been chatted with
2. snapshot → assert:
   - text "Start a conversation"
   - text "Ask Raven"
   - textbox "Ask Raven..."

### CHAT-04: Chat input bar

**Steps:**
1. navigate to a project
2. snapshot → assert:
   - textbox "Ask Raven..."
   - button "Send"

### CHAT-05: Send message via button

**Steps:**
1. navigate to a project
2. type: textbox "Ask Raven..." ← "Hello Raven"
3. click: button "Send"
4. wait: 1s
5. snapshot → assert:
   - text "Hello Raven" (message bubble)
   - textbox "Ask Raven..." is empty (input cleared)

### CHAT-06: Send message via Enter key

**Steps:**
1. navigate to a project
2. type: textbox "Ask Raven..." ← "Test enter key"
3. press: Enter (submit: true)
4. wait: 1s
5. snapshot → assert:
   - text "Test enter key" (message bubble)
   - textbox "Ask Raven..." is empty

### CHAT-07: Empty message blocked

**Steps:**
1. navigate to a project
2. click: button "Send" (with empty input)
3. snapshot → assert:
   - NOT text matching a new message bubble
   - textbox "Ask Raven..." (input still present and empty)

### CHAT-08: Multiple messages display

**Steps:**
1. send message "First message" via button
2. wait: 1s
3. send message "Second message" via Enter
4. wait: 1s
5. snapshot → assert:
   - text "First message"
   - text "Second message"

**Notes:** Messages should appear in order. Auto-scroll keeps latest message visible.

## Test Cases — Project Hub & Tabbed Layout (Story 10.7)

### HUB-01: Tabbed layout on project detail page

**Steps:**
1. navigate to a project detail page
2. snapshot → assert:
   - tab bar visible with tabs: "Overview", "Tasks", "Knowledge", "Sessions"
   - "Overview" tab is active by default

### HUB-02: Compact project header persists across tabs

**Steps:**
1. navigate to a project detail page
2. snapshot → assert:
   - project name visible in header
   - description visible
   - skill badges visible (if project has skills)
   - "New Chat" button at top-right
3. click: "Tasks" tab
4. snapshot → assert: same header elements still visible
5. click: "Knowledge" tab
6. snapshot → assert: same header elements still visible

### HUB-03: Inline-editable project name

**Steps:**
1. navigate to a project → Overview tab
2. click: project name text
3. snapshot → assert: name becomes editable (input field appears)
4. type new name → press Enter or blur
5. wait: 1s → snapshot → assert:
   - updated name displayed
   - page did not navigate away

### HUB-04: Inline-editable project description

**Steps:**
1. navigate to a project → Overview tab
2. click: project description text
3. snapshot → assert: description becomes editable
4. type new description → blur
5. wait: 1s → assert: updated description persisted

### HUB-05: Overview tab — recent sessions list

**Steps:**
1. navigate to a project with sessions → Overview tab
2. snapshot → assert:
   - "Sessions" section visible
   - sessions listed with: name (or auto-generated summary), turn count, last active timestamp
   - pinned sessions appear first

### HUB-06: Overview tab — quick stats

**Steps:**
1. navigate to a project → Overview tab
2. snapshot → assert:
   - session count visible
   - task counts by status visible (todo, in_progress, completed)

### HUB-07: Overview tab — project memory / instructions editor

**Steps:**
1. navigate to a project → Overview tab
2. snapshot → assert:
   - ProjectMemory / instructions component visible
   - editing is enabled (textarea or editable area)
3. edit instructions → save
4. assert: instructions persisted (refresh page and verify)

### HUB-08: Tasks tab — kanban board scoped to project

**Steps:**
1. navigate to a project → click "Tasks" tab
2. snapshot → assert:
   - kanban board displayed with columns: To Do, In Progress, Completed
   - tasks shown are scoped to this project only (not global tasks)

### HUB-09: Knowledge tab — project-scoped knowledge

**Steps:**
1. navigate to a project → click "Knowledge" tab
2. snapshot → assert:
   - knowledge bubbles linked to this project displayed
   - knowledge is project-scoped (not the full global graph)

### HUB-10: Sessions tab — session list with chat

**Steps:**
1. navigate to a project → click "Sessions" tab
2. snapshot → assert:
   - all sessions listed with search/filter controls
3. click: a session
4. snapshot → assert:
   - chat panel loads with conversation history
   - session selector bar visible for switching
   - NO project memory editor visible (editing only on Overview tab)

### HUB-11: "New Chat" button creates session and switches to Sessions tab

**Steps:**
1. navigate to a project → Overview tab
2. click: "New Chat" button (top-right)
3. wait: 2s
4. snapshot → assert:
   - switched to Sessions tab
   - new session active with chat view
   - chat input visible ("Ask Raven...")

### HUB-12: Tab switching preserves state

**Steps:**
1. navigate to a project → Sessions tab → click a session → type some text
2. click: Overview tab → snapshot → assert: overview content loads
3. click: Sessions tab → snapshot → assert: session still selected, chat input preserved
