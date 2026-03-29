# Raven MCP Server — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Replaces:** Text-based agent-to-Raven communication (plan-builder.ts regex, SCORE extraction, WebFetch-to-localhost, prompt-injected API specs)

## Problem

Agents currently interact with Raven internals through 6 fragile mechanisms:

1. **Text parsing** — orchestrator outputs `EXECUTION_MODE: PLANNED` + `TASK_TREE: {...}` markers, parsed by regex in `plan-builder.ts`. Validation agents output `SCORE: N`, parsed by regex. Knowledge agents return raw JSON parsed with `JSON.parse()` and unsafe type casts.
2. **Prompt-injected REST API specs** — meta-project and named-agent management agents get localhost API endpoints injected into their prompts and use WebFetch to curl them.
3. **Prompt-injected context** — session history, knowledge context, skill catalogs, and task board context are loaded upfront and injected into system prompts regardless of whether the agent needs them.
4. **Implicit output capture** — agent text output is captured by SDK callbacks and treated as the "result" for task-tree completion, chat messages, etc.
5. **Internal REST API hacks** — the knowledge agent uses WebFetch to call `localhost:4001/api/knowledge/*` with a full REST spec in its prompt.
6. **Missing capabilities** — agents cannot report progress, store structured artifacts, escalate from direct to planned mode, or request approvals mid-task.

## Solution

A single Streamable HTTP MCP server at `http://localhost:4001/mcp` built into the existing Fastify server. Every agent gets this MCP with scope-based tool filtering. All agent-to-Raven communication goes through MCP tools — no text parsing, no WebFetch-to-localhost, no prompt-injected API specs.

All existing agents are migrated immediately. No dual-mode fallback period.

## Architecture

### MCP Server Location

```
packages/core/src/mcp-server/
  index.ts              — Fastify plugin, Streamable HTTP transport
  scope.ts              — Scope parsing, validation, tool filtering
  tools/
    task-lifecycle.ts   — classify_request, create_task_tree, complete_task, fail_task, update_task_progress, save_artifact
    session.ts          — send_message, get_session_history
    knowledge.ts        — search_knowledge, save_knowledge, get_knowledge_context
    validation.ts       — submit_validation_score
    system.ts           — list_agents, create_agent, update_agent, list_projects, manage_schedule, trigger_pipeline
    escalation.ts       — escalate_to_planned, request_approval
```

### Scoping

Each agent connection includes query params that define its permissions:

```
http://localhost:4001/mcp?role=task&taskId=xxx&treeId=yyy&sessionId=zzz&projectId=ppp
```

**Scope context:**

```typescript
type ScopeContext = {
  role: 'task' | 'chat' | 'system' | 'validation' | 'knowledge';
  projectId?: string;
  sessionId?: string;
  treeId?: string;
  taskId?: string;
};
```

**Scope → tool mapping:**

| Scope | Who gets it | Allowed tools |
|-------|------------|---------------|
| `task` | Task-tree agents | `get_task_context`, `complete_task`, `fail_task`, `update_task_progress`, `save_artifact`, `search_knowledge`, `send_message` |
| `chat` | Chat/orchestrator agents | `classify_request`, `create_task_tree`, `escalate_to_planned`, `send_message`, `get_session_history`, `search_knowledge`, `list_agents` |
| `system` | Meta-project agents | All tools |
| `validation` | Validation/evaluator agents | `submit_validation_score`, `get_task_context` |
| `knowledge` | Knowledge agents | All `knowledge_*` tools |

**Resource ownership enforcement:**
- A `task`-scoped agent can only call `complete_task`/`fail_task`/`update_task_progress` for its own `taskId`
- A `chat`-scoped agent can only call `send_message`/`get_session_history` for its own `sessionId`
- A `chat`-scoped agent can only call `create_task_tree` within its own `projectId`
- `system` scope has no resource restrictions

### Boot Sequence

1. Fastify server starts (existing)
2. MCP plugin registered at `/mcp` route
3. On connection: parse query params → build `ScopeContext` → filter available tools
4. On tool call: validate scope + resource ownership → execute → return result

