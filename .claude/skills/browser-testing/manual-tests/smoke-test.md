# Smoke Test Checklist

Manual smoke test for verifying the Raven dashboard is functional after deployment or major changes.

## Prerequisites

- [ ] Frontend dev server running on `http://localhost:3000`
- [ ] API backend running on `http://localhost:3001`

## Dashboard Load

- [ ] Navigate to `http://localhost:3000` — dashboard loads directly (no login)
- [ ] Dashboard content renders (status cards, activity feed, quick actions)
- [ ] No blank page or error banner
- [ ] Sidebar navigation is visible

## Core Navigation

Verify each sidebar link navigates to the correct page and renders content:

- [ ] Dashboard (`/`) — status cards and activity feed
- [ ] Projects (`/projects`) — projects list
- [ ] Activity (`/activity`) — event log with entries
- [ ] Schedules (`/schedules`) — scheduled tasks list
- [ ] Skills (`/skills`) — active integrations
- [ ] Settings (`/settings`) — system info

## Basic Rendering Checks

- [ ] No JavaScript errors visible in console
- [ ] No broken images or missing icons
- [ ] Pages display data (not empty unless DB is empty)
- [ ] Tailwind styles render correctly (no unstyled/broken elements)
- [ ] Responsive layout intact at default viewport (1280x720)

## Result

| Field | Value |
|-------|-------|
| Date | |
| Tester | |
| Environment | localhost |
| Overall | PASS / FAIL |
| Notes | |
