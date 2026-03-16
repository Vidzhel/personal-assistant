# 02 - Navigation and Layout

Verify sidebar navigation, active states, and routing.

Prerequisites: Smoke tests (01) passing, at least one project exists

## Test Cases

### NAV-01: Sidebar link structure

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - 8 navigation links: Dashboard, Projects, Activity, Pipelines, Tasks, Schedules, Skills, Settings
   - role "navigation" containing all links

### NAV-02: Active state highlights current route

**Steps:**
1. navigate: `http://localhost:4000` → snapshot → assert: link "Dashboard" is current
2. click: link "Projects" → wait: 1s → snapshot → assert: link "Projects" is current
3. click: link "Activity" → wait: 1s → snapshot → assert: link "Activity" is current
4. click: link "Schedules" → wait: 1s → snapshot → assert: link "Schedules" is current
5. click: link "Skills" → wait: 1s → snapshot → assert: link "Skills" is current
6. click: link "Settings" → wait: 1s → snapshot → assert: link "Settings" is current

**Notes:** "is current" means the link has aria-current or a distinguishing attribute in the accessibility tree. Only one link should be active at a time.

### NAV-03: Active state on sub-routes

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: first project card → wait: 1s
3. snapshot → assert:
   - link "Projects" is current
   - NOT link "Dashboard" is current

**Notes:** Sub-route `/projects/:id` should keep "Projects" highlighted.

### NAV-04: Client-side navigation (no full reload)

**Steps:**
1. navigate: `http://localhost:4000`
2. click: link "Projects" → wait: 1s
3. snapshot → assert:
   - heading "Projects"
   - link "Projects" is current

**Notes:** Page should transition without full reload — sidebar stays visible throughout.

### NAV-05: Responsive — status cards grid

**Steps:**
1. navigate: `http://localhost:4000`
2. resize: 1280px width → snapshot → assert: 6 status card texts visible (Status, Skills, Projects, Agents Running, Queue, Schedules)
3. resize: 640px width → snapshot → assert: same 6 status card texts still visible

**Notes:** Layout changes at breakpoints but all cards remain accessible. Visual grid layout can be verified with screenshot if needed.

### NAV-06: Responsive — project cards

**Steps:**
1. navigate: `http://localhost:4000/projects` (need 3+ projects)
2. resize: 1280px width → snapshot → assert: all project names visible
3. resize: 640px width → snapshot → assert: all project names still visible

**Notes:** Cards reflow at breakpoints but content remains accessible.