### Agent-Session Wiring

`agent-session.ts` always includes the Raven MCP in every agent's `mcpServers` config:

```typescript
mcpServers['raven'] = {
  url: `http://localhost:${port}/mcp?role=${role}&projectId=${projectId}&sessionId=${sessionId}&taskId=${taskId}&treeId=${treeId}`,
  type: 'streamable-http',
};
```

Allowed tools include `mcp__raven__*` for all agents.

## Tool Definitions

### Task Lifecycle

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `classify_request` | `{mode: "direct"\|"delegated"\|"planned", reason: string}` | `{ack: true}` | `EXECUTION_MODE:` text marker |
| `create_task_tree` | `{plan: string, tasks: TaskNode[]}` | `{treeId: string, status: string}` | JSON-in-markdown parsing in plan-builder.ts |
| `get_task_context` | `{include?: ("parent"\|"dependencies"\|"siblings")[]}` | `{task: Task, parentResult?: string, dependencyResults?: Record<string,string>}` | Prompt-injected task board context |
| `complete_task` | `{summary: string, artifacts?: Artifact[]}` | `{ack: true, nextTask?: string}` | Raw agent text output as result |
| `fail_task` | `{error: string, retryable: boolean}` | `{ack: true, willRetry: boolean}` | Unstructured agent failure |
| `update_task_progress` | `{progress: number, statusText: string}` | `{ack: true}` | New capability |
| `save_artifact` | `{name: string, content: string, type: "text"\|"json"\|"markdown"\|"code"}` | `{artifactId: string}` | New capability |

### Session/Chat

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `send_message` | `{content: string, format?: "text"\|"markdown"}` | `{messageId: string}` | Implicit assistant message capture |
| `get_session_history` | `{limit?: number, before?: string}` | `{messages: Message[]}` | Prompt-injected full session history |

### Knowledge

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `search_knowledge` | `{query: string, tags?: string[], domain?: string, limit?: number}` | `{results: KnowledgeBubble[]}` | Knowledge agent WebFetch to `/api/knowledge/search` |
| `save_knowledge` | `{content: string, tags?: string[], domain?: string, permanence?: string}` | `{id: string}` | Knowledge agent WebFetch POST |
| `get_knowledge_context` | `{query: string, maxTokens?: number}` | `{context: string}` | Prompt-injected unbounded knowledge context |

### Validation

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `submit_validation_score` | `{score: number, feedback: string, pass: boolean}` | `{ack: true}` | Regex `SCORE:\s*(\d+)` extraction |

### System Management

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `list_agents` | `{projectId?: string}` | `{agents: Agent[]}` | WebFetch to `/api/agents` |
| `create_agent` | `{name, description, instructions, model?, maxTurns?, projectId?}` | `{agentId: string}` | WebFetch POST |
| `update_agent` | `{agentId: string, ...fields}` | `{ack: true}` | WebFetch PATCH |
| `list_projects` | `{}` | `{projects: Project[]}` | WebFetch to `/api/projects` |
| `manage_schedule` | `{action: "create"\|"update"\|"delete", ...fields}` | `{scheduleId?: string}` | Not available today |
| `trigger_pipeline` | `{name: string, params?: Record<string,string>}` | `{treeId: string}` | WebFetch POST |

### Escalation

| Tool | Params | Returns | Replaces |
|------|--------|---------|----------|
| `escalate_to_planned` | `{plan: string, tasks: TaskNode[]}` | `{treeId: string}` | Not possible today |
| `request_approval` | `{question: string, options?: string[]}` | `{approved: boolean, choice?: string}` | Not possible today |

## Execution Flow Changes

### PLANNED Mode

**Before:**
```
User message → orchestrator outputs EXECUTION_MODE: PLANNED + TASK_TREE: {...}
→ plan-builder.ts regex parses → emits execution:tree:create
→ execution engine creates tree → runs task agents
→ task agent outputs raw text → agent:task:complete event → onTaskCompleted({summary: rawText})
```

**After:**
```
User message → orchestrator calls classify_request({mode: "planned"})
→ calls create_task_tree({plan, tasks}) → MCP server creates tree via execution engine
→ calls send_message("Created a plan with N tasks...")
→ execution engine runs task agents (each with task-scoped Raven MCP)
→ task agent calls get_task_context() → does work → calls complete_task({summary, artifacts})
→ MCP server calls executionEngine.onTaskCompleted()
```

### DIRECT Mode

**Before:**
```
User message → orchestrator outputs text (no markers)
→ plan-builder.ts sees no PLANNED marker → treats as direct
→ raw text captured by onAssistantMessage → shown in chat
```

**After:**
```
User message → orchestrator calls classify_request({mode: "direct"})
→ does work → calls send_message({content: "answer..."})
```

### Validation

**Before:**
```
Validation agent outputs "SCORE: 4\nThe output is well-structured..."
→ regex extracts score + feedback
```

**After:**
```
Validation agent calls submit_validation_score({score: 4, feedback: "...", pass: true})
→ MCP server calls execution engine directly
```

### Knowledge Agent

**Before:**
```
Knowledge agent gets REST API spec in prompt
→ uses WebFetch to POST http://localhost:4001/api/knowledge/search
```

**After:**
```
Knowledge agent calls search_knowledge({query: "..."})
→ MCP server queries knowledge engine directly (no HTTP round-trip)
```

## Agent Migration Map

| Agent | Current mechanism | Migrated to | Code removed |
|-------|------------------|-------------|--------------|
| Orchestrator (triage) | Outputs `EXECUTION_MODE:` + `TASK_TREE:` markers | `classify_request` + `create_task_tree` | `plan-builder.ts`, `handleTaskCompleteTriage()` |
| Orchestrator (direct) | Implicit text capture | `classify_request` + `send_message` | Triage result extraction |
| Task-tree agents | Raw text → `agent:task:complete` event | `get_task_context` + `complete_task`/`fail_task` | Result extraction in `index.ts:325-353` |
| Validation agents | `SCORE: N` text output | `submit_validation_score` | Regex in `create-validation-deps.ts` |
| Knowledge agent | WebFetch to localhost REST API | `search_knowledge`, `save_knowledge` | REST spec prompt in `knowledge-agent.ts` |
| Knowledge consolidation | Raw JSON output, `JSON.parse()` | `complete_task` with structured artifacts | Silent-fail JSON.parse in `knowledge-consolidation.ts` |
| Cluster labeling | Raw JSON, unsafe type cast | `complete_task` with structured artifacts | Cast in `clustering-ops.ts:145` |
| Hub ops | Raw JSON, unsafe type cast | `complete_task` with structured artifacts | Cast in `hub-ops.ts:158` |
| Meta-project agent | Prompt-injected REST specs + WebFetch | System management MCP tools | API spec injection in `orchestrator.ts:474-492` |
| Named agent mgmt | Prompt-injected `/api/agents` CRUD | System management MCP tools | Injection in `orchestrator.ts:474` |
| Chat agents (all) | Upfront session history + knowledge injection | `get_session_history` + `get_knowledge_context` on demand | History loading in `agent-session.ts:277`, knowledge injection in `orchestrator.ts:322-333` |

## Agent Prompt Changes

### Orchestrator

Remove `buildTriageInstructions()`. Replace with:

```
You have access to Raven MCP tools for managing tasks and communication.

