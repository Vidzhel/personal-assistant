# 08 - Integration Flows

End-to-end scenarios exercising the full stack: project creation, chat, agent tasks, and dashboard reflection.

Prerequisites: Both servers running (`npm run dev`), backend healthy (`curl http://localhost:4001/api/health`)

## Test Cases

### INT-01: Create test project and verify

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. snapshot → note current project count
3. click: button "New Project"
4. type: textbox "Project name" ← "Integration Test"
5. click: first skill button (if available)
6. click: button "Create"
7. wait: 2s
8. snapshot → assert:
   - text "Integration Test"

### INT-02: Send chat message and verify user bubble

**Steps:**
1. click: project card "Integration Test" → wait: 1s
2. snapshot → assert: textbox "Ask Raven..."
3. type: textbox "Ask Raven..." ← "List my tasks"
4. press: Enter (submit: true)
5. wait: 2s
6. snapshot → assert:
   - text "List my tasks" (user message visible)
   - textbox "Ask Raven..." is empty (input cleared)

### INT-03: Verify agent task spawns in activity

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. wait: 3s
3. snapshot → assert:
   - at least 1 event entry visible
   - text matching event type (e.g., "agent:task:request" or "user:chat:message")

### INT-04: Verify agent response

**Steps:**
1. navigate back to "Integration Test" project chat
2. wait: 30s (check snapshot every 5s)
3. snapshot → assert:
   - text "List my tasks" (user message still visible)
   - at least 2 message elements (user + assistant response)
   - OR text indicating error/no credentials (acceptable)

**Notes:** Chat should not remain in a permanent loading state.

### INT-05: Dashboard reflects new project

**Steps:**
1. navigate: `http://localhost:4000`
2. wait: 10s (for health poll)
3. snapshot → assert:
   - text "Projects" with count >= 1

### INT-06: Activity page shows chat events

**Steps:**
1. navigate: `http://localhost:4000/activity`
2. snapshot → assert:
   - text "user:chat:message" (from INT-02)
   - events ordered newest first

### INT-07: Console error check

**Steps:**
1. check: console_messages after all previous tests

**Expected:**
- NOT "TypeError"
- NOT "ReferenceError"
- NOT "Unhandled"
- Warnings and network errors to external APIs are acceptable

### INT-08: Health endpoint accuracy

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - text "Online"
   - text "Skills" with count > 0
