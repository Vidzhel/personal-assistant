# 11 - Chat & Sessions (v2)

Validates chat functionality, session lifecycle, task-board protocol awareness, and orchestrator triage modes.

Prerequisites: Both servers running, at least one project exists

## Test Cases — Chat Basics

### CHAT-01: Send a chat message

**Steps:**
1. navigate to a project page: `http://localhost:4000/projects/{id}`
2. type in chat input: "Hello, what can you help me with?"
3. click: send button (or press Enter)
4. assert: user message bubble appears
5. wait: up to 30s
6. assert: assistant response appears

### CHAT-02: Chat creates a session

**Steps:**
1. send a message in a new project (or after clicking "New Chat")
2. assert: session selector shows current session
3. assert: session has an ID (displayed in selector, truncated)
4. assert: turn count increments after exchange

### CHAT-03: New Chat button creates fresh session

**Steps:**
1. send a few messages to establish a session
2. click: "New Chat" button
3. assert: chat clears
4. assert: session selector shows new session (different ID)
5. send a message
6. assert: new session has turn count = 1

### CHAT-04: Session switching loads correct messages

**Steps:**
1. have at least 2 sessions
2. click: session selector dropdown
3. select: a previous session
4. assert: messages from that session load
5. switch back to the other session
6. assert: correct messages displayed

## Test Cases — Session Management

### CHAT-05: Session auto-naming from first message

**Steps:**
1. start a new session
2. send: "Help me prepare for my calculus exam tomorrow"
3. assert: session name auto-generated from first message content (not the raw ID)

### CHAT-06: Edit session name

**Steps:**
1. click: session name in selector
2. type: new name "Exam Prep Session"
3. press Enter or click save
4. assert: session name updated
5. refresh page
6. assert: new name persists

### CHAT-07: Pin/unpin session

**Steps:**
1. find the pin button on a session
2. click: pin
3. assert: session marked as pinned
4. refresh page
5. assert: pinned session appears at top of session list
6. click: unpin
7. assert: session no longer pinned

### CHAT-08: Session debug panel

**Steps:**
1. open session debug panel (click debug/inspector button)
2. assert: shows sections:
   - Session metadata (ID, status, turn count)
   - Messages list
   - Tasks associated with session
   - Audit entries
3. click: "Copy All" button
4. assert: debug data copied to clipboard

## Test Cases — Orchestrator Triage (v2)

### CHAT-09: DIRECT mode — simple query

**Steps:**
1. send: "What time is it?"
2. assert: response arrives quickly (single agent call, no task tree created)
3. curl: `GET http://localhost:4001/api/task-trees`
4. assert: no new task tree created for this request (DIRECT mode skips the engine)

### CHAT-10: DELEGATED mode — substantial single-agent work

**Steps:**
1. send: "Summarize my emails from today" (requires one agent with email skills)
2. assert: a task is created for this work
3. assert: task goes through validation after completion

### CHAT-11: PLANNED mode — multi-agent complex work

**Steps:**
1. send: "Create a study plan for my upcoming exams, check my calendar for exam dates, and draft a revision schedule"
2. assert: orchestrator creates a task tree with multiple tasks
3. assert: task tree status = `pending_approval` (plan displayed for review)
4. assert: plan shows task breakdown with agent assignments and dependencies
5. approve the plan
6. assert: execution begins

### CHAT-12: Task-board protocol — agent creates/claims tasks

**Steps:**
1. trigger a DELEGATED or PLANNED request
2. observe the task tree
3. assert: agent sets task status to `in_progress` when starting
4. assert: agent attaches artifacts as it works
5. assert: agent completes task with summary
6. assert: only task ID + summary returned to orchestrator (not full content)

## Test Cases — Session Retrospective

### CHAT-13: Idle session triggers retrospective

**Steps:**
1. have a session with several turns
2. wait for idle timeout (configurable, default 30 min — use API trigger for testing)
3. curl: `POST http://localhost:4001/api/sessions/{id}/retrospective` (manual trigger)
4. assert: retrospective produces:
   - summary
   - decisions list
   - action items
   - candidate knowledge bubbles

### CHAT-14: Session compaction on long conversations

**Steps:**
1. have a session with many messages (exceeds threshold)
2. assert: older messages are compacted (summarized)
3. assert: session continues working with compacted context
4. assert: compaction block stored with summary

### CHAT-15: Session search

**Steps:**
1. have multiple sessions with different names
2. use session search to find by name
3. assert: matching sessions returned
4. search by description
5. assert: matching sessions returned
