# 06 - Skills, Schedules, and Settings Pages

Verify the three informational pages.

Prerequisites: Smoke tests (01) passing, backend running with skills loaded and schedules configured

## Test Cases — Skills Page

### SKL-01: Skills page header

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - heading "Skills"
   - text "Active integrations and their capabilities."

### SKL-02: Skill cards content

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - at least 1 skill card visible
   - each card shows: skill display name
   - each card shows: version text (e.g., "v1.0.0")
   - each card shows: description text
   - each card shows: capability badges (text labels)

### SKL-03: Skill cards show MCP/Agent info

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - text "MCP:" on cards that have MCP servers
   - text "Agents:" on cards that have agent definitions

**Notes:** MCP/Agent lines only appear when the arrays are non-empty.

### SKL-04: All loaded skills appear

**Steps:**
1. navigate: `http://localhost:4000/skills` → snapshot → count skill cards
2. navigate: `http://localhost:4000` → snapshot → read "Skills" status card value
3. assert: skill card count matches dashboard Skills count

## Test Cases — Schedules Page

### SCH-01: Schedules page header

**Steps:**
1. navigate: `http://localhost:4000/schedules`
2. snapshot → assert:
   - heading "Schedules"
   - text "Recurring tasks and automated jobs."

### SCH-02: Empty state

**Steps:**
1. navigate: `http://localhost:4000/schedules` (when none configured)
2. snapshot → assert:
   - text "No schedules configured."

### SCH-03: Schedule card content

**Steps:**
1. navigate: `http://localhost:4000/schedules` (with schedules)
2. snapshot → assert:
   - schedule name text visible
   - cron expression text visible (e.g., "0 7 * * *")
   - skill name visible
   - status badge: text "Active" or "Disabled"

### SCH-04: Schedule count matches dashboard

**Steps:**
1. navigate: `http://localhost:4000/schedules` → snapshot → count schedule cards
2. navigate: `http://localhost:4000` → snapshot → read "Schedules" status card value
3. assert: counts match

## Test Cases — Settings Page

### SET-01: Settings page header

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. snapshot → assert:
   - heading "Settings"
   - text "System configuration and status."

### SET-02: System Info card

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. snapshot → assert:
   - text "System Info"
   - text "Status" with value text
   - text "Uptime" with time value
   - text "Loaded Skills" with skill names
   - text "API URL" with URL value

### SET-03: Configuration instructions card

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. snapshot → assert:
   - text "Configuration"
   - text "skills.json"
   - text ".env"

### SET-04: Settings does not poll

**Steps:**
1. navigate: `http://localhost:4000/settings`
2. monitor: network_requests for 15 seconds

**Expected:**
- GET `/api/health` fires once on page load
- No repeated polling requests (unlike Dashboard's 10-second interval)
