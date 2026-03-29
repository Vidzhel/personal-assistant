# 16 - End-to-End Agent Execution (v2)

Verifies real agent execution through the web UI: orchestrator triage (DIRECT/DELEGATED/PLANNED), task tree lifecycle, template trigger, validation pipeline, dependency resolution, and agent output quality.

Prerequisites: User runs `npm run dev:core` from their own terminal (not Claude Code). Both servers running (ports 4000, 4001).

**Important:** This test exercises real Claude agent execution. Chat responses take 10-60s. Task tree completion takes 30-180s. Use generous wait times and poll for results.

---

## Scenario A: Setup

Create the test project and agent through the dashboard. Clean up any leftovers from previous runs.

### E2E-01: Clean up previous test run

**Steps:**
1. navigate: `http://localhost:4000/agents`
2. snapshot → if text "e2e-agent" visible:
   - click: the "e2e-agent" card or row
   - click: delete button
   - confirm deletion
   - wait: 2s
3. navigate: `http://localhost:4000/projects`
4. snapshot → if text "e2e-test-project" visible:
   - click: the "e2e-test-project" entry
   - find and click: delete button
   - confirm deletion
   - wait: 2s

**Notes:** If neither exists, this is a no-op. The goal is an idempotent starting state.

### E2E-02: Create test project

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: "New Project" button (or "+" or "Create Project" button)
3. fill: project name ← "e2e-test-project"
4. fill: description ← "End-to-end test project for verifying v2 task execution engine."
5. click: "Create" or submit button
6. wait: 2s
7. snapshot → assert:
   - text "e2e-test-project" appears in the project list
8. note: PROJECT_ID (from URL after clicking the project, or from the list)

### E2E-03: Create test agent with model and maxTurns

**Steps:**
1. navigate: `http://localhost:4000/agents`
2. click: "+ Create Agent" or "New Agent" button
3. wait: 1s → snapshot → assert: form/modal visible with field "Name"
4. fill: Name ← "e2e-agent"
5. fill: Description ← "Test agent for e2e verification"
6. fill: Instructions ← "You are a helpful test agent. Answer questions concisely and accurately. When asked to write content, produce real, useful output. When asked to create multi-step plans, break work into concrete sequential steps."
7. select: Model ← "Sonnet"
8. fill: Max Turns ← "10"
9. select: Project Scope ← "e2e-test-project"
10. click: "Create Agent" button
11. wait: 2s
12. snapshot → assert:
    - text "e2e-agent" visible in agents list
    - NOT text "error" or "Error"

### E2E-04: Verify agent appears in project

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. click: project "e2e-test-project"
3. wait: 2s
4. click: tab "Agents"
5. wait: 1s
6. snapshot → assert:
   - text "e2e-agent" visible
   - text "own" badge (project-scoped, not inherited)

### E2E-05: Open chat and verify session

**Steps:**
1. click: tab "Sessions" (or navigate to project overview with chat panel)
2. snapshot → assert:
   - chat input visible (textbox with placeholder like "Ask Raven..." or similar)
   - send button visible

---

## Scenario B: Direct Chat — Simple Factual Question

**Real-world task:** Ask a straightforward factual question and get an immediate answer.
**Expected behavior:** Orchestrator classifies as DIRECT. Agent answers inline in chat. No task tree created.
**v2 features tested:** DIRECT triage mode, basic agent execution, chat message flow.

### E2E-06: Send a simple question

**Steps:**
1. click: chat input textbox
2. type: "Explain the difference between TCP and UDP in exactly 2 sentences."
3. click: Send button (or press Enter)
4. snapshot → assert:
   - user message bubble visible with text containing "TCP and UDP"

### E2E-07: Wait for and evaluate agent response

**Steps:**
1. wait: 10s
2. snapshot → check for assistant message
3. if no assistant message: wait 10s more, re-snapshot (repeat up to 60s total)
4. snapshot → assert:
   - assistant message bubble visible (role = assistant)
   - text mentions "TCP"
   - text mentions "UDP"
   - NOT text "error" or "failed" or "I cannot"
   - response is present (not empty or just whitespace)

