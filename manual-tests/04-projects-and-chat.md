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
2. click: first project card
3. wait: 1s
4. snapshot → assert:
   - project name visible as heading or text
   - textbox "Ask Raven..." (chat input present)

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
