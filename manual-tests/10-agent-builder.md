# 10 - Agent Builder (Phase 6)

Validates the agent builder that scaffolds entire project domains from natural language descriptions.

Prerequisites: Both servers running, capability library loaded

## Test Cases — Agent Builder Conversation

### BLD-01: Agent builder understands domain request

**Steps:**
1. create a new project or use an existing one
2. send chat message: "Set up a project for tracking my university coursework"
3. assert: agent responds with clarifying questions about:
   - what tools/integrations to use
   - recurring patterns (weekly reviews, exam prep)
   - agents needed
   - autonomy level

### BLD-02: Agent builder produces a design plan

**Steps:**
1. answer the clarifying questions from BLD-01
2. assert: agent produces a structured plan showing:
   - proposed project hierarchy (directories)
   - agent definitions (names, skills, descriptions)
   - template definitions (names, triggers, task sequences)
   - schedule definitions (cron expressions)

### BLD-03: Agent builder awaits approval before scaffolding

**Steps:**
1. after plan is presented
2. assert: agent asks for confirmation before writing files
3. respond: "looks good, proceed"
4. assert: agent begins scaffolding

### BLD-04: Scaffolding creates filesystem structure

**Steps:**
1. after approval
2. verify on disk:
   - `projects/{project-name}/context.md` exists
   - `projects/{project-name}/agents/*.yaml` files created
   - `projects/{project-name}/templates/*.yaml` files created (if applicable)
   - `projects/{project-name}/schedules/*.yaml` files created (if applicable)

### BLD-05: Scaffolded agents reference valid library skills

**Steps:**
1. read the created agent YAML files
2. assert: every skill in the `skills` array exists in the capability library
3. assert: YAML is valid (name is kebab-case, has required fields)

### BLD-06: Scaffolded templates have valid task structures

**Steps:**
1. read the created template YAML files
2. assert: `tasks` array is non-empty
3. assert: `blockedBy` references point to existing task IDs within same template
4. assert: `agent` references point to agents accessible at this scope

### BLD-07: Builder verifies its own output

**Steps:**
1. after scaffolding completes
2. assert: agent runs library validation on created files
3. assert: agent confirms all references resolve correctly

## Test Cases — Scaffolding Limits

### BLD-08: Builder refuses to reference non-existent skills

**Steps:**
1. request: "create an agent that uses the 'quantum-computing' skill"
2. assert: builder either asks for clarification or explains that skill doesn't exist
3. assert: builder suggests available skills instead

### BLD-09: Builder nesting limit (max 3 levels)

**Steps:**
1. request a deeply nested project structure (global → project → sub → sub-sub)
2. assert: builder limits to 3 levels (global → project → sub-project)
3. assert: builder explains the nesting constraint