When you receive a user message:
1. Assess complexity and call classify_request with the appropriate mode
2. For DIRECT: do the work, then call send_message with the result
3. For DELEGATED: delegate to a sub-agent, then call send_message with the result
4. For PLANNED: call create_task_tree with the plan and task definitions.
   Then call send_message to inform the user about the plan.

Never output raw JSON task trees. Always use the create_task_tree tool.
```

### Task-tree agents

```
You are executing a specific task in a plan. Use these tools:
- get_task_context: read your task details and dependency results before starting
- complete_task: when done, submit your summary and any artifacts
- fail_task: if you cannot complete the task, report the error
- update_task_progress: for long-running work, report progress periodically
- send_message: to post visible updates to the user's chat

You MUST call complete_task or fail_task before finishing. Do not just output text.
```

### Validation agents

```
Evaluate the task output. When done, call submit_validation_score with:
- score: 1-5 rating
- feedback: explanation of your assessment
- pass: true if score >= threshold

Do not output SCORE: N as text. Use the tool.
```

### Knowledge agent

```
You manage Raven's knowledge base. Use these tools:
- search_knowledge: find existing knowledge by query, tags, or domain
- save_knowledge: store new knowledge items
- get_knowledge_context: retrieve relevant context for a topic

Do not use WebFetch to call localhost APIs.
```

### Meta-project agent

```
You manage Raven system configuration. Use these tools:
- list_agents, create_agent, update_agent: manage named agents
- list_projects: view projects
- manage_schedule: create/update/delete schedules
- trigger_pipeline: run pipelines

