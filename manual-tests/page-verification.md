# Page-by-Page Verification Checklist

Comprehensive page verification for all Raven dashboard routes.

## Prerequisites

- [ ] Frontend dev server running on `http://localhost:3000`
- [ ] API backend running on `http://localhost:3001`

---

## Dashboard (`/`)

- [ ] Page loads without errors
- [ ] Status cards render (system health, active skills, recent activity)
- [ ] Activity feed shows recent events
- [ ] Quick action buttons are visible and clickable
- [ ] No broken layout or missing components

## Projects (`/projects`)

- [ ] Projects list renders
- [ ] Each project shows name and summary info
- [ ] Can click a project to open chat view (`/projects/:id`)
- [ ] Back navigation works

## Project Chat (`/projects/:id`)

- [ ] Chat view loads for the selected project
- [ ] Message history displays (if any)
- [ ] Chat input is visible and functional
- [ ] Can type and send a message (if backend is running)
- [ ] Messages appear in the conversation

## Activity (`/activity`)

- [ ] See [journal-test.md](journal-test.md) for detailed activity page testing
- [ ] Activity log renders with event entries
- [ ] Filters are functional

## Schedules (`/schedules`)

- [ ] Scheduled tasks list renders
- [ ] Each schedule shows name, cron expression, and status
- [ ] Schedule entries display next run time
- [ ] Can interact with schedule entries (enable/disable if applicable)

## Skills (`/skills`)

- [ ] Skills page renders with list of integrations
- [ ] Each skill shows name, status (enabled/disabled), and description
- [ ] Skill status indicators are accurate
- [ ] Can interact with skill entries (view details if applicable)

## Settings (`/settings`)

- [ ] Settings page loads
- [ ] System information displays (version, uptime, etc.)
- [ ] Configuration details are visible
- [ ] No errors or broken elements

---

## Cross-Cutting Concerns

- [ ] Sidebar navigation highlights the active page
- [ ] Page titles update correctly on each route
- [ ] Loading states display during data fetching (spinners, skeletons)
- [ ] Error states display meaningful messages (not raw errors)
- [ ] No console errors on any page
- [ ] WebSocket connection established (real-time updates work)

## Result

| Field | Value |
|-------|-------|
| Date | |
| Tester | |
| Pages Verified | /7 |
| Overall | PASS / FAIL |
| Notes | |
