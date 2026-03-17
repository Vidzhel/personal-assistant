# Story 6.8: Knowledge Context UI & Project Memory

Status: backlog

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want the web dashboard to display knowledge references injected during conversations and allow me to edit project-level memory,
so that I can see what knowledge informed each response and persist instructions/context for all conversations in a project.

## Acceptance Criteria

1. **Reference panel**: Session chat view has a toggleable right-side panel showing all knowledge bubbles injected during the session, grouped by task, with title/score/tags/preview.

2. **Clickable references**: Clicking a reference expands to show full bubble content preview, tags, domains, permanence. A "View Full" link opens the knowledge bubble detail (future: in knowledge graph view).

3. **External references**: URLs and markdown links extracted from assistant messages are shown in a separate "External References" section in the reference panel.

4. **Project memory editor**: Each project has an editable "Project Memory" section — a textarea for `systemPrompt` that persists instructions/context for all conversations in that project.

5. **Project memory visibility**: The project memory preview (first line, ~80 chars) is always visible in the project header; full editor opens on click.

6. **Real-time updates**: When a new agent task injects knowledge context, the reference panel updates automatically via WebSocket events.

## Dependencies

- **Story 6.5 must be completed first** — provides:
  - `GET /sessions/:id/references` API endpoint
  - `role: 'context'` messages in session transcript
  - `KnowledgeReference` type in `@raven/shared`
- **`PUT /api/projects/:id` route path bug** — currently missing the `/` before `:id` (`/api/projects:id`). Must be fixed before project memory can save.

## Tasks / Subtasks

- [ ] Task 1: Fix projects API route path bug
  - [ ] 1.1 In `packages/core/src/api/routes/projects.ts`: fix `PUT /api/projects:id` → `PUT /api/projects/:id`
  - [ ] 1.2 Verify existing tests still pass after fix

