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

## Test Cases — Project Data Sources (Story 10.9, AC: 2, 3)

### KCI-11: Create project data source

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/data-sources \
     -H "Content-Type: application/json" \
     -d '{"uri": "https://docs.google.com/document/d/abc123", "label": "Project Requirements", "description": "Main requirements document", "sourceType": "gdrive"}'
   ```
2. assert response:
   - status 200 or 201
   - `id`, `uri`, `label`, `description`, `sourceType` = "gdrive"

### KCI-12: List project data sources

**Steps:**
1. curl: `GET http://localhost:4001/api/projects/{projectId}/data-sources`
2. assert:
   - JSON array with data source entries
   - each has: `id`, `uri`, `label`, `sourceType`, `createdAt`

### KCI-13: Delete project data source

**Steps:**
1. note a data source ID from KCI-12
2. curl: `DELETE http://localhost:4001/api/projects/{projectId}/data-sources/{dsId}`
3. assert: status 200 or 204
4. curl: `GET http://localhost:4001/api/projects/{projectId}/data-sources`
5. assert: deleted data source no longer in list

### KCI-14: Data sources injected into agent prompt

**Steps:**
1. add data sources to a project (KCI-11)
2. send a chat message in that project
3. check agent task debug/logs → assert:
   - prompt includes "Project Data Sources" block
   - data source labels and URIs listed in the prompt context

## Test Cases — Project Knowledge Links (Story 10.9, AC: 1, 5, 9)

### KCI-15: Link bubble to project

**Steps:**
1. create a knowledge bubble if none exist
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/knowledge-links \
     -H "Content-Type: application/json" \
     -d '{"bubbleId": "{bubbleId}"}'
   ```
3. assert: link created successfully

### KCI-16: List project knowledge links

**Steps:**
1. after linking (KCI-15)
2. curl: `GET http://localhost:4001/api/projects/{projectId}/knowledge-links`
3. assert:
   - JSON array of linked bubbles
   - each entry has: bubble metadata (title, tags, contentPreview), link metadata (linkedBy, createdAt)

### KCI-17: Unlink bubble from project

**Steps:**
1. curl: `DELETE http://localhost:4001/api/projects/{projectId}/knowledge-links/{bubbleId}`
2. assert: status 200 or 204
3. curl: `GET http://localhost:4001/api/projects/{projectId}/knowledge-links`
4. assert: unlinked bubble no longer in list

## Test Cases — Knowledge Discovery Proposals (Story 10.9, AC: 4, 5, 6)

### KCI-18: Agent proposes knowledge bubble during chat

**Steps:**
1. navigate to a project chat
2. send a message containing novel information: "I discovered that the API rate limit is 100 requests per minute and responses are cached for 5 minutes"
3. wait: for assistant response
4. assert: agent may propose creating a knowledge bubble (e.g., "I found X — want me to add this to project knowledge?")

**Notes:** This depends on the AI agent deciding to propose. May not trigger every time.

### KCI-19: Approve knowledge proposal

**Steps:**
1. after a knowledge proposal is made (KCI-18 or via API)
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/knowledge-proposals/approve \
     -H "Content-Type: application/json" \
     -d '{"title": "API Rate Limits", "content": "Rate limit is 100 req/min, 5min cache", "tags": ["api", "limits"]}'
   ```
3. assert:
   - bubble created in knowledge store
   - bubble linked to project

### KCI-20: Reject knowledge proposal

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/projects/{projectId}/knowledge-proposals/reject \
     -H "Content-Type: application/json" \
     -d '{"contentHash": "{hash}", "reason": "Not relevant to this project"}'
   ```
2. assert: rejection recorded
3. assert: similar content not re-proposed in future (check via agent behavior or rejection table)

## Test Cases — Project Knowledge Tab UI (Story 10.9, AC: 1, 9)

### KCI-21: Knowledge tab shows linked bubbles

**Steps:**
1. navigate to a project → Knowledge tab
2. snapshot → assert:
   - linked knowledge bubbles displayed
   - each bubble shows: content preview, source, tags, creation date
   - edit and unlink actions available

### KCI-22: Knowledge tab shows data sources

**Steps:**
1. navigate to a project → Knowledge tab
2. snapshot → assert:
   - "Data Sources" section visible
   - linked data sources displayed with: label, URI, type
   - "Add Data Source" button available

### KCI-23: Add data source from UI

**Steps:**
1. navigate to project Knowledge tab
2. click: "Add Data Source" or "Link Document"
3. fill in: URI, label, description, source type
4. submit
5. assert: new data source appears in list
