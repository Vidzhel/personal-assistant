# Story 6.5: Knowledge Management Agent & Context Injection

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want a dedicated knowledge management agent that can retrieve, update, organize, and inject relevant knowledge into any sub-agent's context,
so that Raven acts as my second brain — searchable, conversational, and always providing relevant context.

## Acceptance Criteria

1. **Orchestrator routes to knowledge agent**: Given the user asks Raven about a topic in their knowledge base, when the orchestrator routes to the knowledge agent, then the agent uses the multi-tier retrieval engine to find relevant bubbles, presents organized results with references, and can update/link/tag bubbles conversationally.

2. **Pervasive context injection into ALL agent tasks**: Given any agent task (user chat, new email, scheduled task), when the orchestrator prepares the task, then the context injector runs automatically — retrieving relevant knowledge from the user's message, email subject/sender/snippet, or schedule name/task type, and injecting it into the agent's system prompt. This is not limited to explicit "search my knowledge" queries.

3. **Token budget enforcement**: Given the knowledge retrieval finds 10 relevant bubbles, when the token budget is 2000 tokens, then only the top-ranked bubbles (by embedding similarity + recency + permanence weight) fitting within the budget are injected.

4. **Empty results — no placeholder**: Given no relevant knowledge exists for a task, when retrieval returns empty results, then no knowledge section is added to the prompt (no empty placeholder).

5. **Recency and permanence weighting**: Given a knowledge bubble was updated recently, when relevance scoring runs, then recency is factored in — newer relevant bubbles rank higher; `robust` permanence bubbles get a retrieval boost.

6. **Conversational knowledge management**: Given the user asks the knowledge agent to organize or link bubbles, when the agent processes the request, then it can create/remove links, reassign domains, adjust permanence, merge bubbles, and update tags through the knowledge store API.

7. **Reference tracking for frontend**: Given knowledge is injected into an agent task, when the task runs within a session, then a `role: 'context'` message is stored in the session transcript containing the injected references. A new API endpoint `GET /sessions/:id/references` returns all injected references grouped by task.

## Tasks / Subtasks