**Quality evaluation:**
- Does the response correctly explain that TCP is connection-oriented/reliable and UDP is connectionless/faster?
- Is it approximately 2 sentences as requested?
- Is the information accurate?

### E2E-08: Verify no task tree was created

**Steps:**
1. navigate: `http://localhost:4000/task-trees`
2. wait: 2s
3. snapshot → assert:
   - no tree entry with a timestamp from the last 2 minutes that relates to this TCP/UDP question
   - (trees from template triggers in later tests are expected — only check timing)

---

## Scenario C: Delegated Chat — Professional Email Drafting

**Real-world task:** Draft a professional email to a professor requesting a deadline extension with specific details.
**Expected behavior:** Agent writes the full email inline. This tests whether the agent produces real, usable content.
**v2 features tested:** DELEGATED triage mode, substantial single-agent work, output quality.

### E2E-09: Start fresh session and send request

**Steps:**
1. navigate to project "e2e-test-project" detail page
2. click: "New Chat" button (creates fresh session, avoids context from previous scenario)
3. wait: 1s
4. click: chat input
5. type: "Write a professional email to my professor Dr. Smith requesting a 3-day extension on the thermodynamics assignment. The original deadline is April 5th. I've been sick with the flu for a week and missed two lab sessions. Keep it polite and concise."
6. click: Send
7. snapshot → assert: user message bubble visible

### E2E-10: Wait for and evaluate the drafted email

**Steps:**
1. wait: 15s
2. snapshot → check for assistant message
3. if no assistant message: wait 15s more, re-snapshot (repeat up to 90s total)
4. snapshot → assert:
   - assistant message visible with substantial content (not a one-liner)
   - text contains "Dr. Smith" (addressed correctly)
   - text contains "April 5" (deadline mentioned)
   - text contains one of: "Dear", "Hello", "Professor" (has a greeting)
   - text contains one of: "Sincerely", "Best regards", "Thank you", "Regards" (has a sign-off)
   - text contains one of: "extension", "additional time", "extra days" (requests the extension)
   - text contains one of: "sick", "flu", "ill", "health" (mentions the reason)

**Quality evaluation:**
- Is the tone professional and respectful?
- Does it clearly state the request (3 days, from April 5th to April 8th)?
- Does it explain the reason (flu, missed lab sessions) without being overly dramatic?
- Would you actually send this email to a professor?
- Is it concise as requested (not more than ~150 words)?

### E2E-11: Verify session state

**Steps:**
1. snapshot → assert:
   - session shows turn count (at least 1 exchange completed)
   - session status is "idle" or "completed" (not stuck in "running")

---

## Scenario C2: Email Retrieval via MCP

**Real-world task:** Retrieve the latest 2 emails and summarize them.
**Expected behavior:** The orchestrator delegates to a sub-agent with Gmail MCP access. The agent calls the Gmail MCP tools to fetch emails and returns real email summaries.
**v2 features tested:** MCP isolation (agent gets Gmail MCP), sub-agent delegation, real external tool integration.
**Prerequisites:** Gmail credentials must be configured in environment (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN). Skip this scenario if Gmail is not set up.

### E2E-12a: Start fresh session and request email retrieval

**Steps:**
1. navigate to project "e2e-test-project" chat
2. click: "New Chat" button (fresh session)
3. wait: 1s
4. click: chat input
5. type: "Retrieve my latest 2 emails and give me a brief summary of each one — who sent it, the subject, and a one-sentence summary of the content."
6. click: Send
7. snapshot → assert: user message bubble visible

### E2E-12b: Wait for and evaluate email summaries

**Steps:**
1. wait: 20s
2. snapshot → check for assistant response
3. if no response: wait 20s more, re-snapshot (repeat up to 120s total — MCP tool calls take time)
4. snapshot → assert:
   - assistant message visible with substantial content
   - response mentions at least 1 email (sender name/address, subject line)
   - NOT text "I cannot access" or "I don't have access" (would mean MCP not configured)
   - NOT text "error" in a failure context

