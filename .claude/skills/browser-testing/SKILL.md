---
name: browser-testing
description: Browser testing and verification for the Raven dashboard using Playwright MCP. Use when users need to visually verify pages, test UI interactions, verify acceptance criteria, or perform any browser-based testing against the running frontend.
---

# Browser Testing Skill

Provides browser-based testing and verification for the Raven personal assistant dashboard using Playwright MCP tools.

## Tests location

Test scripts located under `manual-tests` directory in the root of the project.

## Prerequisites

### 1. Check Dev Server Status

```bash
.claude/skills/browser-testing/scripts/check-devserver.sh
```

Reports status of frontend (port 4000) and API backend (port 4001).

### 2. Start Dev Servers (if needed)

Run both servers together:
```bash
npm run dev
```

Or start individually:
```bash
.claude/skills/browser-testing/scripts/start-devserver.sh  # frontend only
npm run dev:core                                            # backend only
```

## No Authentication Required

The Raven dashboard is open — no login flow needed. Simply navigate to `http://localhost:4000` and the dashboard loads directly.

## Screenshot Output Directory

All screenshots and PDFs are saved to `.browser-test-output/` (configured via `--output-dir` in `.mcp.json`). This directory is gitignored.

## Available Routes

All routes are open — no authentication required.

| Route | Page | Notes |
|-------|------|-------|
| `/` | Dashboard | Status cards, activity feed, quick actions |
| `/projects` | Projects List | All projects |
| `/projects/:id` | Project Chat | Chat view for a specific project |
| `/activity` | Activity Log | Event history with filters |
| `/schedules` | Scheduled Tasks | Cron-based scheduled skills |
| `/skills` | Skills | Active integrations and their status |
| `/settings` | Settings | System info and configuration |

## Playwright MCP Tools Reference

### Navigation & State
- `mcp__playwright__browser_navigate` — Go to URL (`url` param)
- `mcp__playwright__browser_navigate_back` — Go back in history
- `mcp__playwright__browser_snapshot` — Get accessibility tree (use to find elements)
- `mcp__playwright__browser_take_screenshot` — Capture screenshot (saves to `.browser-test-output/`)
- `mcp__playwright__browser_wait_for` — Wait for text, text disappearance, or specified time

### Interaction
- `mcp__playwright__browser_click` — Click element (`element` + `ref` from snapshot)
- `mcp__playwright__browser_type` — Type text (`ref` + `text` params, `submit` to press Enter)
- `mcp__playwright__browser_fill_form` — Fill multiple form fields at once
- `mcp__playwright__browser_select_option` — Select dropdown option
- `mcp__playwright__browser_hover` — Hover over element
- `mcp__playwright__browser_drag` — Drag and drop
- `mcp__playwright__browser_press_key` — Press keyboard key
- `mcp__playwright__browser_file_upload` — Upload file to input

### Tab Management
- `mcp__playwright__browser_tabs` — List, create, close, or select tabs (`action` param: list/new/close/select)

### Debugging & Inspection
- `mcp__playwright__browser_console_messages` — Get browser console output
- `mcp__playwright__browser_network_requests` — List network requests
- `mcp__playwright__browser_evaluate` — Execute JavaScript on page

### Utilities
- `mcp__playwright__browser_pdf_save` — Save page as PDF
- `mcp__playwright__browser_install` — Install browser (if needed)
- `mcp__playwright__browser_close` — Close browser page
- `mcp__playwright__browser_resize` — Resize browser window

## Common Workflows

### Smoke Test
1. Check dev server status
2. Navigate to `http://localhost:4000`
3. Verify dashboard loads (status cards, activity feed visible)
4. Navigate through sidebar links to verify each page renders

### Page Verification
1. Navigate to target route
2. Take snapshot (accessibility tree) to verify content
3. Take screenshot for visual verification
4. Check for error states or missing content

### Form Testing
1. Navigate to form page
2. Take snapshot to identify form fields
3. Fill fields using click + type (or `browser_fill_form` for multiple fields)
4. Submit form
5. Verify success/error response

### Visual Regression
1. Navigate to page
2. Take screenshot
3. Compare with expected layout (describe to user)

## When to Delegate to Sub-Agent

For extensive testing (multiple pages, complex flows), delegate to the `browser-tester` sub-agent:

```
Use the Agent tool with subagent_type="browser-tester" and prompt describing:
- What pages/flows to test
- Acceptance criteria to verify
- Whether screenshots are needed
```

The sub-agent has its own system prompt at `.claude/agents/browser-testing/browser-tester.md` that includes the routes and reporting format.

## Troubleshooting

- **"Browser not found"**: Run `mcp__playwright__browser_install` to install Chrome
- **API errors on pages**: Verify the Fastify backend is running on port 4001 (`curl http://localhost:4001/api/health`)
- **Blank page**: Check browser console via snapshot; may be a JS error
- **Slow loading**: Use `mcp__playwright__browser_wait_for` with `time` param before snapshot
- **WebSocket issues**: Dashboard uses WS for real-time updates; if data seems stale, check backend is running
- **Display issues**: If headed mode fails, may need `--headless` flag in `.mcp.json`
