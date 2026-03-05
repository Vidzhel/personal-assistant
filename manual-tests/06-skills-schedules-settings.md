# 06 - Skills, Schedules, and Settings Pages

Verify the three read-only informational pages.

## Prerequisites

- Smoke tests (01) passing
- Backend running with skills loaded and schedules configured

## Playwright MCP Tools Used

- `browser_snapshot` — inspect card content
- `browser_take_screenshot` — visual verification

## Test Cases — Skills Page

### SKL-01: Skills Page Header

**Steps:**
1. Navigate to `/skills`
2. Take a snapshot

**Expected:**
- "Skills" heading in large bold text
- Subtitle: "Active integrations and their capabilities." in muted text

### SKL-02: Skill Cards Layout

**Steps:**
1. Inspect the skill card grid at full width

**Expected:**
- Cards in a 2-column grid (at 768px+ viewport)
- Each card: background #141414, border #262626, rounded corners, padding

### SKL-03: Skill Card Content

**Steps:**
1. Inspect each skill card individually

**Expected per card:**
- Top row: Skill display name (semibold text) on left, version prefixed with "v" (e.g., "v1.0.0") in small muted text on right
- Description paragraph below in small muted text
- Capability badges: row of small chips with dark background (#1a1a1a), muted text (e.g., "task-management", "email-search")
- If skill has MCP servers: line reading "MCP: server-name-1, server-name-2" in extra-small muted text
- If skill has agent definitions: line reading "Agents: agent-1, agent-2" in extra-small muted text
- Lines for MCP/Agents are ONLY shown when the arrays are non-empty

### SKL-04: All Loaded Skills Appear

**Steps:**
1. Navigate to `/skills`
2. Count the skill cards
3. Compare with the "Skills" count on the Dashboard status card

**Expected:**
- The number of skill cards matches the Dashboard's Skills count
- Common skills to expect: TickTick, Gmail, Digest, Telegram (if all are loaded)
- Each skill card shows unique name, version, and capabilities

## Test Cases — Schedules Page

### SCH-01: Schedules Page Header

**Steps:**
1. Navigate to `/schedules`
2. Take a snapshot

**Expected:**
- "Schedules" heading in large bold text
- Subtitle: "Recurring tasks and automated jobs." in muted text

### SCH-02: Empty State

**Steps:**
1. Navigate to `/schedules` when no schedules exist

**Expected:**
- Message: "No schedules configured." in muted text
- No schedule cards visible

### SCH-03: Schedule Card Content

**Steps:**
1. With schedules configured, inspect each schedule card

**Expected per card:**
- Full-width card with content on left and status badge on right
- Left side:
  - Schedule name in semibold text
  - Below: cron expression in monospace font (e.g., `0 7 * * *`), middle dot, skill name, middle dot, timezone — in extra-small muted text
- Right side — status badge:
  - Enabled: text "Active" in green (#22c55e) on light green tinted background
  - Disabled: text "Disabled" in red (#ef4444) on light red tinted background

### SCH-04: Schedule Count Matches Dashboard

**Steps:**
1. Note the number of schedule cards on `/schedules`
2. Navigate to Dashboard and check the "Schedules" status card count

**Expected:**
- The count matches between the Schedules page card count and the Dashboard status card

## Test Cases — Settings Page

### SET-01: Settings Page Header

**Steps:**
1. Navigate to `/settings`
2. Take a snapshot

**Expected:**
- "Settings" heading in large bold text
- Subtitle: "System configuration and status." in muted text

### SET-02: System Info Card

**Steps:**
1. Inspect the "System Info" card

**Expected:**
- Card with background #141414, border, "System Info" heading
- 2-column grid with 4 data fields:
  1. "Status" label → value colored green (#22c55e) if healthy (shows raw status like "ok")
  2. "Uptime" label → formatted as "Xm Ys" (e.g., "45m 12s")
  3. "Loaded Skills" label → comma-separated skill names (e.g., "ticktick, gmail, digest, telegram")
  4. "API URL" label → URL in monospace small text (typically "http://localhost:3001/api")

### SET-03: Uptime Format Validation

**Steps:**
1. Note the uptime displayed on Settings page
2. Navigate to Dashboard, then back to Settings a minute later

**Expected:**
- Uptime shows in "Xm Ys" format where X is minutes and Y is seconds
- Note: Settings does NOT poll — the uptime is a snapshot from initial page load
- Refreshing the page shows an updated uptime value

### SET-04: Configuration Instructions Card

**Steps:**
1. Inspect the "Configuration" card below System Info

**Expected:**
- Card with background #141414, border
- "Configuration" heading in semibold text
- Two instruction lines mentioning:
  1. `config/skills.json` — the path appears in a `<code>` element with monospace font and dark background (#1a1a1a)
  2. `.env` — same code styling
- These are read-only instructions, not editable fields

### SET-05: Settings Does Not Poll

**Steps:**
1. Navigate to `/settings`
2. Monitor network requests for 15 seconds

**Expected:**
- A `GET /api/health` request fires once when the page loads
- No repeated polling requests (unlike Dashboard's 10-second interval)
- The data on the page is static after initial load

## Results

| Date | Tester | Passed | Total | Notes |
|------|--------|--------|-------|-------|
|      |        |        | 13    |       |
