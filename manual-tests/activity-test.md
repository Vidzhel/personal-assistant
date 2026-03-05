# Activity Log Test Checklist

Manual test checklist for the Activity page (`/activity`).

## Prerequisites

- [ ] Frontend dev server running on `http://localhost:3000`
- [ ] API backend running on `http://localhost:3001`
- [ ] Events exist in the database
- [ ] Navigate to `/activity`

## Page Load

- [ ] Activity page renders with a list/table of events
- [ ] Event entries show relevant details: timestamp, type, source, description
- [ ] Entries are sorted by date (newest first) by default

## Filtering

### Event Type Filter
- [ ] Event type filter is visible
- [ ] Can select an event type (e.g., chat, skill_execution, schedule)
- [ ] List updates to show only matching events
- [ ] Clearing the filter restores all events

### Source Filter
- [ ] Source/skill filter is visible
- [ ] Can select a source (e.g., telegram, gmail, ticktick, digest)
- [ ] List updates to show only events from selected source
- [ ] Clearing the filter restores all events

### Combined Filters
- [ ] Multiple filters can be applied simultaneously
- [ ] Results correctly narrow with each additional filter
- [ ] Clearing all filters restores the full list

## Event Details

- [ ] Click on an event entry
- [ ] Detail view opens with full event information
- [ ] All fields display correctly (timestamp, type, source, payload)
- [ ] Can close the detail view and return to the list

## Real-Time Updates

- [ ] With backend running, trigger an event (e.g., send a chat message)
- [ ] New event appears in the activity log without page refresh (WebSocket)

## Result

| Field | Value |
|-------|-------|
| Date | |
| Tester | |
| Overall | PASS / FAIL |
| Notes | |
