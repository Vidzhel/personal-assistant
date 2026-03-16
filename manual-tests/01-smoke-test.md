# 01 - Smoke Test

Quick prerequisite validation. Run first before any other tests.

Prerequisites: Both servers running (`npm run dev`), verified via `.claude/skills/browser-testing/scripts/check-devserver.sh`

## Test Cases

### SM-01: Dashboard loads successfully

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - heading "Dashboard"
   - text "Raven Personal Assistant"
   - text "Live Activity"
   - text "Quick Actions"

### SM-02: Sidebar renders with all navigation links

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - link "Dashboard"
   - link "Projects"
   - link "Activity"
   - link "Schedules"
   - link "Skills"
   - link "Settings"
   - text "RAVEN"

### SM-03: All routes load without errors

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert: heading "Dashboard"
3. click: link "Projects" → wait: 1s → snapshot → assert: heading "Projects"
4. click: link "Activity" → wait: 1s → snapshot → assert: heading "Activity Timeline"
5. click: link "Schedules" → wait: 1s → snapshot → assert: heading "Schedules"
6. click: link "Skills" → wait: 1s → snapshot → assert: heading "Skills"
7. click: link "Settings" → wait: 1s → snapshot → assert: heading "Settings"
8. click: link "Dashboard" → wait: 1s → snapshot → assert: heading "Dashboard"

**Notes:** Each navigation should update the URL and change the active sidebar link. No blank screens or error overlays at any step.

### SM-04: No JavaScript console errors

**Steps:**
1. navigate: `http://localhost:4000`
2. navigate through all 6 routes (Dashboard → Projects → Activity → Schedules → Skills → Settings)
3. check: console_messages

**Expected:**
- NOT text "TypeError"
- NOT text "ReferenceError"
- NOT text "Unhandled"
- Warnings are acceptable

### SM-05: API connectivity verified via health status

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - text "Status"
   - text "Online"
   - text "Skills"

**Notes:** If "Offline" appears instead of "Online", backend API is not reachable — fix prerequisites before continuing.
