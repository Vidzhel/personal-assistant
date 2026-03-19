# 22 - Background Pattern Analysis Engine (Story 7.1)

Verify the proactive intelligence suite: scheduled pattern analysis, insight generation, confidence filtering, duplicate suppression, and notification delivery.

Prerequisites: Backend running (`npm run dev:core`), Telegram bot connected, database has some history (events, tasks, sessions from prior usage)

## Test Cases — Suite Registration

### PAT-01: Suite enabled in config

**Steps:**
1. read: `config/suites.json`
2. assert:
   - `proactive-intelligence` key exists with `enabled: true`
   - `config.confidenceThreshold` is `0.6`
   - `config.suppressionWindowDays` is `7`
   - `config.maxInsightsPerRun` is `5`

### PAT-02: Suite loaded at boot

**Steps:**
1. start backend: `npm run dev:core`
2. check logs → assert:
   - log line indicating `proactive-intelligence` suite registered
   - `data-collector` and `insight-processor` services started

### PAT-03: Schedule registered

**Steps:**
1. GET `http://localhost:4001/api/schedules`
2. assert:
   - schedule with `taskType: "pattern-analysis"` exists
   - cron expression is `"0 */6 * * *"` (every 6 hours)
   - schedule is enabled

## Test Cases — Data Collection

### PAT-04: Manual trigger fires data collection

**Steps:**
1. POST `http://localhost:4001/api/schedules/pattern-analysis/trigger`
2. check logs → assert:
   - `data-collector` logs "Collecting data snapshots"
   - logs show counts for: events, agent tasks, audit entries, sessions
   - `agent:task:request` event emitted with snapshot context

### PAT-05: Data snapshot includes all sources

**Steps:**
1. ensure some data exists: send a chat message, trigger a pipeline, perform an action
2. POST `http://localhost:4001/api/schedules/pattern-analysis/trigger`
3. check logs → assert:
   - snapshot mentions event counts by type
   - snapshot mentions agent task success/failure counts
   - snapshot mentions session activity per project
   - snapshot mentions conversation volume/topics

## Test Cases — Insight Generation & Storage

### PAT-06: Insights stored in database

**Steps:**
1. POST `http://localhost:4001/api/schedules/pattern-analysis/trigger`
2. wait for agent task to complete (check logs or `GET /api/agent-tasks?status=completed`)
3. query DB: `SELECT * FROM insights ORDER BY created_at DESC LIMIT 5`
4. assert:
   - insights rows exist with: id, pattern_key, title, body, confidence, status, service_sources, suppression_hash
   - `created_at` is recent ISO timestamp
   - `service_sources` is valid JSON array

### PAT-07: Low confidence insights suppressed

**Steps:**
1. trigger pattern analysis
2. wait for completion
3. query DB: `SELECT * FROM insights WHERE confidence < 0.6`
4. assert:
   - low confidence insights have `status = 'suppressed'`
   - no `notification` event was emitted for these insights (check logs)

### PAT-08: High confidence insights queued

**Steps:**
1. trigger pattern analysis
2. wait for completion
3. query DB: `SELECT * FROM insights WHERE confidence >= 0.6 AND status != 'suppressed'`
4. assert:
   - qualifying insights have `status = 'queued'`
   - `insight:generated` event emitted for each (check logs)

## Test Cases — Duplicate Suppression

### PAT-09: Duplicate insight suppressed within window

**Steps:**
1. trigger pattern analysis → note the pattern_keys of generated insights
2. wait 1 minute
3. trigger pattern analysis again
4. query DB: `SELECT * FROM insights WHERE status = 'suppressed' ORDER BY created_at DESC`
5. assert:
   - if same pattern was detected again, second instance has `status = 'suppressed'`
   - `insight:suppressed` event emitted with `reason: 'duplicate'` (check logs)

### PAT-10: Insights with different data produce different hashes

**Steps:**
1. query DB: `SELECT suppression_hash, pattern_key FROM insights`
2. assert:
   - insights with different `pattern_key` values have different `suppression_hash` values
   - insights with the same `pattern_key` but genuinely different data also have different hashes

## Test Cases — Notification Delivery

### PAT-11: Insight delivered via Telegram

**Steps:**
1. trigger pattern analysis
2. wait for agent completion and insight processing
3. check Telegram bot → assert:
   - message received with insight title and body
   - inline keyboard with `[Useful]` and `[Dismiss]` buttons

### PAT-12: Insight callback actions work

**Steps:**
1. receive an insight notification in Telegram
2. tap `[Useful]` button
3. query DB: `SELECT status FROM insights WHERE id = '<insight_id>'`
4. assert: status is `'acted'`

5. receive another insight notification
6. tap `[Dismiss]` button
7. query DB → assert: status is `'dismissed'`

## Test Cases — Insight Store CRUD

### PAT-13: Health check includes insights capability

**Steps:**
1. GET `http://localhost:4001/api/health`
2. assert:
   - response includes suite information showing `proactive-intelligence` enabled
