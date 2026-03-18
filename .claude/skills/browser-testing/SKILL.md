---
name: browser-testing
description: Browser testing and verification for the Raven dashboard using playwright-cli. Use when users need to verify pages, test UI interactions, verify acceptance criteria, create test specs, or perform any browser-based testing. Also use when the user mentions testing the frontend, checking if a page works, writing browser tests, or validating UI changes — even if they don't say "playwright" or "browser test" explicitly.
allowed-tools: Bash(playwright-cli:*)
---

# Browser Testing Skill

Create and run accessibility-tree-first browser tests for the Raven dashboard using `playwright-cli` commands. Tests are structured for automated execution by the `browser-tester` sub-agent.

## Test Location

Test specs live in `manual-tests/` at the project root, one file per feature area.

## Prerequisites

### 1. Check Dev Server Status

```bash
.claude/skills/browser-testing/scripts/check-devserver.sh
```

Reports status of frontend (port 4000) and API backend (port 4001).

### 2. Start Dev Servers (if needed)

```bash
npm run dev          # both servers
# Or individually:
.claude/skills/browser-testing/scripts/start-devserver.sh  # frontend only
npm run dev:core                                            # backend only
```

## No Authentication Required

The dashboard is open — navigate directly to `http://localhost:4000`.

## Available Routes

| Route | Page |
|-------|------|
| `/` | Dashboard — status cards, activity feed, quick actions |
| `/projects` | Projects list |
| `/projects/:id` | Project chat view |
| `/activity` | Activity log with filters |
| `/schedules` | Scheduled tasks |
| `/skills` | Active integrations |
| `/settings` | System info and configuration |

## Screenshot Output

All screenshots save to `.browser-test-output/` (gitignored).

---

## Writing Tests: Accessibility-Tree-First Format

The accessibility tree (from `playwright-cli snapshot`) is the primary assertion mechanism. It provides deterministic, machine-readable element data — roles, names, text content, and `ref` IDs for interaction. This is far more reliable than visual checks for automated testing.

### Test Spec Format

Each test case follows this structure. Keep it concise — one step per line, assertions reference what the snapshot tree must contain.

```markdown
### TEST-ID: Short descriptive name

**Steps:**
1. navigate: `http://localhost:4000/route`
2. snapshot → assert:
   - heading "Expected Heading Text"
   - button "Button Label"
   - link "Link Text"
   - textbox "Placeholder or label"
   - text "Any visible text content"
   - list with 3+ items
3. click: button "Create" → snapshot → assert:
   - text "Success message"
   - NOT text "Error"