- [ ] Task 2: References panel component (AC: #1, #2, #3)
  - [ ] 2.1 Create `packages/web/src/components/session/ReferencesPanel.tsx` — right-side slide panel (same pattern as `SessionDebugPanel`)
  - [ ] 2.2 Panel width: ~400px, right-side, overlaid
  - [ ] 2.3 "Knowledge Context" section: grouped by task, each ref shows title, score badge (color-coded), tags, truncated preview (~200 chars)
  - [ ] 2.4 Click-to-expand: full bubble content preview, tags, domains, permanence level
  - [ ] 2.5 "View Full" link placeholder (will link to knowledge graph view in future story 6.7/9.2)
  - [ ] 2.6 "External References" section: URLs extracted from assistant messages, deduplicated, with domain labels

- [ ] Task 3: useReferences hook (AC: #1, #3, #6)
  - [ ] 3.1 Create `packages/web/src/hooks/useReferences.ts`
  - [ ] 3.2 Fetch `GET /api/sessions/:id/references` for knowledge refs
  - [ ] 3.3 Extract URLs from assistant messages (regex for http/https URLs and markdown links)
  - [ ] 3.4 Deduplicate URLs, label by domain
  - [ ] 3.5 Listen for WebSocket `agent:message` events with `role: 'context'` to append new refs in real-time

- [ ] Task 4: Reference panel integration (AC: #1, #6)
  - [ ] 4.1 In `app/projects/[id]/page.tsx`: add toggle button (book icon) in session bar next to debug button
  - [ ] 4.2 Render `ReferencesPanel` conditionally based on toggle state
  - [ ] 4.3 Wire up `useReferences` hook with current session ID

- [ ] Task 5: Project memory editor component (AC: #4, #5)
  - [ ] 5.1 Create `packages/web/src/components/project/ProjectMemory.tsx`
  - [ ] 5.2 Collapsed state: show first ~80 chars of `systemPrompt` as gray preview text, pencil icon to expand
  - [ ] 5.3 Expanded state: textarea with "Save" button
  - [ ] 5.4 Save calls `PUT /api/projects/:id` with `{ systemPrompt: value }`
  - [ ] 5.5 Optimistic UI: update local state immediately, revert on error

- [ ] Task 6: Project memory integration (AC: #4, #5)
  - [ ] 6.1 In `app/projects/[id]/page.tsx`: add collapsible `ProjectMemory` section below project name, above session bar
  - [ ] 6.2 Pass current project's `systemPrompt` to `ProjectMemory` component

- [ ] Task 7: API client additions
  - [ ] 7.1 In `packages/web/src/lib/api-client.ts`: add `getSessionReferences(sessionId: string)` method
  - [ ] 7.2 Verify `updateProject()` method works correctly with fixed route path

- [ ] Task 8: Tests
  - [ ] 8.1 Test `useReferences` hook: mock API response, verify knowledge refs parsed and grouped correctly
  - [ ] 8.2 Test `useReferences` URL extraction: verify URLs extracted from assistant messages, deduplicated
  - [ ] 8.3 Test `ReferencesPanel` render: verify knowledge refs displayed with title/score/tags, external refs section
  - [ ] 8.4 Test `ProjectMemory` component: collapsed preview, expanded editor, save behavior
  - [ ] 8.5 Test real-time updates: mock WebSocket event, verify new refs appended to panel

## Dev Notes

### Reference Panel Design

Follow the same overlay pattern as `SessionDebugPanel`:
- Toggle button in the session toolbar bar (book/library icon)
- Slides in from right, ~400px width
- Semi-transparent backdrop or no backdrop (match existing debug panel behavior)
- Close on X button or toggle button

**Knowledge Context section:**
```
┌─────────────────────────────────────┐
│ 📚 Knowledge References        [X] │
│─────────────────────────────────────│
│ Task: "Help draft email to..."      │
│  ┌─────────────────────────────────┐│
│  │ ● Project Alpha Overview  0.87  ││
│  │   #projects #planning           ││
│  │   Project Alpha is a...         ││
│  └─────────────────────────────────┘│
│  ┌─────────────────────────────────┐│
│  │ ● Email Style Guide       0.72  ││
│  │   #communication #writing       ││
│  │   When drafting professio...    ││
│  └─────────────────────────────────┘│
│─────────────────────────────────────│
│ 🔗 External References             │
│  • docs.example.com - API docs     │
│  • github.com/org/repo - Source    │
└─────────────────────────────────────┘
```

**Score badge color coding:**
- >= 0.8: green (high relevance)
- >= 0.5: yellow (moderate)
- < 0.5: gray (low)

### Project Memory Design

Collapsible section in project page header:

```
┌─────────────────────────────────────────┐
│ Project Alpha                       [⚙] │
│ ✏️ Always respond in a professional...  │  ← collapsed (first ~80 chars, gray)
│─────────────────────────────────────────│
│ [Session selector] [🐛] [📚]           │
```

Expanded:
```
┌─────────────────────────────────────────┐
│ Project Alpha                       [⚙] │
│ ┌─────────────────────────────────────┐ │
│ │ Always respond in a professional    │ │
│ │ tone. Key contacts:                 │ │
│ │ - John (eng lead)                   │ │
│ │ - Sarah (PM)                        │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                              [Save] [✕] │
│─────────────────────────────────────────│
```

### URL Extraction from Assistant Messages

Simple regex-based extraction in the `useReferences` hook:

```typescript
// Extract URLs from assistant message content
const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

function extractUrls(messages: Message[]): ExternalRef[] {
  const urls = new Map<string, ExternalRef>();
  for (const msg of messages.filter(m => m.role === 'assistant')) {
    // Extract markdown links first (preserve label)
    for (const match of msg.content.matchAll(MARKDOWN_LINK_REGEX)) {
      urls.set(match[2], { url: match[2], label: match[1], domain: new URL(match[2]).hostname });
    }
    // Extract plain URLs
    for (const match of msg.content.matchAll(URL_REGEX)) {
      if (!urls.has(match[0])) {
        urls.set(match[0], { url: match[0], label: null, domain: new URL(match[0]).hostname });
      }
    }
  }
  return [...urls.values()];
}
```

### WebSocket Real-Time Updates

Listen for `agent:message` events where `messageType === 'context'`:

```typescript
// In useReferences hook
useEffect(() => {
  if (!ws) return;
  const handler = (event: WsEvent) => {
    if (event.type === 'agent:message' && event.payload.role === 'context') {
      // Parse new references from event payload
      // Append to existing references state
    }
  };
  ws.addEventListener('message', handler);
  return () => ws.removeEventListener('message', handler);
}, [ws]);
```

### Existing Code to Reuse

| What | Where | How |
|------|-------|-----|
| `SessionDebugPanel` | `components/session/SessionDebugPanel.tsx` | Copy overlay/slide pattern for ReferencesPanel |
| `useChat` hook | `hooks/useChat.ts` | Reference for WebSocket event pattern |
| `api-client.ts` | `lib/api-client.ts` | Add `getSessionReferences()` method |
| `useProjects` / project fetching | `hooks/useProjects.ts` | Project data with `systemPrompt` field |
| WebSocket connection | Already established in chat view | Reuse for real-time ref updates |

### What NOT to Build

- No knowledge graph visualization — that's story 6.7/9.2
- No bubble editing from the reference panel — view-only (management goes through knowledge agent chat)
- No search/filter within the reference panel — keep it simple, just show what was injected
- No auto-save for project memory — explicit Save button only (avoid accidental saves)
- No markdown preview for project memory — just a textarea
- No reference panel for non-session contexts (e.g., pipeline runs) — session-only for now

### File Structure

```
packages/web/src/
├── components/
│   ├── session/
│   │   └── ReferencesPanel.tsx    # NEW — knowledge + external refs overlay panel
│   └── project/
│       └── ProjectMemory.tsx      # NEW — collapsible project memory textarea editor
├── hooks/
│   └── useReferences.ts           # NEW — fetches refs from API, extracts URLs, listens to WS
├── lib/
│   └── api-client.ts              # MODIFY — add getSessionReferences()
├── app/projects/[id]/
│   └── page.tsx                   # MODIFY — add reference panel toggle + ProjectMemory section
```

### References

- [Source: Story 6.5 — provides `GET /sessions/:id/references` endpoint and `role: 'context'` messages]
- [Source: `packages/web/src/components/session/SessionDebugPanel.tsx` — overlay panel pattern to follow]
- [Source: `packages/web/src/hooks/useChat.ts` — WebSocket event handling pattern]
- [Source: `packages/core/src/api/routes/projects.ts` — PUT route with path bug to fix]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