**Quality evaluation:**
- Does the response contain real email data (actual sender names, actual subject lines)?
- Are there summaries for 2 emails as requested?
- Is each summary concise (one sentence per email)?
- If the agent couldn't access Gmail (MCP not configured), note: "Gmail MCP not available — skip this scenario"

### E2E-12c: Verify email tool usage

**Steps:**
1. snapshot → check for tool use indicators:
   - text mentioning "gmail" or email tool activity in the conversation
   - OR status line showed tool usage during execution

**Notes:** If Gmail credentials are not configured, the agent will respond that it cannot access emails. This is expected — record as SKIP, not FAIL. The test verifies the MCP integration path works when credentials are available.

---

## Scenario D: Template Trigger — Research Workflow

**Real-world task:** Research "benefits of test-driven development" and produce a summary.
**Expected behavior:** Template instantiates with the topic parameter, creates a task tree, auto-approves, agent executes and researches, tree completes with a real research summary.
**v2 features tested:** Template instantiation, parameter interpolation ({{ topic }}), task tree lifecycle, auto-approval, validation pipeline (Gate 1 + Gate 2), artifact/summary production.

### E2E-12: Navigate to templates and trigger research

**Steps:**
1. navigate: `http://localhost:4000/templates`
2. wait: 2s
3. snapshot → assert:
   - heading "Templates"
   - card "Research Topic" visible with description
   - "Trigger" button on the Research Topic card

### E2E-13: Fill topic parameter and submit

**Steps:**
1. click: "Trigger" button on "Research Topic" card
2. wait: 1s
3. snapshot → assert:
   - dialog/modal appeared
   - input field for "topic" parameter visible
4. fill: topic input ← "three practical benefits of test-driven development in software engineering"
5. click: "Run" or submit button
6. wait: 2s
7. snapshot → assert:
   - confirmation message visible (e.g., "Task tree created: ...")

### E2E-14: Navigate to Task Trees and find the new tree

**Steps:**
1. navigate: `http://localhost:4000/task-trees`
2. wait: 5s
3. snapshot → assert:
   - at least one tree entry visible
   - most recent tree has status "running" (yellow) or "completed" (green)
4. click: the most recent tree entry to expand it
5. wait: 2s
6. snapshot → assert:
   - task visible with title containing "Research" or "test-driven"
   - task shows a status badge

### E2E-15: Poll for completion and verify results

**Steps:**
1. if tree status is not "completed":
   - wait: 15s
   - reload page
   - repeat up to 120s total
2. snapshot (once completed) → assert:
   - tree status badge = "completed" (green)
   - research task status = "completed"
   - task shows summary text
   - summary mentions "test-driven development" or "TDD"
   - retry count = 0 (visible as badge or text)
3. if validation gates visible:
   - assert: G1 = "pass"
   - note: G2 result (evaluator judgment)

**Quality evaluation:**
- Does the research summary list actual, real benefits of TDD?
- Are the benefits practical (e.g., "catches bugs early", "enables refactoring", "serves as documentation")?
- Is the content accurate and not hallucinated?
- Would this be useful to someone learning about TDD?

### E2E-16: Check artifacts and execution metadata