Do not use WebFetch to call localhost APIs.
```

### All chat agents

Session history and knowledge context are no longer injected upfront. Agents call `get_session_history` and `get_knowledge_context` on demand.

## What Stays in Prompt Injection

These remain as prompt content (agent identity, not data retrieval):
- Base system prompt ("You are Raven...")
- Agent-specific instructions (from agent config)
- Project context chain (static identity)
- System access control instructions (bash policy)
- Tool use instructions

## What Gets Deleted

- `plan-builder.ts` — entire file
- `handleTaskCompleteTriage()` in `orchestrator.ts`
- `pendingTriageTasks` map in `orchestrator.ts`
- `SCORE:` regex in `create-validation-deps.ts`
- Knowledge agent REST API prompt in `knowledge-agent.ts`
- Meta-project API spec injection in `orchestrator.ts:474-492`
- Named agent API injection in `orchestrator.ts:474`
- Upfront session history loading in `agent-session.ts:277`
- Upfront knowledge context injection in `orchestrator.ts:322-333`
- Result-as-summary extraction in `index.ts:325-353`
- `buildTriageInstructions()` in triage prompt builder

## Testing Strategy

### Unit Tests

Each tool file gets a test. Mock stores/engines, verify:
- Valid scope → correct engine method called
- Wrong scope → rejected with clear error
- Wrong resource (task agent targeting different taskId) → rejected
- Zod validation on params (bad input → structured error)

### Integration Tests

- Boot Fastify with MCP → connect as task-scoped → `complete_task` → verify execution engine receives completion
- Boot Fastify → connect as chat-scoped → `create_task_tree` → verify tree in DB
- Scope filtering: connect as task-scoped → list tools → only task tools returned
- Resource ownership: task-scoped with taskId=A → `complete_task` for taskId=B → rejected

### Agent Flow Tests

Mock Claude SDK, verify MCP tool usage:
- Orchestrator receives message → `classify_request` called → `create_task_tree` or `send_message` based on mode
- Task agent runs → `get_task_context` called → `complete_task` called
- Validation agent runs → `submit_validation_score` called

### Migration Regression Tests

- `plan-builder.ts` deleted and not imported
- No prompt contains `EXECUTION_MODE:` marker instructions
- No prompt contains `localhost` REST API specs
- No agent has WebFetch for localhost calls
- Grep for removed patterns: `SCORE:\s*`, `EXECUTION_MODE:`, `TASK_TREE:`, `localhost:4001/api` in prompt strings

## Other Bug Fixes (from E2E testing)

These were found during the E2E test run and should be fixed alongside the MCP work:

1. **No project delete button in UI** — add delete action to project cards/pages
2. **FK constraint on project delete API** — cascade delete sessions/tasks or delete in correct order
3. **Turn counter not updating** — session turn count stays "0 turns" after exchanges
4. **Client-side crash in ProjectPage** — `TypeError: Cannot read properties of undefined (reading 'map')` on description save
5. **Retry count / validation gates not shown** — task tree UI missing these fields