- [x] Task 1: Context injector module (AC: #2, #3, #4, #5)
  - [x] 1.1 Create `packages/core/src/knowledge-engine/context-injector.ts` — factory function `createContextInjector(deps)`
  - [x] 1.2 Implement `retrieveContext(query: string, options?: ContextInjectionOptions): Promise<KnowledgeContext | null>` — calls retrieval engine, formats results as structured context
  - [x] 1.3 Format results as markdown: bubble title, content preview, tags, provenance tier label. Include `bubbleId` references for drill-down
  - [x] 1.4 Return `null` when retrieval returns zero results (AC #4 — no empty placeholder)
  - [x] 1.5 Token budget default: 2000 tokens for context injection (separate from the retrieval engine's 4000 default). Configurable via `RAVEN_KNOWLEDGE_CONTEXT_BUDGET`

- [x] Task 2: Prompt builder integration (AC: #2, #4)
  - [x] 2.1 Modify `buildSystemPrompt()` in `packages/core/src/agent-manager/prompt-builder.ts` to accept optional `knowledgeContext: string` parameter
  - [x] 2.2 When `knowledgeContext` is non-empty, add `## Relevant Knowledge` section before the existing `## Project Context` section
  - [x] 2.3 When `knowledgeContext` is null/undefined/empty, skip the section entirely (no placeholder)

- [x] Task 3: Pervasive orchestrator context injection (AC: #2, #3, #4, #5)
  - [x] 3.1 Add `contextInjector` to `OrchestratorDeps` interface
  - [x] 3.2 Make ALL three handlers async: `handleUserChat()`, `handleNewEmail()`, `handleSchedule()` — each calls `contextInjector.retrieveContext()` before emitting `agent:task:request`
  - [x] 3.3 `handleUserChat()`: inject context from user message text
  - [x] 3.4 `handleNewEmail()`: inject context from email subject + sender + snippet
  - [x] 3.5 `handleSchedule()`: inject context from schedule name + task type
  - [x] 3.6 Wrap all async handlers with `.catch()` since EventBus handler type `(event: T) => void` accepts async functions but won't await them
  - [x] 3.7 Add retrieved context string to the task payload via `knowledgeContext` field on `agent:task:request` event payload

- [x] Task 4: Agent session context wiring (AC: #2)
  - [x] 4.1 In `runAgentTask()` in `agent-session.ts`: read `knowledgeContext` from task and pass to `buildSystemPrompt()`
  - [x] 4.2 The `AgentTask` type already has all needed fields — pass `knowledgeContext` through the event → task → prompt pipeline

- [x] Task 5: Knowledge management agent definition (AC: #1, #6)
  - [x] 5.1 Create `packages/core/src/knowledge-engine/knowledge-agent.ts` — factory function `createKnowledgeAgentDefinition(port)`
  - [x] 5.2 Define the knowledge agent as a `SubAgentDefinition` with a comprehensive system prompt describing all available operations
  - [x] 5.3 The agent uses `WebFetch` to call the local knowledge REST API (`http://localhost:${port}/api/knowledge/*`) for CRUD and management operations
  - [x] 5.4 The knowledge agent's prompt lists all available endpoints with example payloads for: search, get, create, update, delete, link, tag, domain, permanence, merge resolution

- [x] Task 6: Knowledge agent registration (AC: #1)
  - [x] 6.1 Instead of modifying `SuiteRegistry`, inject the knowledge agent definition directly in the orchestrator's `handleUserChat()` by merging into `agentDefinitions`
  - [x] 6.2 Add `port` to `OrchestratorDeps` interface (API server port, needed for knowledge agent WebFetch URL)
  - [x] 6.3 Pass port from boot sequence (`index.ts`) to Orchestrator constructor

- [x] Task 6.5: Reference tracking for frontend (AC: #7)
  - [x] 6.5.1 Add `'context'` to the `StoredMessage` role union type in `message-store.ts`
  - [x] 6.5.2 In `agent-manager.ts` `runTask()`: before calling `runAgentTask()`, if `task.knowledgeContext` exists and `sessionId` is set, store a `role='context'` message with content
  - [x] 6.5.3 Add `GET /api/sessions/:id/references` endpoint in `sessions.ts`: read transcript, filter `role === 'context'` messages, parse `[ref:]` markers, deduplicate by `bubbleId`, return grouped by `taskId`

- [x] Task 7: Event types and shared types (AC: all)
  - [x] 7.1 Add `knowledgeContext?: string` field to `AgentTaskRequestEvent` payload in `packages/shared/src/types/events.ts`
  - [x] 7.2 Add `knowledgeContext?: string` to `AgentTask` in `packages/shared/src/types/agents.ts`
  - [x] 7.3 Add `KnowledgeReference` interface to `packages/shared/src/types/knowledge.ts`
  - [x] 7.4 Add `KnowledgeContext` interface
  - [x] 7.5 Add `ContextInjectionOptions` interface

- [x] Task 8: Tests (AC: all)
  - [x] 8.1 Unit tests for context-injector: mock retrieval engine, verify formatted output, verify null on empty results, verify token budget respected
  - [x] 8.2 Unit tests for prompt-builder changes: verify knowledge section appears when provided, absent when null
  - [x] 8.3 Integration test for orchestrator context injection: mock retrieval engine + event bus, send user:chat:message, verify agent:task:request includes knowledgeContext
  - [x] 8.4 Integration test: verify all three handlers (chat, email, schedule) inject context pervasively
  - [x] 8.5 Integration test for knowledge agent definition: verify agent definition is merged into agentDefinitions in handleUserChat()
  - [x] 8.6 Integration test for knowledge agent WebFetch operations: verify agent prompt includes correct endpoint documentation
  - [x] 8.7 Test reference tracking: verify `role='context'` message stored
  - [x] 8.8 Test empty knowledge base: no errors, no knowledge section in prompt

## Dev Notes

### Core Design: Two-Part Architecture

Story 6.5 has two distinct components:

1. **Pervasive Context Injection** (passive, automatic) — **Every** agent task gets relevant knowledge injected into its system prompt — not just explicit knowledge queries. When the user says "do you remember...", asks for help with an email, or triggers any scheduled task, relevant knowledge automatically surfaces. This is the "second brain" capability.
2. **Knowledge Management Agent** (active, conversational) — A dedicated sub-agent the orchestrator delegates to when the user wants to search, browse, organize, or manage their knowledge base.
3. **Reference Tracking** — Injected knowledge references are stored as `role: 'context'` messages in the session transcript, enabling the frontend (story 6.8) to display which knowledge bubbles informed each response.

### Context Injection Architecture

```
ANY event (user chat, new email, scheduled task)
     ↓
Orchestrator handler (handleUserChat / handleNewEmail / handleSchedule)
     ↓  (all three are async, wrapped with .catch())
contextInjector.retrieveContext(queryText, { tokenBudget: 2000 })
  - chat: query = user message text
  - email: query = subject + sender + snippet
  - schedule: query = schedule name + task type
     ↓
retrievalEngine.search(query, { tokenBudget: 2000 })
     ↓
Format results as markdown string (or null if empty)
     ↓
Attach to agent:task:request payload as knowledgeContext
     ↓
agent-manager.ts enqueue() → copies knowledgeContext to AgentTask
     ↓
agent-manager.ts runTask() → stores role='context' message in session transcript
     ↓
agent-session.ts → buildSystemPrompt(task, project, knowledgeContext)
     ↓
System prompt includes "## Relevant Knowledge" section
     ↓
Claude agent sees knowledge context and can reference it
```

**context-injector.ts implementation:**

```typescript
import type { RetrievalEngine } from './retrieval.ts';
import type { KnowledgeContext, ContextInjectionOptions } from '@raven/shared';

const DEFAULT_CONTEXT_BUDGET = 2000;
const DEFAULT_MIN_SCORE = 0.3;

interface ContextInjectorDeps {
  retrievalEngine: RetrievalEngine;
}

export type ContextInjector = ReturnType<typeof createContextInjector>;

export function createContextInjector(deps: ContextInjectorDeps) {
  async function retrieveContext(
    query: string,
    options?: ContextInjectionOptions,
  ): Promise<KnowledgeContext | null> {
    const budget = options?.tokenBudget ?? DEFAULT_CONTEXT_BUDGET;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;

    const result = await deps.retrievalEngine.search(query, {
      tokenBudget: budget,
      limit: 10,
    });

    const filtered = result.results.filter(r => r.score >= minScore);
    if (filtered.length === 0) return null;

    return {
      results: filtered.map(r => ({
        bubbleId: r.bubbleId,
        title: r.title,
        snippet: r.chunkText ?? r.contentPreview,
        score: r.score,
        tierName: r.provenance.tierName,
        tags: r.tags,
      })),
      tokenBudgetUsed: result.tokenBudgetUsed,
      query,
    };
  }

  function formatContext(ctx: KnowledgeContext): string {
    const lines: string[] = [];
    for (const item of ctx.results) {
      lines.push(`### ${item.title}`);
      lines.push(`Tags: ${item.tags.join(', ') || 'none'} | Score: ${item.score.toFixed(2)} | Source: ${item.tierName}`);
      lines.push(item.snippet);
      lines.push(`[ref: ${item.bubbleId}]`);
      lines.push('');
    }
    return lines.join('\n');
  }

  return { retrieveContext, formatContext };
}
```

### prompt-builder.ts Changes

```typescript
export function buildSystemPrompt(
  task: AgentTask,
  project?: Project,
  knowledgeContext?: string,
): string {
  // ... existing parts ...

  // Insert BEFORE project context section
  if (knowledgeContext) {
    parts.push(
      '',
      '## Relevant Knowledge',
      'The following information from your knowledge base may be relevant:',
      '',
      knowledgeContext,
    );
  }

  if (project?.systemPrompt) {
    parts.push('', '## Project Context', project.systemPrompt);
  }

  return parts.join('\n');
}
```

### Orchestrator Changes

```typescript
// In OrchestratorDeps:
export interface OrchestratorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  sessionManager: SessionManager;
  messageStore: MessageStore;
  contextInjector?: ContextInjector; // NEW — optional for backward compat
  port: number; // NEW — API server port for knowledge agent WebFetch URL
}

// All three handlers become async, wrapped with .catch():
// In constructor/init:
this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => {
  this.handleUserChat(e).catch(err => log.error({ err }, 'handleUserChat failed'));
});
this.eventBus.on<NewEmailEvent>('email:new', (e) => {
  this.handleNewEmail(e).catch(err => log.error({ err }, 'handleNewEmail failed'));
});
this.eventBus.on<ScheduleEvent>('schedule:trigger', (e) => {
  this.handleSchedule(e).catch(err => log.error({ err }, 'handleSchedule failed'));
});

// In handleUserChat():
private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
  // ... existing code ...

  // NEW: Retrieve knowledge context (pervasive — runs on EVERY chat)
  let knowledgeContext: string | undefined;
  if (this.contextInjector) {
    try {
      const ctx = await this.contextInjector.retrieveContext(message);
      if (ctx) {
        knowledgeContext = this.contextInjector.formatContext(ctx);
      }
    } catch (err) {
      log.warn({ err }, 'Knowledge context retrieval failed, proceeding without');
    }
  }

  // NEW: Merge knowledge agent into agentDefinitions (no SuiteRegistry changes needed)
  const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
  agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition(this.port);

  this.eventBus.emit({
    // ... existing fields ...
    payload: {
      // ... existing payload ...
      knowledgeContext, // NEW field
      agentDefinitions, // NOW includes knowledge agent
    },
  });
}

// handleNewEmail() — same pattern, different query construction:
private async handleNewEmail(event: NewEmailEvent): Promise<void> {
  // ... existing code ...
  const query = `${event.payload.subject} ${event.payload.sender} ${event.payload.snippet}`;
  let knowledgeContext: string | undefined;
  if (this.contextInjector) {
    try {
      const ctx = await this.contextInjector.retrieveContext(query);
      if (ctx) knowledgeContext = this.contextInjector.formatContext(ctx);
    } catch (err) {
      log.warn({ err }, 'Knowledge context retrieval failed for email');
    }
  }
  // ... emit with knowledgeContext ...
}

// handleSchedule() — same pattern:
private async handleSchedule(event: ScheduleEvent): Promise<void> {
  // ... existing code ...
  const query = `${event.payload.scheduleName} ${event.payload.taskType}`;
  // ... same context injection pattern ...
}
```

### Knowledge Management Agent

The knowledge agent is a `SubAgentDefinition` injected directly into `agentDefinitions` by the orchestrator (no `SuiteRegistry` changes needed). It uses `WebFetch` to call the local knowledge REST API.

**knowledge-agent.ts:**

```typescript
import type { SubAgentDefinition } from '@raven/shared';

export function createKnowledgeAgentDefinition(port: number): SubAgentDefinition {
  const baseUrl = `http://localhost:${port}`;
  return {
    description: 'Knowledge management agent — search, browse, organize, and manage your knowledge base. Delegate here when the user wants to find information in their knowledge, manage tags/links/domains, or organize their second brain.',
    prompt: buildKnowledgeAgentPrompt(baseUrl),
    tools: ['WebFetch', 'Read'],
  };
}
```

The knowledge agent prompt should include:
- All knowledge API endpoints with methods, paths, request/response shapes
- Instructions for using `WebFetch` to call the local API
- Formatting guidelines for presenting search results
- Instructions for management operations (link, tag, domain, permanence, merge)

### Knowledge Agent Registration (No SuiteRegistry Changes)

Instead of modifying `SuiteRegistry`, the knowledge agent is injected directly in the orchestrator's `handleUserChat()`:

```typescript
// In orchestrator handleUserChat():
const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition(this.port);
```

### Boot Sequence Changes (index.ts)

```typescript
// Pass port to orchestrator deps:
const orchestrator = createOrchestrator({
  // ... existing deps ...
  contextInjector,
  port: config.RAVEN_PORT,
});
```

### Event Type Changes

In `packages/shared/src/types/events.ts`, add `knowledgeContext` to the `AgentTaskRequestEvent` payload:

```typescript
export interface AgentTaskRequestEvent extends BaseEvent {
  type: 'agent:task:request';
  payload: {
    taskId: string;
    prompt: string;
    skillName: string;
    mcpServers?: Record<string, McpServerConfig>;
    agentDefinitions?: Record<string, SubAgentDefinition>;
    knowledgeContext?: string; // NEW
    priority: Priority;
    sessionId?: string;
    projectId?: string;
  };
}
```

### Agent Session Changes

In `runAgentTask()`, pass knowledge context to the prompt builder:

```typescript
// Read knowledgeContext from task (propagated from event payload → agent task)
const systemPrompt = buildSystemPrompt(task, undefined, task.knowledgeContext);
```

The `AgentTask` interface needs `knowledgeContext?: string` added. Check where tasks are created from events — the `agent-manager.ts` or wherever `agent:task:request` events are consumed and converted to `AgentTask` objects.

### Agent Manager Reference Tracking

In `agent-manager.ts` `runTask()`, before calling `runAgentTask()`:

```typescript
// Store context references in session transcript for frontend visibility
if (task.knowledgeContext && task.sessionId) {
  this.messageStore.addMessage(task.sessionId, {
    role: 'context',
    content: task.knowledgeContext, // raw context string with [ref: bubbleId] markers
    taskId: task.id,
  });
}
```

### StoredMessage Changes (message-store.ts)

Add `'context'` to the role union:

```typescript
export interface StoredMessage {
  role: 'user' | 'assistant' | 'system' | 'context'; // 'context' is NEW
  content: string;
  taskId?: string; // NEW — links context to the task that triggered it
  timestamp: number;
}
```

### References API Endpoint (sessions.ts)

```typescript
// GET /sessions/:id/references
// Returns knowledge references injected during the session, grouped by task
fastify.get('/sessions/:id/references', async (request) => {
  const messages = messageStore.getMessages(id);
  const contextMessages = messages.filter(m => m.role === 'context');
  // Parse [ref: bubbleId] markers from content, extract reference metadata
  // Deduplicate by bubbleId, group by taskId
  return { references: grouped };
});
```

### Reuse from Existing Code — DO NOT REINVENT

| What | Where | How to reuse |
|------|-------|-------------|
| `RetrievalEngine.search()` | `retrieval.ts` | Direct call for context injection |
| `classifyQuery()` | `retrieval.ts` | Already classifies query type |
| Token budget assembly | `retrieval.ts` | Already handles budget in search results |
| Permanence weighting | `retrieval.ts` | Already applies permanence weights (0.9/1.0/1.2) |
| All knowledge API routes | `api/routes/knowledge.ts` | Knowledge agent uses these via WebFetch |
| `SubAgentDefinition` type | `shared/types/events.ts` | For agent definition |
| `buildSystemPrompt()` | `prompt-builder.ts` | Extend with knowledge context param |
| `EventBus` async pattern | `orchestrator.ts` | Follow `.catch()` pattern for async handlers |
| Factory function pattern | All knowledge engine files | Follow for `createContextInjector(deps)` |

### What NOT to Build

- No MCP server for knowledge operations — the agent uses WebFetch to call REST API instead (simpler, avoids MCP overhead for in-process functionality)
- No LLM-based query routing to decide "is this a knowledge question?" — the orchestrator delegates via Agent tool, Claude decides when to use the knowledge agent based on its description
- No custom tool framework — WebFetch to localhost REST API is sufficient
- No SuiteRegistry modifications — knowledge agent is injected directly in the orchestrator
- No knowledge dashboard UI changes — that's story 6.7
- No frontend reference panel or project memory editor — that's story 6.8
- No stale detection or lifecycle management — that's story 6.6
- No cross-domain connection detection — that's story 9.1
- No changes to the retrieval engine scoring — it already handles recency via `updatedAt` and permanence weights
- No caching of context injection results — premature optimization

### Testing Approach

- **Mock `retrieval.ts`** — return deterministic search results for context injector tests
- **Mock `EventBus`** — verify events emitted with correct `knowledgeContext` field
- **Test context-injector** with various scenarios: results found, no results, token budget exceeded, low-score filtering
- **Test prompt-builder** changes: knowledge section present when provided, absent when null/undefined
- **Test orchestrator async flow**: verify `handleUserChat` properly awaits context retrieval and attaches results
- **Test knowledge agent injection**: verify `handleUserChat()` merges knowledge agent into agentDefinitions
- **Test knowledge agent definition**: verify prompt includes all API endpoints and WebFetch instructions
- **Test reference tracking**: verify `role='context'` message stored in transcript, verify `GET /sessions/:id/references` endpoint returns grouped refs
- **Test error handling**: context retrieval failure should not block agent task execution (graceful degradation)

### Previous Story Intelligence (from 6.4)

**Patterns to follow:**
- Factory function: `createRetrievalEngine(deps)` → follow for `createContextInjector(deps)`
- Event-driven processing with `.catch()` on fire-and-forget async handlers
- Code review fixes from 6.4 to avoid repeating:
  - Always pass explicit parameters through the chain (don't rely on implicit defaults)
  - Add `.catch()` to all fire-and-forget async handlers
  - Guard against undefined variables in test cleanup
  - Use `try/catch` around retrieval calls — failures should degrade gracefully, never crash

**Libraries already installed (no new deps needed):**
- `@huggingface/transformers` — embedding pipeline (used by retrieval engine internally)
- `neo4j-driver` — Neo4j client (used by retrieval engine internally)
- All knowledge engine modules are already operational

### Git Intelligence

Recent commits show the knowledge engine evolution:
1. `27af742` — Migrated from SQLite to Neo4j (story 6.3 scope expansion)
2. `19579de` — Intelligence engine with embeddings, clustering, tag hierarchy
3. `d277e58` — Ingestion pipeline with AI metadata
4. `7fc9bdd` — Bubble storage and CRUD with file-first architecture

Uncommitted changes from stories 6.3 and 6.4 include: clustering, embeddings, chunking, retrieval, API routes, Neo4j client updates, shared types. These are all in working state and should be committed before starting 6.5.

### File Structure

```
packages/core/src/knowledge-engine/
├── context-injector.ts        # NEW — retrieves and formats knowledge for prompt injection
├── knowledge-agent.ts         # NEW — knowledge management sub-agent definition
├── retrieval.ts               # NO CHANGES (used by context-injector)
├── chunking.ts                # NO CHANGES
├── embeddings.ts              # NO CHANGES
├── neo4j-client.ts            # NO CHANGES
├── knowledge-store.ts         # NO CHANGES
├── clustering.ts              # NO CHANGES
├── ... (other unchanged files)

packages/core/src/
├── agent-manager/
│   ├── agent-manager.ts       # MODIFY — copy knowledgeContext to AgentTask, store role='context' message
│   ├── agent-session.ts       # MODIFY — pass knowledgeContext to buildSystemPrompt()
│   └── prompt-builder.ts      # MODIFY — add knowledgeContext parameter and section
├── orchestrator/
│   └── orchestrator.ts        # MODIFY — add contextInjector+port deps, make ALL handlers async, inject context pervasively, merge knowledge agent
├── session-manager/
│   └── message-store.ts       # MODIFY — add 'context' to StoredMessage role union, add taskId field
├── api/routes/
│   └── sessions.ts            # MODIFY — add GET /sessions/:id/references endpoint
├── index.ts                   # MODIFY — wire context-injector, pass port to orchestrator

packages/shared/src/types/
├── events.ts                  # MODIFY — add knowledgeContext to AgentTaskRequestEvent payload
├── agents.ts                  # MODIFY — add knowledgeContext to AgentTask
├── knowledge.ts               # MODIFY — add KnowledgeReference, KnowledgeContext, ContextInjectionOptions types
```

### Existing Code to Understand

| File | Why |
|------|-----|
| `packages/core/src/knowledge-engine/retrieval.ts` | Context injector calls `search()` directly |
| `packages/core/src/agent-manager/prompt-builder.ts` | Extend with knowledge context section |
| `packages/core/src/agent-manager/agent-session.ts` | Wire knowledge context through to prompt builder |
| `packages/core/src/orchestrator/orchestrator.ts` | Add async context retrieval to ALL handlers, merge knowledge agent into agentDefinitions |
| `packages/core/src/session-manager/message-store.ts` | Add 'context' role for reference tracking |
| `packages/core/src/api/routes/sessions.ts` | Add GET /sessions/:id/references endpoint |
| `packages/core/src/index.ts` | Wire context injector, pass port to orchestrator |
| `packages/core/src/api/routes/knowledge.ts` | Knowledge agent's WebFetch target — review all endpoints |
| `packages/shared/src/types/events.ts` | Add knowledgeContext field to task request payload |
| `packages/shared/src/types/knowledge.ts` | Add new context types |
| `packages/core/src/agent-manager/agent-manager.ts` | Where agent:task:request events are consumed → verify knowledgeContext propagates to AgentTask |

### Project Structure Notes

- `context-injector.ts` and `knowledge-agent.ts` are new files in `packages/core/src/knowledge-engine/`
- Extend `packages/shared/src/types/knowledge.ts` with 3 new interfaces (`KnowledgeReference`, `KnowledgeContext`, `ContextInjectionOptions`)
- Extend `packages/shared/src/types/events.ts` with 1 new field on existing type
- Extend `packages/shared/src/types/agents.ts` with 1 new field on existing type
- Modify 7 existing files: `prompt-builder.ts`, `agent-session.ts`, `orchestrator.ts`, `agent-manager.ts`, `message-store.ts`, `sessions.ts`, `index.ts`
- No SuiteRegistry changes — knowledge agent injected directly in orchestrator
- New tests: `packages/core/src/__tests__/knowledge-context.test.ts`
- Keep files under 300 lines — `knowledge-agent.ts` prompt builder may be verbose; keep prompt as a template string, not embedded logic

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 6 — Story 6.5 acceptance criteria]
- [Source: _bmad-output/planning-artifacts/architecture.md — Knowledge Management FR42-48, context injection cross-cutting concern]
- [Source: _bmad-output/planning-artifacts/prd.md — FR45: Sub-agents can query the knowledge layer for context injection]
- [Source: _bmad-output/implementation-artifacts/6-4-knowledge-retrieval-engine-and-full-content-indexing.md — retrieval engine, multi-tier search, token budget]
- [Source: _bmad-output/project-context.md — MCP isolation, event bus patterns, factory functions]
- [Source: packages/core/src/knowledge-engine/retrieval.ts — search(), RetrievalResult, token budget assembly]
- [Source: packages/core/src/agent-manager/prompt-builder.ts — buildSystemPrompt() current signature]
- [Source: packages/core/src/orchestrator/orchestrator.ts — handleUserChat(), event emission pattern]
- [Source: packages/core/src/suite-registry/suite-registry.ts — collectAgentDefinitions(), agent registration]
- [Source: packages/core/src/agent-manager/agent-session.ts — runAgentTask(), AgentTask consumption]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Implemented pervasive context injection: all three orchestrator handlers (chat, email, schedule) now async with automatic knowledge retrieval
- Created context injector module with configurable token budget (default 2000, env var override)
- Built knowledge management agent as SubAgentDefinition using WebFetch to call local REST API (no MCP needed)
- Knowledge agent injected directly in orchestrator handleUserChat() — no SuiteRegistry changes
- Added reference tracking: role='context' messages stored in session transcript, GET /sessions/:id/references API
- Added 3 shared types: KnowledgeReference, KnowledgeContext, ContextInjectionOptions
- Extended AgentTaskRequestEvent and AgentTask with knowledgeContext field
- Moved orchestrator initialization after retrieval engine in boot sequence
- All 21 new tests pass, 696 total tests pass, 0 regressions
- npm run check passes (format + lint + tsc)

### Change Log

- 2026-03-17: Story 6.5 implemented — knowledge management agent and pervasive context injection

### File List

**New files:**
- packages/core/src/knowledge-engine/context-injector.ts
- packages/core/src/knowledge-engine/knowledge-agent.ts
- packages/core/src/__tests__/knowledge-context.test.ts

**Modified files:**
- packages/shared/src/types/knowledge.ts — added KnowledgeReference, KnowledgeContext, ContextInjectionOptions
- packages/shared/src/types/events.ts — added knowledgeContext to AgentTaskRequestEvent payload
- packages/shared/src/types/agents.ts — added knowledgeContext to AgentTask
- packages/core/src/agent-manager/prompt-builder.ts — added knowledgeContext parameter to buildSystemPrompt()
- packages/core/src/agent-manager/agent-session.ts — pass knowledgeContext to buildSystemPrompt()
- packages/core/src/agent-manager/agent-manager.ts — copy knowledgeContext to AgentTask, store role='context' message
- packages/core/src/orchestrator/orchestrator.ts — added contextInjector+port deps, async handlers with .catch(), pervasive context injection, knowledge agent merging
- packages/core/src/session-manager/message-store.ts — added 'context' to StoredMessage role union
- packages/core/src/api/routes/sessions.ts — added GET /sessions/:id/references endpoint
- packages/core/src/index.ts — wire contextInjector, move orchestrator after retrieval engine
- packages/core/src/__tests__/orchestrator.test.ts — added port to OrchestratorDeps
- packages/core/src/__tests__/e2e.test.ts — added port to OrchestratorDeps
- packages/core/src/__tests__/prompt-builder.test.ts — added knowledge context tests