**Steps:**
1. snapshot → assert:
   - task entry shows completion timestamp
   - artifacts section visible (even if empty — some tasks don't produce file artifacts)
   - no error messages or "lastError" text

---

## Scenario E: Planned Multi-Step — Research + Analysis + Recommendation

**Real-world task:** A complex 3-part request: (1) research productivity frameworks, (2) create a comparison, (3) write a personalized recommendation. Each step depends on the previous one.
**Expected behavior:** Orchestrator classifies as PLANNED, creates a multi-task tree with dependency chain, user approves, tasks execute sequentially respecting dependencies.
**v2 features tested:** PLANNED triage, task tree creation from chat, plan approval, dependency resolution (blockedBy), sequential multi-task execution, cross-task artifact reference.

**Note:** The orchestrator MAY classify this as DIRECT/DELEGATED instead of PLANNED. Both outcomes are valid — the test documents which path was taken.

### E2E-17: Start a fresh chat session

**Steps:**
1. navigate to project "e2e-test-project" detail page
2. click: "New Chat" button
3. wait: 1s
4. snapshot → assert: empty chat with input ready

### E2E-18: Send the complex multi-step request

**Steps:**
1. click: chat input
2. type: "I need you to do three things in sequence, each building on the previous: (1) Research the top 5 productivity frameworks used by software engineers in 2025-2026. (2) Create a comparison table with pros, cons, and best use case for each framework based on your research. (3) Write a personalized recommendation paragraph for a freelance developer who works on multiple client projects simultaneously. Please plan this as separate steps."
3. click: Send
4. snapshot → assert: user message bubble visible

### E2E-19: Check for task tree creation (PLANNED mode)

**Steps:**
1. wait: 20s (triage + planning takes longer than simple queries)
2. navigate: `http://localhost:4000/task-trees`
3. wait: 3s
4. snapshot → look for a new tree created in the last 60 seconds

**OUTCOME A — Task tree created (PLANNED mode worked):**
5. assert: new tree visible
6. click: tree to expand
7. snapshot → assert:
   - 2 or more tasks listed
   - tasks have titles related to: research, comparison/table, recommendation
   - at least one task shows "Depends on: ..." (dependency badge)
8. if status shows "pending" or "waiting-approval":
   - click: "Approve" button on the tree
   - wait: 2s
   - snapshot → assert: status changed to "running"
9. proceed to E2E-20

**OUTCOME B — No task tree (DIRECT/DELEGATED mode):**
5. navigate back to project chat
6. wait: up to 120s for assistant response (polling every 15s)
7. snapshot → assert:
   - assistant response visible
   - response addresses all 3 parts (research, comparison, recommendation)
8. note: "Orchestrator chose DIRECT/DELEGATED mode — answer delivered inline. PLANNED mode not triggered for this prompt."
9. skip to E2E-23

### E2E-20: Monitor dependency-ordered execution (PLANNED only)

**Steps:**
1. navigate: `http://localhost:4000/task-trees`
2. click: the planned tree to expand
3. observe task statuses:
   - first task (research): should be "in_progress" or "completed"
   - second task (comparison): should be "todo" or "blocked" while first is running
   - third task (recommendation): should be "todo" or "blocked" while second is not done
4. poll: reload page every 15s, snapshot each time
5. assert (over time): task 2 does NOT move to "in_progress" until task 1 shows "completed"
6. assert (over time): task 3 does NOT move to "in_progress" until task 2 shows "completed"
7. wait: up to 180s for tree status to reach "completed"
8. assert: tree status = "completed"

**Notes:** If a task fails, note the lastError and retryCount. Failures here indicate real issues with the execution engine or agent quality.

### E2E-21: Verify multi-step results (PLANNED only)

**Steps:**
1. snapshot → assert:
   - all tasks show "completed" status (green badges)
   - tree overall shows "completed"
   - each task has a summary visible

**Quality evaluation on each task:**
- **Task 1 (Research):** Does it name real productivity frameworks (e.g., GTD, Pomodoro, Eisenhower Matrix, Time Blocking, Kanban)? Are they actually used by software engineers?
- **Task 2 (Comparison):** Is there a structured comparison (table or organized list) with pros, cons, and use cases? Does it reference frameworks from task 1?
- **Task 3 (Recommendation):** Does it mention "freelance" or "multiple clients"? Is the recommendation personalized to the described persona? Does it reference the comparison from task 2?

### E2E-22: Check results in chat

**Steps:**
1. navigate back to project "e2e-test-project" chat
2. find the session where the multi-step request was sent
3. snapshot → assert:
   - some form of result or plan acknowledgment visible in the conversation
   - (the orchestrator typically posts a synthesis of the completed plan)

---

## Scenario F: Task Tree Cancellation

**Real-world task:** Start a workflow and cancel it before completion.
**v2 features tested:** Task tree cancellation, status transitions, in-progress task handling.

### E2E-23: Trigger a template and immediately cancel

**Steps:**
1. navigate: `http://localhost:4000/templates`
2. click: "Trigger" button on "Research Topic"
3. wait: 1s
4. fill: topic ← "history of programming languages"
5. click: "Run"
6. wait: 3s
7. navigate: `http://localhost:4000/task-trees`
8. wait: 2s
9. find the most recent tree (should have just been created)
10. click: "Cancel" button on that tree
11. wait: 2s

### E2E-24: Verify cancellation state

**Steps:**
1. snapshot → assert:
   - tree status badge = "cancelled" (gray)
   - no task in "in_progress" state (all should be cancelled, completed, or never started)

---

## Scenario G: Cleanup

Remove all test resources to leave the system in a clean state.

### E2E-25: Delete test agent

**Steps:**
1. navigate: `http://localhost:4000/agents`
2. snapshot → assert: text "e2e-agent" visible
3. click: delete button on "e2e-agent" → confirm deletion
4. wait: 2s
5. snapshot → assert: "e2e-agent" NOT visible in agents list

### E2E-26: Delete test project

**Steps:**
1. navigate: `http://localhost:4000/projects`
2. snapshot → assert: text "e2e-test-project" visible
3. click: delete button on "e2e-test-project" → confirm deletion
4. wait: 2s
5. snapshot → assert: "e2e-test-project" NOT visible in project list

### E2E-27: Verify final clean state

**Steps:**
1. navigate: `http://localhost:4000/agents`
2. snapshot → assert: only default "raven" agent visible (no "e2e-agent")
3. navigate: `http://localhost:4000/projects`
4. snapshot → assert: "e2e-test-project" NOT in list

**Notes:** Task trees from the test run may persist in the Task Trees page — this is expected (trees are historical records, not deleted with their parent project).

---

## v2 Architecture Coverage Summary

| v2 Spec Feature | Test Cases | Status |
|----------------|-----------|--------|
| Project CRUD | E2E-02, E2E-26 | |
| Agent CRUD with model/maxTurns | E2E-03, E2E-25 | |
| Project-agent scoping | E2E-03, E2E-04 | |
| Chat → DIRECT triage | E2E-06 to E2E-08 | |
| Chat → DELEGATED triage | E2E-09 to E2E-11 | |
| Chat → PLANNED triage | E2E-18, E2E-19 | |
| Template trigger with params | E2E-12, E2E-13 | |
| Parameter interpolation ({{ topic }}) | E2E-13 | |
| Task tree creation | E2E-14, E2E-19 | |
| Auto-approval | E2E-13, E2E-14 | |
| Manual approval | E2E-19 (Outcome A) | |
| Task tree execution | E2E-14, E2E-15, E2E-20 | |
| Dependency resolution (blockedBy) | E2E-20 | |
| Sequential multi-task execution | E2E-20, E2E-21 | |
| Validation pipeline (Gate 1+2) | E2E-15 | |
| Task summary/artifacts | E2E-15, E2E-16, E2E-21 | |
| Task tree cancellation | E2E-23, E2E-24 | |
| Agent output quality (real content) | E2E-07, E2E-10, E2E-15, E2E-21 | |
| Session management | E2E-05, E2E-09, E2E-17 | |
| Resource cleanup | E2E-01, E2E-25 to E2E-27 | |

## Features NOT Tested (require external credentials)

- Gmail MCP integration (email triage, morning briefing)
- TickTick MCP integration (task sync)
- Telegram notification delivery (notify task type)
- Google Calendar integration
- Knowledge context injection
- Bash access enforcement (sandboxed/scoped/full)
- Agent builder scaffolding (creates filesystem structure)
- Code task type execution (type: code with scripts)
- Condition task type (type: condition with expressions)
- Delay task type (type: delay)
- forEach dynamic fan-out
- Gate 3 quality review (optional, needs specific template config)
