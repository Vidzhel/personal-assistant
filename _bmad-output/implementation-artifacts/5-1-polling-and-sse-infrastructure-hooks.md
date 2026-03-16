# Story 5.1: Polling & SSE Infrastructure Hooks

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the dashboard user,
I want real-time data refresh without page reloads,
So that the dashboard stays current as Raven works.

## Current State (What Already Exists)

The dashboard already has real-time capabilities. Understanding this is critical to avoid reinventing the wheel.

### WebSocket — Already Fully Working
- **Backend**: `packages/core/src/api/ws/handler.ts` registers `/ws`, subscribes to `eventBus.on('*')`, and forwards ALL events to subscribed WebSocket clients
- **Frontend**: `packages/web/src/hooks/useWebSocket.ts` wraps a `WsClient` class with reconnect logic (3s interval), channel subscriptions, and a message buffer
- **Agent streaming via WS**: `packages/web/src/hooks/useChat.ts` already receives `agent:message` and `agent:task:complete` events in real-time via WebSocket. Chat panel shows live agent output (assistant text, tool_use, thinking) — this is fully working today
- **Live ActivityFeed via WS**: `packages/web/src/components/dashboard/ActivityFeed.tsx` subscribes to `global` channel and displays all events in real-time — already working

### Polling — Working but Duplicated
Three pages use identical manual `setInterval` + `fetch` patterns:
- `packages/web/src/app/activity/page.tsx` — polls `api.getEvents()` every 5s
- `packages/web/src/app/processes/page.tsx` — polls `api.getActiveTasks()` every 3s
- `packages/web/src/app/page.tsx` (dashboard) — polls `fetchAll()` (health, projects, skills, schedules) every 10s

Each page duplicates the same boilerplate: `useState` → `useEffect` → `setInterval` → `clearInterval`. No shared hook.

### What Does NOT Exist Yet
- **`usePolling` hook** — no generic polling abstraction; each page duplicates interval logic
- **`useSSE` hook** — no EventSource-based hook exists
- **SSE endpoint** — no `/api/agent-tasks/:id/stream` endpoint exists
- **Dedicated per-task streaming** — currently, to see agent output you must subscribe to a WebSocket channel for the project. There's no way to stream a single task's output in isolation (e.g., from a task detail view or Kanban card without a WS connection)

### Why SSE Is Still Valuable (Not Redundant with WebSocket)
The WebSocket broadcasts ALL events for subscribed channels. SSE provides:
1. **Per-task isolation** — Stream one task's output without subscribing to an entire project channel and filtering client-side
2. **Lightweight** — No bidirectional connection overhead. Standard HTTP that works through proxies/CDNs
3. **Self-contained** — A Kanban card or task detail modal can open an SSE stream without needing the WebSocket infrastructure. Useful for story 5.4 (Kanban board) where clicking a task card should show live output
4. **Auto-reconnect built-in** — `EventSource` handles reconnection natively; WebSocket requires custom retry logic (currently `WsClient` with 3s interval)

## Acceptance Criteria

1. **Polling Hook** — Given a component uses `usePolling('/api/pipelines', 5000)`, When 5 seconds elapse, Then fresh data is fetched and returned, triggering a re-render.

2. **SSE Streaming** — Given a component uses `useSSE('/api/agent-tasks/123/stream')`, When the agent produces output, Then `agent-output` events stream to the client with chunk data in real-time.

3. **SSE Auto-Reconnect** — Given the SSE connection drops, When `EventSource` detects the disconnection, Then it automatically reconnects and resumes streaming.

4. **SSE Clean Close** — Given the agent task completes, When `agent-complete` fires, Then the SSE connection closes cleanly and the hook notifies the component.

## Tasks / Subtasks