**Notes:** (optional — context for why this matters)
```

### Assertion Types

Assertions check the accessibility tree returned by `playwright-cli snapshot`. Each assertion is a predicate on the tree:

| Assertion | What it checks | Example |
|-----------|---------------|---------|
| `heading "X"` | Element with heading role contains text X | `heading "Dashboard"` |
| `button "X"` | Button with accessible name X exists | `button "Send"` |
| `link "X"` | Link with text X exists | `link "Projects"` |
| `textbox "X"` | Input with placeholder or label X | `textbox "Ask Raven..."` |
| `text "X"` | Any element contains text X | `text "Online"` |
| `N items` or `N+ items` | Count elements of a type | `6 status cards` |
| `NOT text "X"` | Text X must NOT appear | `NOT text "Error"` |
| `role "X" named "Y"` | Generic role+name check | `role "navigation" named "Sidebar"` |

### Writing Good Assertions

The goal is assertions that verify **behavior and content**, not appearance. This keeps tests stable across styling changes.

**Do this — semantic assertions on accessibility tree:**
```markdown
- heading "Dashboard"
- text "Online"
- button "New Project"
- 6 status cards (Status, Skills, Projects, Agents Running, Queue, Schedules)
- link "Projects" is current (aria-current)
```

**Don't do this — visual/styling assertions:**
```markdown
- Background color is #141414          ← fragile, not in a11y tree
- Card is 224px wide                   ← layout detail, not testable via snapshot
- Text is green (#22c55e)              ← color info not in a11y tree
- Font is semibold                     ← styling detail
```

### Interaction Steps

When a test needs to interact with the page, reference elements by their accessible name (from the snapshot). The agent will find the matching `ref` ID automatically.

```markdown
1. navigate: `http://localhost:4000/projects`
2. snapshot → find button "New Project"
3. click: button "New Project"
4. snapshot → assert:
   - textbox "Project name"
   - button "Create"
5. type: textbox "Project name" ← "Test Project"
6. click: button "Create"
7. wait: 1s
8. snapshot → assert:
   - text "Test Project"
   - NOT textbox "Project name" (form closed)
```

### Waiting and Dynamic Content

- After navigation: take snapshot immediately — no artificial delay needed
- After interaction (click, type, submit): `wait: 1-2s` then snapshot
- WebSocket content: `wait: 3-5s` or `wait for text "expected text"`
- Loading states: if snapshot shows loading indicator, `wait: 2s` and re-snapshot

### Test File Structure

Each test file covers one feature area. Keep the header minimal:

```markdown
# Feature Area Name

Prerequisites: [what must be running/true]

## Test Cases

### TEST-01: Descriptive name
...

### TEST-02: Another test
...
```

Group related tests (e.g., all project CRUD tests together). Order tests so earlier ones set up state for later ones when practical.

---

## Running Tests

### Headless Mode (MANDATORY)

**Never pass `--headed` to `playwright-cli open` or any other command. All testing runs headless — no exceptions.**

### Single Test or Quick Verification

Use `playwright-cli` commands directly in conversation:

1. `playwright-cli open http://localhost:4000` → open browser
2. `playwright-cli goto <url>` → navigate to target
3. `playwright-cli snapshot` → read accessibility tree
4. Verify assertions against the tree
5. `playwright-cli click <ref>` / `playwright-cli fill <ref> "text"` for interactions
6. `playwright-cli snapshot` again to verify result
7. `playwright-cli close` when done

### Full Test Suite or Multi-Page Testing

Delegate to the `browser-tester` sub-agent for extensive testing. **Each agent must get its own named session** so multiple agents can run in parallel without colliding.

```
Use the Agent tool with subagent_type="browser-tester" and a prompt like:

"IMPORTANT: Use named session `-s=dash` for ALL playwright commands.
Open: `playwright-cli -s=dash open http://localhost:4000`
All commands: `playwright-cli -s=dash snapshot`, `playwright-cli -s=dash click <ref>`, etc.
Close when done: `playwright-cli -s=dash close`

Run the test spec from manual-tests/03-dashboard.md against http://localhost:4000.
For each test case:
1. Execute the steps (navigate, snapshot, interact)
2. Check each assertion against the accessibility tree
3. Record PASS/FAIL with evidence (the matching tree node or absence)
4. Take a screenshot only on FAIL for debugging

Return a structured report with results for every test case."
```

The sub-agent uses `playwright-cli` commands and knows the testing methodology. It runs in headless mode.

### Parallel Execution with Named Sessions

**CRITICAL**: Maximum **5 parallel `browser-tester` agents** at any time. If you have more test files, dispatch in batches of 5 and wait for each batch to complete before starting the next.

Each agent MUST use a unique named session (`-s=<name>`). Without named sessions, all agents share the same default browser and will interfere with each other.

Each agent gets its own isolated browser instance via named sessions:

```bash
# Agent 1 (smoke tests) — uses -s=smoke for ALL commands
playwright-cli -s=smoke open http://localhost:4000playwright-cli -s=smoke snapshot
playwright-cli -s=smoke click <ref>
playwright-cli -s=smoke close

# Agent 2 (dashboard tests) — uses -s=dash for ALL commands
playwright-cli -s=dash open http://localhost:4000playwright-cli -s=dash snapshot
playwright-cli -s=dash click <ref>
playwright-cli -s=dash close

# Agent 3 (project tests) — uses -s=proj for ALL commands
playwright-cli -s=proj open http://localhost:4000playwright-cli -s=proj snapshot
playwright-cli -s=proj click <ref>
playwright-cli -s=proj close
```

Rules:
- **Every** `playwright-cli` command in a parallel agent must include `-s=<name>`
- Session names should be short and match the test area (e.g., `smoke`, `dash`, `proj`, `nav`, `activity`)
- Each session has its own isolated browser window, accessibility tree, and ref IDs
- Sessions do not share state — navigation in one session does not affect others
- Each agent closes its own session when done: `playwright-cli -s=<name> close`
- If cleanup is needed: `playwright-cli close-all` closes all sessions

### Dispatching Parallel Agents — Template

**Maximum 5 parallel `browser-tester` agents at a time.** If you have more than 5 test files, dispatch them in batches — wait for a batch to complete before starting the next one.

When running multiple test files, dispatch agents like this:

```
# Agent 1: smoke tests (run first as prerequisite, foreground)
Agent(subagent_type="browser-tester", prompt="
  IMPORTANT: Use named session `-s=smoke` for ALL playwright commands.
  Run manual-tests/01-smoke-test.md ...
")

# Batch 1: up to 5 feature tests in parallel (background)
Agent(subagent_type="browser-tester", run_in_background=true, prompt="
  IMPORTANT: Use named session `-s=dash` for ALL playwright commands.
  Run manual-tests/03-dashboard.md ...
")
Agent(subagent_type="browser-tester", run_in_background=true, prompt="
  IMPORTANT: Use named session `-s=proj` for ALL playwright commands.
  Run manual-tests/04-projects-and-chat.md ...
")
Agent(subagent_type="browser-tester", run_in_background=true, prompt="
  IMPORTANT: Use named session `-s=nav` for ALL playwright commands.
  Run manual-tests/05-navigation.md ...
")
Agent(subagent_type="browser-tester", run_in_background=true, prompt="
  IMPORTANT: Use named session `-s=activity` for ALL playwright commands.
  Run manual-tests/06-activity.md ...
")
Agent(subagent_type="browser-tester", run_in_background=true, prompt="
  IMPORTANT: Use named session `-s=sched` for ALL playwright commands.
  Run manual-tests/07-schedules.md ...
")

# Wait for Batch 1 to complete before dispatching Batch 2
# Batch 2: next set of up to 5 agents...
```

### Batch Execution Tips

When running multiple test files:
- **Never exceed 5 concurrent `browser-tester` agents** — dispatch in batches of 5, waiting for each batch to finish before starting the next
- Run prerequisite tests first (smoke tests before feature tests)
- Dispatch independent test files as parallel agents with unique session names
- Take screenshots only on failures (saves time and context)
- Report a summary table at the end

---

## playwright-cli Command Reference

### Core
- `playwright-cli open <url>` — Open browser (headless)
- `playwright-cli goto <url>` — Navigate to URL
- `playwright-cli snapshot` — **Primary tool** — returns accessibility tree with `ref` IDs
- `playwright-cli screenshot` — Visual capture (use sparingly — only on failures or when explicitly needed)
- `playwright-cli click <ref>` — Click element by `ref` from snapshot
- `playwright-cli fill <ref> "text"` — Fill input field
- `playwright-cli type "text"` — Type text into focused element
- `playwright-cli select <ref> "value"` — Select dropdown option
- `playwright-cli hover <ref>` — Hover over element
- `playwright-cli drag <ref1> <ref2>` — Drag and drop
- `playwright-cli upload <path>` — Upload file
- `playwright-cli close` — Close browser

### Navigation
- `playwright-cli go-back` — Go back
- `playwright-cli go-forward` — Go forward
- `playwright-cli reload` — Reload page

### Keyboard
- `playwright-cli press <key>` — Press keyboard key (Enter, Tab, ArrowDown, etc.)

### Debugging (use on failures)
- `playwright-cli console` — JS console output
- `playwright-cli network` — Network activity
- `playwright-cli eval "code"` — Run JS on page
- `playwright-cli run-code "async page => ..."` — Run Playwright code

### Sessions
- `playwright-cli -s=<name> <command>` — Run command in named session
- `playwright-cli list` — List active sessions
- `playwright-cli close-all` — Close all sessions

### Utilities
- `playwright-cli tab-list` / `tab-new` / `tab-close` / `tab-select` — Tab management
- `playwright-cli resize <W> <H>` — Resize viewport
- `playwright-cli pdf --filename=X` — Save as PDF

---

## Troubleshooting

- **"Command not found"**: Try `npx playwright-cli` instead of `playwright-cli`
- **API errors**: Verify backend on port 4001 (`curl http://localhost:4001/api/health`)
- **Blank page**: Check `playwright-cli console` for JS errors
- **Stale data**: Dashboard uses WebSocket — if data seems stale, check backend is running
- **Element not found**: Re-take snapshot — refs change after page updates
- **Session issues**: Run `playwright-cli list` to see active sessions, `playwright-cli kill-all` to force reset
