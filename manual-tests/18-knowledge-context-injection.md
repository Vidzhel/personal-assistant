# 18 - Knowledge Context Injection (Story 6.5)

Verify that knowledge context is automatically injected into agent prompts, references are tracked per session, and the knowledge management agent handles CRUD operations.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), knowledge bubbles exist in Neo4j (create some via `POST /api/knowledge/bubbles`), at least one project with a session

## Test Cases — Context Injection

### KCI-01: Chat response includes knowledge context

**Steps:**
1. create knowledge bubbles via API if none exist:
   ```
   POST http://localhost:4001/api/knowledge/bubbles
   { "title": "Meeting Notes", "content": "Team standup at 9am daily", "tags": ["meetings"], "permanence": "normal" }
   ```
2. navigate to a project chat page
3. send a chat message related to the knowledge (e.g. "What meetings do I have?")
4. wait: for assistant response

**Expected:**
- The assistant's response references or incorporates knowledge from stored bubbles
- The knowledge context was silently injected into the agent prompt (not visible to user in chat)

### KCI-02: Context messages stored in session transcript

**Steps:**
1. send a chat message in a project session (as above)
2. note the session ID
3. query debug API:
   ```
   GET http://localhost:4001/api/sessions/{sessionId}/debug
   ```
4. inspect the response → assert:
   - messages array contains at least one entry with `role: "context"`
   - context message content includes knowledge bubble data (titles, snippets)

### KCI-03: References API returns grouped references

**Steps:**
1. after sending a chat that triggers context injection
2. query references API:
   ```
   GET http://localhost:4001/api/sessions/{sessionId}/references
   ```
3. inspect the response → assert:
   - response has `references` object
   - references are grouped by task ID (keys are task IDs or "unknown")
   - each reference has: `bubbleId`, `title`, `snippet`, `score`, `tags`, `domains`, `permanence`
   - scores are numbers between 0 and 1

### KCI-04: Empty knowledge produces no placeholder

**Steps:**
1. ensure no knowledge bubbles exist (or use a query unrelated to any stored knowledge)
2. send a chat message
3. query debug API for the session
4. inspect → assert:
   - no `role: "context"` messages in the transcript (graceful degradation, no empty placeholder)

### KCI-05: Token budget limits context size

**Steps:**
1. create many knowledge bubbles (10+) with varied content
2. send a chat message that could match many bubbles
3. query debug API for the session
4. inspect context message → assert:
   - context message exists but is bounded in size (not all bubbles included)
   - highest-relevance bubbles are prioritized (top-ranked by embedding similarity + recency + permanence)

## Test Cases — Knowledge Management Agent

### KCI-06: Knowledge agent handles creation

**Steps:**
1. navigate to a project chat page
2. send: "Remember that my dentist appointment is March 25th"
3. wait: for assistant response
4. query knowledge API:
   ```
   GET http://localhost:4001/api/knowledge/bubbles
   ```
5. inspect → assert:
   - a new bubble exists with content related to the dentist appointment
   - bubble has appropriate tags

### KCI-07: Knowledge agent handles queries

**Steps:**
1. ensure knowledge bubbles exist
2. navigate to a project chat page
3. send: "What do you know about my schedule?"
4. wait: for assistant response → assert:
   - response includes information from stored knowledge bubbles
   - response is conversational (not raw data dump)

### KCI-08: Knowledge agent handles deletion

**Steps:**
1. create a test bubble via API
2. navigate to a project chat page
3. send: "Forget the information about [topic of test bubble]"
4. wait: for assistant response
5. query knowledge API → assert:
   - the relevant bubble has been removed or updated

## Test Cases — Multi-Handler Injection

### KCI-09: Email handler injects context

**Steps:**
1. ensure knowledge bubbles exist
2. trigger an email processing event (via email skill or API)
3. query the resulting agent task via:
   ```
   GET http://localhost:4001/api/agent-tasks?status=completed
   ```
4. inspect the task → assert:
   - task prompt includes knowledge context injection

### KCI-10: Schedule handler injects context

**Steps:**
1. ensure knowledge bubbles exist
2. trigger a scheduled task (via pipeline or manual schedule trigger)
3. query the resulting agent task → assert:
   - task prompt includes knowledge context injection

**Notes:** Context injection is pervasive — all orchestrator handlers (chat, email, schedule) automatically inject relevant knowledge. The key verification is that `role: "context"` messages appear in session transcripts for all handler types.
