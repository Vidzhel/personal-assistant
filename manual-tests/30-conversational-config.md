# 30 - Conversational Configuration Management (Story 10.5)

Verify conversational config creation, diff presentation, approval flow (Telegram + dashboard), convention auditing, and suite scaffolding.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), Telegram bot connected, meta-project or project with `systemAccess: "read-write"`

## Test Cases — Config View (AC: 10)

### CONFIG-01: View current pipelines via chat

**Steps:**
1. navigate to meta-project chat
2. send: "Show me the morning-briefing pipeline"
3. wait: for assistant response
4. assert: response displays the pipeline configuration in readable format

### CONFIG-02: View all agents via chat

**Steps:**
1. navigate to meta-project chat
2. send: "What agents do I have?"
3. wait: for response
4. assert: response lists named agents with descriptions and suite bindings

### CONFIG-03: View schedules via chat

**Steps:**
1. navigate to meta-project chat
2. send: "What schedules are active?"
3. wait: for response
4. assert: response lists active schedules with cron expressions and descriptions

## Test Cases — Config Generation (AC: 1, 2, 4, 5)

### CONFIG-04: Create pipeline via conversation

**Steps:**
1. navigate to meta-project chat
2. send: "Create a pipeline that checks my email every hour and creates tasks from urgent ones"
3. wait: for assistant response
4. assert:
   - response presents generated YAML pipeline config
   - pipeline has cron trigger (`0 * * * *` or similar)
   - pipeline has email and task-management nodes
   - diff or full content is formatted for review

### CONFIG-05: Edit pipeline via conversation

**Steps:**
1. navigate to meta-project chat
2. send: "Edit the morning-briefing pipeline to also include a financial summary step"
3. wait: for response
4. assert:
   - response shows before/after diff
   - new node added for financial summary
   - existing nodes preserved

### CONFIG-06: Create agent via conversation

**Steps:**
1. navigate to meta-project chat
2. send: "Create an agent called 'finance-bot' that uses the financial-tracking and email suites"
3. wait: for response
4. assert:
   - response presents proposed agent config
   - agent has correct name, suite bindings
   - instructions are sensible for the described purpose

### CONFIG-07: Create schedule via conversation

**Steps:**
1. navigate to meta-project chat
2. send: "Add a schedule that runs the digest every weekday at 9am"
3. wait: for response
4. assert:
   - response presents proposed schedule entry
   - cron expression matches weekday 9am (`0 9 * * 1-5`)

## Test Cases — Approval Flow (AC: 6, 7, 8)

### CONFIG-08: Proposed change stored as pending

**Steps:**
1. after a config generation response (CONFIG-04 through CONFIG-07)
2. curl: `GET http://localhost:4001/api/config-changes`
3. assert:
   - at least one entry with `status` = "pending"
   - entry has: `resourceType`, `resourceName`, `action`, `proposedContent`

### CONFIG-09: Telegram approval buttons shown

**Steps:**
1. after a config change is proposed
2. check Telegram for the proposed change message
3. assert:
   - message shows formatted diff/content
   - inline keyboard with buttons: [Apply] [Edit] [Discard]

### CONFIG-10: Apply via Telegram

**Steps:**
1. tap "Apply" on a pending config change in Telegram
2. wait: 2-3s
3. assert:
   - Telegram message updates to show "Applied" status
   - config change applied (verify via API: pipeline/agent/schedule exists)
   - git commit created for the change

### CONFIG-11: Discard via Telegram

**Steps:**
1. propose a new config change
2. tap "Discard" on the Telegram message
3. assert:
   - Telegram message updates to "Discarded"
   - no changes applied
   - curl: `GET http://localhost:4001/api/config-changes` → change status = "discarded"

### CONFIG-12: Edit via Telegram

**Steps:**
1. propose a config change
2. tap "Edit" on the Telegram message
3. assert: bot responds with "Describe your changes:" prompt
4. reply with modifications (e.g., "Change the cron to every 2 hours instead")
5. assert: revised config is regenerated and re-presented for approval

### CONFIG-13: Approve via dashboard

**Steps:**
1. navigate to config management page in dashboard
2. snapshot → assert:
   - pending changes listed with approve/reject actions
   - change detail shows diff or full content
3. click approve on a pending change
4. assert: change applied and status updates

## Test Cases — Config Deletion (AC: 11)

### CONFIG-14: Delete via conversation

**Steps:**
1. navigate to meta-project chat
2. send: "Delete the test-pipeline pipeline"
3. wait: for response
4. assert:
   - confirmation prompt shown before deletion
   - resource summary displayed
5. confirm deletion
6. assert: resource removed, git committed

## Test Cases — Convention Auditing (AC: 13-17)

### CONFIG-15: Generated suite follows conventions

**Steps:**
1. navigate to meta-project chat
2. send: "Create a new suite for weather monitoring"
3. wait: for response
4. assert generated suite includes:
   - `suite.ts` using `defineSuite()`
   - `mcp.json` for MCP server declarations
   - `actions.json` for action definitions
   - `agents/` directory
   - `UPDATE.md` with dependency monitoring instructions
   - kebab-case file naming throughout

### CONFIG-16: Convention audit in maintenance report

**Steps:**
1. trigger maintenance pipeline: `POST http://localhost:4001/api/pipelines/system-maintenance/trigger`
2. wait for completion
3. read maintenance report
4. assert: "Convention Compliance" section exists (or similar)
   - lists any missing required files (e.g., UPDATE.md)
   - lists naming violations
   - lists schema drift or unused resources

## Test Cases — Dashboard Config Page

### CONFIG-17: Config changes page loads

**Steps:**
1. navigate to config management page in dashboard
2. snapshot → assert:
   - heading includes "Config" or "Configuration"
   - pending changes section visible
   - recent change history section visible
   - quick links to view current configs

### CONFIG-18: Real-time updates on config changes

**Steps:**
1. open config changes page in dashboard
2. propose a config change via chat (in another tab)
3. assert: new pending change appears without page refresh (WebSocket/SSE)
