# 07 - Cross-Cutting Concerns and Data Verification

Verify data consistency between pages and error handling.

Prerequisites: Smoke tests (01) passing, at least one project exists, backend running with skills and schedules

## Test Cases — Data Consistency

### DATA-01: Skills count consistent across pages

**Steps:**
1. navigate: `http://localhost:4000/skills` → snapshot → count skill cards
2. navigate: `http://localhost:4000` → snapshot → read "Skills" status card value
3. navigate: `http://localhost:4000/settings` → snapshot → read "Loaded Skills" list
4. assert: all three locations show the same skill count

### DATA-02: Projects count consistent

**Steps:**
1. navigate: `http://localhost:4000/projects` → snapshot → count project cards
2. navigate: `http://localhost:4000` → snapshot → read "Projects" status card value
3. assert: counts match

### DATA-03: Schedules count consistent

**Steps:**
1. navigate: `http://localhost:4000/schedules` → snapshot → count schedule cards
2. navigate: `http://localhost:4000` → snapshot → read "Schedules" status card value
3. assert: counts match

### DATA-04: Project creation updates all views

**Steps:**
1. navigate: `http://localhost:4000` → snapshot → note Projects count
2. navigate: `http://localhost:4000/projects`
3. click: button "New Project"
4. type: textbox "Project name" ← "Consistency Test"
5. click: button "Create"
6. wait: 2s → snapshot → assert: text "Consistency Test"
7. navigate: `http://localhost:4000` → wait: 10s
8. snapshot → assert: Projects count incremented

## Test Cases — Error Handling

### ERR-01: Backend unavailable — dashboard degrades gracefully

**Steps:**
1. navigate: `http://localhost:4000` (with backend running) → snapshot → assert: text "Online"
2. stop backend server
3. wait: 10s
4. snapshot → assert:
   - text "Offline"
   - link "Projects" (sidebar still works)
   - NOT text "Unhandled" or error overlay

### ERR-02: Backend unavailable — other pages handle errors

**Steps:**
1. stop backend server
2. navigate: `http://localhost:4000/projects` → snapshot → assert: no crash, page renders
3. navigate: `http://localhost:4000/activity` → snapshot → assert: no crash, page renders
4. navigate: `http://localhost:4000/skills` → snapshot → assert: no crash, page renders
5. check: console_messages → NOT "TypeError", NOT "Unhandled"

**Notes:** Pages may show empty state or loading state — that's acceptable. Sidebar navigation must continue working.

### ERR-03: Invalid project ID

**Steps:**
1. navigate: `http://localhost:4000/projects/this-id-does-not-exist`
2. snapshot → assert:
   - text "Loading project..." (stays in loading state)
   - NOT text "Unhandled"
3. check: console_messages → NOT "TypeError"
