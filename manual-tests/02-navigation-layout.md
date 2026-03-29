# 02 - Navigation & Layout (v2)

Validates sidebar navigation, active states, routing, and responsive design for the v2 dashboard.

Prerequisites: Both servers running

## Test Cases — Sidebar Structure

### NAV-01: Sidebar renders all v2 navigation links

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert sidebar contains:
   - text "RAVEN"
   - link "Dashboard"
   - link "Projects"
   - link "Activity"
   - link "Templates"
   - link "Tasks"
   - link "Agents"
   - link "Skills"
   - link "Schedules"
   - link "Settings"

**Notes:** "Pipelines" link from v1 is removed. "Templates" and "Tasks" replace it. "Agents" and "Skills" are separate from the old combined page.

### NAV-02: Active state highlights current route

**Steps:**
1. navigate: `http://localhost:4000`
2. assert: "Dashboard" link has active styling (highlighted background or font weight)
3. click: link "Projects"
4. wait: 1s
5. assert: "Projects" link has active styling
6. assert: "Dashboard" link does NOT have active styling

### NAV-03: Active state persists on sub-routes

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. assert: "Projects" link has active styling
3. click: any project card (or navigate to `/projects/{id}`)
4. wait: 1s
5. assert: "Projects" link still has active styling (sub-route keeps parent active)

### NAV-04: Client-side navigation (no full page reload)

**Steps:**
1. navigate: `http://localhost:4000`
2. click: link "Projects"
3. assert: URL changed to `/projects` without full page reload (check: no browser loading indicator)
4. click: link "Templates"
5. assert: URL changed to `/templates` without full reload

## Test Cases — Responsive Layout

### NAV-05: Desktop layout (1280px+)

**Steps:**
1. navigate: `http://localhost:4000`
2. set viewport: 1280×800
3. snapshot → assert:
   - sidebar is visible and expanded
   - main content area has generous width
   - cards display in multi-column grid

### NAV-06: Tablet layout (768-1279px)

**Steps:**
1. set viewport: 768×1024
2. navigate: `http://localhost:4000`
3. snapshot → assert:
   - sidebar collapses or shows icons only
   - main content fills available width
   - cards stack into fewer columns

### NAV-07: Mobile layout (<768px)

**Steps:**
1. set viewport: 375×812
2. navigate: `http://localhost:4000`
3. snapshot → assert:
   - sidebar is hidden (hamburger menu or similar toggle)
   - content is single column
   - no horizontal scrollbar