- [x] Task 1: Create SSE streaming endpoint on backend (AC: #2, #4)
  - [x] 1.1 Create `packages/core/src/api/sse/stream.ts` exporting `registerSSERoutes(app, deps)` — follows route registration pattern from `server.ts`
  - [x] 1.2 Implement `GET /api/agent-tasks/:id/stream` — SSE endpoint for agent task output streaming
  - [x] 1.3 On request: validate `:id` param, look up task via `deps.executionLogger.getTaskById(id)` — 404 if not found
  - [x] 1.4 Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Use Fastify `reply.raw` for raw HTTP response (Fastify's `reply.send()` won't work for SSE — must write to `reply.raw` directly)
  - [x] 1.5 Subscribe to `eventBus` for `agent:message` events filtered by `payload.taskId === id` — forward as SSE `event: agent-output` with JSON data `{ chunk, taskId, messageType }`
  - [x] 1.6 Subscribe to `eventBus` for `agent:task:complete` filtered by `payload.taskId === id` — send SSE `event: agent-complete` with JSON data `{ taskId, status, result }`, then close the connection
  - [x] 1.7 On client disconnect (req.raw `close` event): unsubscribe from eventBus, clean up. Prevent memory leaks from orphaned listeners
  - [x] 1.8 If task is already completed when request arrives: immediately send `event: agent-complete` and close
  - [x] 1.9 SSE message format must follow the standard: `event: <type>\ndata: <json>\n\n`

- [x] Task 2: Register SSE routes in API server (AC: #2)
  - [x] 2.1 Import and call `registerSSERoutes(app, deps)` in `packages/core/src/api/server.ts` after existing route registrations, before WebSocket
  - [x] 2.2 Pass `{ eventBus, executionLogger, agentManager }` as deps

- [x] Task 3: Create `usePolling` React hook (AC: #1)
  - [x] 3.1 Create `packages/web/src/hooks/usePolling.ts`
  - [x] 3.2 Signature: `usePolling<T>(url: string, intervalMs: number, options?: { enabled?: boolean; onError?: (err: Error) => void }): { data: T | null; loading: boolean; error: Error | null; refresh: () => void }`
  - [x] 3.3 On mount: fetch immediately, then set interval. On unmount: clear interval
  - [x] 3.4 Use the existing `api-client.ts` `request()` pattern — call `fetch()` against `${API_URL}${url}` with the same base URL resolution
  - [x] 3.5 Track `loading` state (true only on first fetch, not on interval refreshes — prevents UI flicker)
  - [x] 3.6 Support `enabled` option (default `true`) to pause/resume polling — when disabled, clear interval and don't fetch
  - [x] 3.7 Memoize interval reset when `url` or `intervalMs` changes (via `useEffect` deps)
  - [x] 3.8 `refresh()` callback for manual re-fetch (e.g., after user action)
  - [x] 3.9 **IMPORTANT**: The hook fetches raw API data and returns it directly. It does NOT write to Zustand. Components can write to Zustand themselves if needed, or use the data directly. This keeps the hook generic and reusable.

- [x] Task 4: Create `useSSE` React hook (AC: #2, #3, #4)
  - [x] 4.1 Create `packages/web/src/hooks/useSSE.ts`
  - [x] 4.2 Signature: `useSSE(url: string | null, options?: { onMessage?: (event: SSEEvent) => void; onComplete?: (event: SSEEvent) => void; onError?: (err: Event) => void }): { connected: boolean; lastEvent: SSEEvent | null; close: () => void }`
  - [x] 4.3 When `url` is non-null: create `new EventSource(fullUrl)` using the same `API_URL` base. When `url` is null: don't connect (allows conditional streaming)
  - [x] 4.4 Listen for named events: `agent-output` → invoke `onMessage`, `agent-complete` → invoke `onComplete` + auto-close, `agent-error` → invoke `onError`
  - [x] 4.5 EventSource has built-in auto-reconnect on connection drop (AC #3) — no custom retry logic needed. Set `connected` state based on `EventSource.readyState`
  - [x] 4.6 On `agent-complete`: close the EventSource (no more data expected), set `connected = false`
  - [x] 4.7 On unmount: close EventSource, remove listeners. Prevent state updates after unmount
  - [x] 4.8 Parse `event.data` as JSON for each message — wrap in try/catch for malformed data

- [x] Task 5: Refactor existing polling pages to use `usePolling` hook (AC: #1)
  - [x] 5.1 Refactor `packages/web/src/app/activity/page.tsx` — replace manual `setInterval` + `api.getEvents()` with `usePolling<EventRecord[]>('/events?limit=100', 5000)`
  - [x] 5.2 Refactor `packages/web/src/app/processes/page.tsx` — replace manual `setInterval` + `api.getActiveTasks()` with `usePolling<ActiveTasks>('/agent-tasks/active', 3000)`
  - [x] 5.3 Refactor dashboard health polling in `packages/web/src/app/page.tsx` — replace manual `setInterval` + `fetchAll()` with `usePolling` for the health endpoint (keep Zustand `fetchAll()` for initial load, use polling for refresh)
  - [x] 5.4 Verify: each refactored page still shows the same data, same refresh interval, same behavior

- [x] Task 6: Tests (AC: all)
  - [x] 6.1 Create `packages/core/src/__tests__/sse.test.ts` — backend SSE tests
  - [x] 6.2 Test: SSE endpoint returns 404 for nonexistent task ID
  - [x] 6.3 Test: SSE endpoint sets correct headers (`text/event-stream`, `no-cache`)
  - [x] 6.4 Test: agent:message events for the correct taskId are forwarded as `event: agent-output`
  - [x] 6.5 Test: agent:message events for a DIFFERENT taskId are NOT forwarded (filter works)
  - [x] 6.6 Test: agent:task:complete event sends `event: agent-complete` and closes the stream
  - [x] 6.7 Test: already-completed task immediately sends `agent-complete` and closes
  - [x] 6.8 Test: client disconnect cleans up eventBus listeners (no memory leak)
  - [x] 6.9 No frontend hook tests needed — hooks are thin wrappers around browser APIs (`EventSource`, `setInterval`). Verify behavior through browser testing in later stories.

## Dev Notes

### Architecture Constraints

- **SSE for unidirectional server→client streaming** — complements existing WebSocket (used for bidirectional chat). Architecture doc specifies: "Clean separation: WebSocket for bidirectional chat, SSE for server-push streams."
- **Native EventSource on client** — zero dependencies, built-in auto-reconnect. Architecture doc: "Native `EventSource` on client."
- **Fastify raw response for SSE** — Fastify's response lifecycle (`reply.send()`) doesn't support streaming. Use `reply.raw` (Node.js `http.ServerResponse`) to write SSE frames directly. Must call `reply.hijack()` first to prevent Fastify from auto-ending the response.
- **No classes** — SSE route handler is a function, hooks are functions.
- **`usePolling` is generic, not Zustand-coupled** — the hook fetches and returns data. Components decide whether to put it in Zustand. This matches the architecture doc: "Shared `usePolling(url, interval)` hook writes to Zustand stores" — but the hook should return data that components can then write to stores, not inject Zustand coupling into the hook itself.

### Existing Infrastructure (DO NOT RECREATE)

| Component | Location | Relevance |
|---|---|---|
| EventBus | `packages/core/src/event-bus/event-bus.ts` | **USE** `on()` / `off()` to subscribe to agent events for SSE forwarding |
| Agent event emission | `packages/core/src/agent-manager/agent-manager.ts:149` | **RELIES ON** — emits `agent:message` with `{ taskId, content, messageType, role }` |
| Agent task complete | `packages/core/src/agent-manager/agent-manager.ts:219` | **RELIES ON** — emits `agent:task:complete` with `{ taskId, status, result, error }` |
| ExecutionLogger | `packages/core/src/agent-manager/execution-logger.ts` | **USE** `getTaskById()` to validate task exists |
| AgentManager | `packages/core/src/agent-manager/agent-manager.ts` | **USE** `getActiveTasks()` for task status check |
| API server | `packages/core/src/api/server.ts` | **EXTEND** — register SSE route alongside existing routes |
| Route registration pattern | `packages/core/src/api/routes/*.ts` | **FOLLOW** — same `registerXxxRoute(app, deps)` pattern |
| WebSocket handler | `packages/core/src/api/ws/handler.ts` | **REFERENCE** — eventBus subscription + cleanup pattern on client disconnect |
| api-client.ts | `packages/web/src/lib/api-client.ts` | **REUSE** `API_URL` constant for hook base URL resolution |
| useWebSocket hook | `packages/web/src/hooks/useWebSocket.ts` | **REFERENCE** — React hook pattern with cleanup |
| Activity page | `packages/web/src/app/activity/page.tsx` | **REFACTOR** — replace manual setInterval with usePolling |
| Processes page | `packages/web/src/app/processes/page.tsx` | **REFACTOR** — replace manual setInterval with usePolling |
| Dashboard page | `packages/web/src/app/page.tsx` | **REFACTOR** — replace manual health polling with usePolling |
| App store (Zustand) | `packages/web/src/stores/app-store.ts` | **REFERENCE** — components may write polling data here |
| HTTP_STATUS | `@raven/shared` | **USE** for error responses |
| createLogger | `@raven/shared` | **USE** for Pino structured logging |

### SSE Backend Architecture

```
Client: new EventSource('/api/agent-tasks/123/stream')
  │
  ▼
Fastify: GET /api/agent-tasks/:id/stream (packages/core/src/api/sse/stream.ts)
  │
  │ 1. Validate task exists via executionLogger.getTaskById(id)
  │    → 404 if not found
  │
  │ 2. Check if task already completed
  │    → If yes: send agent-complete immediately, close
  │
  │ 3. reply.hijack() to take over raw response
  │    Set headers: Content-Type: text/event-stream, Cache-Control: no-cache
  │
  │ 4. Subscribe to eventBus:
  │    - 'agent:message' filtered by taskId → write SSE "event: agent-output\ndata: {...}\n\n"
  │    - 'agent:task:complete' filtered by taskId → write SSE "event: agent-complete\ndata: {...}\n\n" → close
  │
  │ 5. On client disconnect (req.raw 'close'):
  │    - eventBus.off() for both handlers
  │    - Clean up response
  │
  ▼
Client: EventSource receives events via onmessage / addEventListener
```

### SSE Wire Format

```
event: agent-output
data: {"chunk":"The task is","taskId":"123","messageType":"assistant"}

event: agent-output
data: {"chunk":" being processed...","taskId":"123","messageType":"assistant"}

event: agent-complete
data: {"taskId":"123","status":"completed","result":"Task summary here"}

```

Three event types only: `agent-output`, `agent-complete`, `agent-error`. Matches the architecture doc's SSE stream format specification.

### Fastify SSE Implementation Pattern

```typescript
app.get<{ Params: { id: string } }>(
  '/api/agent-tasks/:id/stream',
  async (req, reply) => {
    const task = deps.executionLogger.getTaskById(req.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    // If already completed, send final event immediately
    if (task.status === 'completed' || task.status === 'failed') {
      return reply.status(200).send({
        event: 'agent-complete',
        taskId: task.taskId,
        status: task.status,
      });
    }

    // Hijack response for SSE streaming
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Helper to write SSE frames
    const writeSSE = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Event handlers
    const onMessage = (ev: RavenEvent): void => {
      if (ev.type === 'agent:message' && ev.payload.taskId === req.params.id) {
        writeSSE('agent-output', { chunk: ev.payload.content, taskId: ev.payload.taskId, messageType: ev.payload.messageType });
      }
    };

    const onComplete = (ev: RavenEvent): void => {
      if (ev.type === 'agent:task:complete' && ev.payload.taskId === req.params.id) {
        writeSSE('agent-complete', { taskId: ev.payload.taskId, status: ev.payload.status });
        cleanup();
      }
    };

    const cleanup = (): void => {
      deps.eventBus.off('agent:message', onMessage);
      deps.eventBus.off('agent:task:complete', onComplete);
      raw.end();
    };

    deps.eventBus.on('agent:message', onMessage);
    deps.eventBus.on('agent:task:complete', onComplete);

    // Clean up if client disconnects
    req.raw.on('close', cleanup);
  },
);
```

**IMPORTANT**: Use `reply.hijack()` before writing to `reply.raw`. Without hijack, Fastify will try to send its own response and corrupt the stream. This is Fastify 5's mechanism for SSE/streaming.

### usePolling Hook Design

```typescript
// packages/web/src/hooks/usePolling.ts
'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

export function usePolling<T>(
  url: string,
  intervalMs: number,
  options?: { enabled?: boolean; onError?: (err: Error) => void },
): { data: T | null; loading: boolean; error: Error | null; refresh: () => void } {
  // First fetch → loading: true. Subsequent fetches → no loading flicker.
  // url/intervalMs changes → restart interval.
  // enabled = false → stop polling, keep last data.
  // refresh() → manual immediate fetch.
}
```

### useSSE Hook Design

```typescript
// packages/web/src/hooks/useSSE.ts
'use client';
import { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

export interface SSEEvent {
  event: string;
  data: unknown;
}

export function useSSE(
  url: string | null,
  options?: {
    onMessage?: (event: SSEEvent) => void;
    onComplete?: (event: SSEEvent) => void;
    onError?: (err: Event) => void;
  },
): { connected: boolean; lastEvent: SSEEvent | null; close: () => void } {
  // url=null → don't connect (conditional streaming)
  // EventSource handles auto-reconnect natively
  // agent-complete → auto-close, set connected=false
  // Cleanup on unmount
}
```

### Key Design Decisions

1. **SSE endpoint per task** — `/api/agent-tasks/:id/stream` streams output for a single agent task. Clean, RESTful, and matches the architecture doc. One EventSource per streaming task on the client.

2. **reply.hijack() for Fastify SSE** — Fastify 5 doesn't natively support SSE. `reply.hijack()` tells Fastify to stop managing the response, giving us direct access to the raw Node.js response for streaming. This is the documented approach for SSE in Fastify.

3. **usePolling is generic** — Returns `{ data, loading, error, refresh }`. No Zustand coupling. Components decide what to do with the data. This makes the hook reusable across any endpoint.

4. **useSSE with null URL** — Passing `null` means "don't connect." This allows components to conditionally enable streaming (e.g., only stream when a task card is expanded). Cleaner than an `enabled` boolean.

5. **Refactor existing pages** — Three pages already use manual `setInterval` polling (activity, processes, dashboard). Refactoring them to use `usePolling` validates the hook immediately and eliminates duplicated polling boilerplate.

6. **No new event types needed** — The SSE endpoint consumes existing `agent:message` and `agent:task:complete` events from the event bus. No changes to `@raven/shared` types required.

7. **No new database tables needed** — SSE is a real-time passthrough from event bus to client. No persistence.

### NFR Compliance

- **NFR15:** SSE endpoint is non-blocking — Fastify handles requests asynchronously, event forwarding is callback-based
- **NFR18:** All I/O non-blocking — EventSource on client, event listeners on server, no synchronous waits
- **NFR8:** SSE route failure doesn't crash process — errors caught and logged
- **NFR9:** Client disconnect properly cleans up listeners — `req.raw.on('close')` handler
- **NFR29:** All logging via Pino structured JSON

### Previous Story Learnings (4.4 — Stale Task Detection & Nudging)

- **SuiteService pattern** for backend services — not applicable here (this is an API route, not a service)
- **Event subscription + cleanup** — critical for SSE: must `off()` listeners on client disconnect (same pattern as WS handler in `ws/handler.ts`)
- **vi.mock at module scope** — Vitest hoists mocks; put at file top
- **Commit message format** — `feat: <description> (story X.Y)` — follow for story 5.1

### Git Intelligence (Recent Commits)

```
5e894ac fix: scope type-checked ESLint linting to shared+core and fix deprecated Zod APIs
93f5e67 chore: remove pipeline disabled-test
07a2511 feat: autonomous task management (story 4.3) + code review fixes
d6b45b4 fix: harden media routing review fixes
84d120d feat: email action item extraction and task creation (story 4.2) + code review fixes
```

### Project Structure Notes

- **New files:**
  - `packages/core/src/api/sse/stream.ts` — SSE streaming route handler
  - `packages/web/src/hooks/usePolling.ts` — generic polling hook
  - `packages/web/src/hooks/useSSE.ts` — SSE EventSource hook
  - `packages/core/src/__tests__/sse.test.ts` — backend SSE tests
- **Modified files:**
  - `packages/core/src/api/server.ts` — register SSE route
  - `packages/web/src/app/activity/page.tsx` — refactor to use `usePolling`
  - `packages/web/src/app/processes/page.tsx` — refactor to use `usePolling`
  - `packages/web/src/app/page.tsx` — refactor health polling to use `usePolling`
- **No changes to:**
  - `packages/shared/src/types/` — no new types needed
  - `config/` — no new config files
  - Database/migrations — no schema changes

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 5, Story 5.1]
- [Source: _bmad-output/planning-artifacts/prd.md — FR27: Activity timeline, FR28: Kanban board, FR29: Pipeline monitor, FR30: Streaming agent output]
- [Source: _bmad-output/planning-artifacts/architecture.md — SSE Stream Format, Frontend Architecture (usePolling + useSSE), API Communication Patterns]
- [Source: _bmad-output/project-context.md — Critical implementation rules, TypeScript ESM, Fastify patterns]
- [Source: packages/core/src/api/server.ts — Route registration pattern, ApiDeps interface]
- [Source: packages/core/src/api/ws/handler.ts — EventBus subscription + cleanup on disconnect pattern]
- [Source: packages/core/src/api/routes/agent-tasks.ts — Task query/lookup patterns, ExecutionLogger usage]
- [Source: packages/core/src/agent-manager/agent-manager.ts:149,219 — agent:message and agent:task:complete event emission]
- [Source: packages/web/src/hooks/useWebSocket.ts — React hook pattern with useRef, cleanup]
- [Source: packages/web/src/lib/api-client.ts — API_URL base, request() helper, type exports]
- [Source: packages/web/src/stores/app-store.ts — Zustand store pattern]
- [Source: packages/web/src/app/activity/page.tsx — Manual setInterval polling pattern to refactor]
- [Source: packages/web/src/app/processes/page.tsx — Manual setInterval polling pattern to refactor]
- [Source: packages/shared/src/types/api.ts — WsMessageToClient types, ScheduleRecord]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- SSE header flush: Added `:ok\n\n` SSE comment on stream open to flush headers to client (required for `fetch` to resolve with headers before data events)
- Extracted `setupSSEStream()` helper to satisfy `max-lines-per-function` and `max-params` ESLint rules
- Used options object pattern (`SSEStreamOpts`) instead of 4 positional params

### Completion Notes List

- **Task 1**: Created `packages/core/src/api/sse/stream.ts` with `registerSSERoutes()`. Implements `GET /api/agent-tasks/:id/stream` — validates task exists, returns immediate JSON for completed tasks, or opens SSE stream for running tasks. Subscribes to `agent:message` and `agent:task:complete` events filtered by taskId. Cleanup on client disconnect prevents memory leaks. Uses `reply.hijack()` for Fastify 5 SSE streaming.
- **Task 2**: Registered SSE routes in `server.ts` after REST routes, before WebSocket handler. Passes `{ eventBus, executionLogger }` as deps.
- **Task 3**: Created generic `usePolling<T>` hook. Returns `{ data, loading, error, refresh }`. Loading state only true on first fetch (prevents UI flicker). Supports `enabled` option and `onError` callback. Uses `API_URL` from env.
- **Task 4**: Created `useSSE` hook with `EventSource`. Supports conditional connection via `url: string | null`. Listens for `agent-output`, `agent-complete`, `agent-error` named events. Auto-closes on `agent-complete`. Cleanup on unmount prevents state updates after unmount.
- **Task 5**: Refactored 3 pages to use `usePolling`: activity page (events, 5s), processes page (active tasks, 3s), dashboard page (health, 10s). Dashboard keeps Zustand `fetchAll()` for initial load, uses polling for health refresh and writes to Zustand store via `useEffect`.
- **Task 6**: Created 7 backend SSE tests covering: 404 for missing task, correct headers, event forwarding with taskId filter, event filtering for wrong taskId, agent-complete + stream close, completed task immediate response, listener cleanup on disconnect.

### Change Log

- 2026-03-16: Implemented story 5.1 — SSE streaming endpoint, usePolling hook, useSSE hook, refactored 3 polling pages, 7 backend tests. All tests pass (605/605). All lint checks pass.
- 2026-03-16: Code review fixes — Fixed H1: SSE `agent-complete` now derives status from `ev.payload.success` instead of hardcoding `'completed'`, includes `errors` field. Fixed M1: test helper `source` corrected to `'agent-manager'`, added failed-task SSE test. 8 tests, 606/606 pass.

### File List

- `packages/core/src/api/sse/stream.ts` (new) — SSE streaming route handler
- `packages/core/src/api/server.ts` (modified) — register SSE routes
- `packages/core/src/__tests__/sse.test.ts` (new) — 7 SSE backend tests
- `packages/web/src/hooks/usePolling.ts` (new) — generic polling hook
- `packages/web/src/hooks/useSSE.ts` (new) — SSE EventSource hook
- `packages/web/src/app/activity/page.tsx` (modified) — refactored to use usePolling
- `packages/web/src/app/processes/page.tsx` (modified) — refactored to use usePolling
- `packages/web/src/app/page.tsx` (modified) — refactored health polling to use usePolling
