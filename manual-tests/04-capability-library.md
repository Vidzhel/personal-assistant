# 04 - Capability Library (Phase 1)

Validates the hierarchical skill library, MCP definitions, progressive disclosure, and skill browser UI.

Prerequisites: Both servers running, `library/` directory populated with skills and MCPs

## Test Cases — Skills API

### LIB-01: List all skills

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. assert response:
   - status 200
   - JSON array returned
   - each entry has: `name`, `description`, `version`
   - at least 1 skill present

### LIB-02: Skill entries include capability metadata

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. pick any skill from the list
3. assert it has:
   - `capabilities` array (e.g., `["mcp-server", "agent-definition"]`)
   - `mcpServers` object (may be empty)
   - `agentDefinitions` object (may be empty)

### LIB-03: Skill count matches dashboard

**Steps:**
1. curl: `GET http://localhost:4001/api/skills` → note length as API_COUNT
2. navigate: `http://localhost:4000`
3. assert: "Skills" status card shows API_COUNT

## Test Cases — MCP Definitions

### LIB-04: MCPs are independently defined

**Steps:**
1. curl: `GET http://localhost:4001/api/skills`
2. find a skill that references MCPs
3. assert: MCP config includes `command`, `args` fields
4. assert: MCP configs are namespaced (prefixed with skill/mcp name)

**Notes:** MCPs are a shared library resource. Multiple skills can reference the same MCP by name. MCP definitions live in `library/mcps/*.json` on disk.

## Test Cases — Skills Browser UI

### LIB-05: Skills page loads with card display

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - heading "Skills"
   - at least 1 skill card
   - each card shows: name, description, version

### LIB-06: Skill cards show capability badges

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. snapshot → assert:
   - skill cards display capability badges (e.g., "mcp-server", "event-source")
   - badges are visually distinct (colored tags or pills)

### LIB-07: Skill detail shows MCP and agent info

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. click: any skill card with MCP capability
3. assert: expanded view shows:
   - MCP server names referenced
   - agent definition names
   - skill description in full

### LIB-08: Hierarchical skill library browser

**Steps:**
1. navigate: `http://localhost:4000/skills`
2. assert: skills are organized by domain categories:
   - domains like "file-management", "communication", "productivity", "finance", "system"
   - each domain is collapsible or acts as a section header
3. click: expand a domain category
4. assert: child skills within that domain are displayed

**Notes:** This tests the progressive disclosure Tier 0 (discovery) view. The browser shows skill names + descriptions organized by domain hierarchy matching `library/skills/` structure.

### LIB-09: Skill count consistent across pages

**Steps:**
1. navigate: `http://localhost:4000/skills` → count visible skill cards as UI_COUNT
2. navigate: `http://localhost:4000` → read "Skills" status card as DASH_COUNT
3. curl: `GET http://localhost:4001/api/skills` → note length as API_COUNT
4. assert: UI_COUNT = DASH_COUNT = API_COUNT
