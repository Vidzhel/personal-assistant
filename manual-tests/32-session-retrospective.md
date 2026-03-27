# 32 - Session Auto-Compaction & Background Retrospective (Story 10.10)

Verify idle detection, automatic retrospective agent, knowledge extraction, session compaction, and weekly consolidation.

Prerequisites: Backend running (`npm run dev:core`), at least one project with sessions containing conversation history, knowledge system operational (Neo4j running)

## Test Cases — Idle Detection (AC: 1)

### RETRO-01: Idle session detected after timeout

**Steps:**
1. start a session and send a few messages to create conversation history
2. stop interacting and wait for idle timeout (default 30 minutes, or adjust `RAVEN_SESSION_IDLE_TIMEOUT_MS` for testing)
3. check logs → assert:
   - `session:idle` event emitted for the idle session
   - log shows idle detector identified the session

**Notes:** For faster testing, set `RAVEN_SESSION_IDLE_TIMEOUT_MS` to a shorter value (e.g., 60000 for 1 minute).

### RETRO-02: Sessions with no turns are skipped

**Steps:**
1. create a new session (no messages sent)
2. wait past idle timeout
3. check logs → assert:
   - session with 0 turns is NOT detected as idle
   - no `session:idle` event for empty sessions

### RETRO-03: Already-retrospected sessions are skipped

**Steps:**
1. after RETRO-01, the retrospected session should have a summary
2. wait for another idle detection cycle
3. check logs → assert:
   - previously-retrospected session is NOT re-triggered
   - `summary IS NULL` check in SQL prevents duplicate processing

## Test Cases — Manual Retrospective Trigger (AC: 9)

### RETRO-04: Manual trigger via API

**Steps:**
1. find a session with conversation history:
   ```bash
   curl http://localhost:4001/api/projects/{projectId}/sessions
   ```
2. trigger retrospective:
   ```bash
   curl -X POST http://localhost:4001/api/sessions/{sessionId}/retrospective
   ```
3. assert response:
   - status 200 or 202
   - response includes or references the retrospective result
4. wait for completion (may take 10-30s for AI agent)

### RETRO-05: Retrospective produces structured result

**Steps:**
1. after manual trigger (RETRO-04) completes
2. check the session:
   ```bash
   curl http://localhost:4001/api/sessions/{sessionId}
   ```
3. assert:
   - `summary` field is now populated (was null before)
   - summary is 2-3 paragraphs, not raw JSON

## Test Cases — Knowledge Extraction (AC: 2, 3, 4, 5)

### RETRO-06: Candidate knowledge bubbles created

**Steps:**
1. trigger retrospective on a session with substantive conversation
2. check project knowledge:
   ```bash
   curl http://localhost:4001/api/projects/{projectId}/knowledge-links
   ```
3. assert:
   - new knowledge bubbles linked to the project
   - bubbles have `source` = "auto-retrospective" or similar marker

### RETRO-07: High-confidence bubbles auto-approved

**Steps:**
1. after retrospective completes
2. check knowledge bubbles:
   ```bash
   curl http://localhost:4001/api/knowledge/bubbles
   ```
3. assert:
   - bubbles with clear factual content are created and linked (auto-approved)
   - bubble tags are relevant to the session content

### RETRO-08: Low-confidence bubbles saved as drafts

**Steps:**
1. after retrospective completes with subjective/tentative findings
2. check for draft notifications
3. assert:
   - bubbles with low confidence are not auto-approved
   - Telegram notification sent asking for user approval
   - drafts queryable separately

### RETRO-09: Deduplication against existing knowledge

**Steps:**
1. create a knowledge bubble manually:
   ```bash
   curl -X POST http://localhost:4001/api/knowledge/bubbles \
     -H "Content-Type: application/json" \
     -d '{"title": "Test Fact", "content": "The sky is blue", "tags": ["test"]}'
   ```
2. link it to the project
3. have a session conversation that discusses the same fact
4. trigger retrospective
5. assert:
   - no duplicate bubble created for "The sky is blue"
   - retrospective agent detects existing knowledge and skips/merges

## Test Cases — Session Summary (AC: 6)

### RETRO-10: Summary appears in session lists

**Steps:**
1. after retrospective completes for a session
2. navigate to the project overview page
3. snapshot → assert:
   - session shows summary text in the sessions list
   - summary is readable (not raw JSON)

### RETRO-11: Summary appears in session detail

**Steps:**
1. navigate to the project sessions tab
2. select the retrospected session
3. snapshot → assert:
   - summary visible in session info area
   - decisions, findings listed (if UI supports)

## Test Cases — Session Compaction (AC: 10)

### RETRO-12: Session compacts when exceeding threshold

**Steps:**
1. set `RAVEN_SESSION_COMPACTION_THRESHOLD` to a low value (e.g., 5 messages) for testing
2. send 6+ messages in a session
3. check logs → assert:
   - `session:compacted` event emitted
   - older messages summarized into a compaction block
4. check session debug:
   ```bash
   curl http://localhost:4001/api/sessions/{sessionId}/debug
   ```
5. assert:
   - compaction block present at start of message history
   - original old messages archived (not in active transcript)

### RETRO-13: Compacted session continues normally

**Steps:**
1. after compaction (RETRO-12)
2. send another message in the same session
3. assert:
   - chat continues normally
   - agent receives compacted context + recent messages
   - no errors or loss of continuity

## Test Cases — Retrospective Events

### RETRO-14: Retrospective complete event emitted

**Steps:**
1. trigger retrospective (RETRO-04)
2. check logs → assert:
   - `session:retrospective:complete` event emitted
   - event payload includes: `sessionId`, `projectId`, `summary`, `bubblesCreated`, `bubblesDrafted`

## Test Cases — Weekly Consolidation (AC: 7, 8)

### RETRO-15: Consolidation schedule exists

**Steps:**
1. check `config/schedules.json` or schedules API
2. assert: consolidation schedule exists (default: `0 3 * * 0` — Sunday 3am)

### RETRO-16: Consolidation reviews accumulated knowledge

**Steps:**
1. trigger consolidation manually (if API exists) or wait for schedule
2. check logs → assert:
   - consolidation agent processes accumulated auto-generated bubbles
   - merges, prunes, or consolidates as appropriate
   - project digest produced (if significant changes)

## Test Cases — Configuration

### RETRO-17: Auto-retrospective can be disabled

**Steps:**
1. set `RAVEN_AUTO_RETROSPECTIVE_ENABLED=false`
2. restart backend
3. wait for idle sessions
4. assert: no retrospective triggered (idle detector not started)

### RETRO-18: Idle timeout is configurable

**Steps:**
1. set `RAVEN_SESSION_IDLE_TIMEOUT_MS=120000` (2 minutes)
2. restart backend
3. create session, send messages, wait 2+ minutes
4. assert: idle detected at ~2 minute mark (not 30 minutes)
