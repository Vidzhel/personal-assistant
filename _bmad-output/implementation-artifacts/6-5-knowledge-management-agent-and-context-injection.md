# Story 6.5: Knowledge Management Agent & Context Injection

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want a dedicated knowledge management agent that can retrieve, update, organize, and inject relevant knowledge into any sub-agent's context,
so that Raven acts as my second brain — searchable, conversational, and always providing relevant context.

## Acceptance Criteria

1. **Orchestrator routes to knowledge agent**: Given the user asks Raven about a topic in their knowledge base, when the orchestrator routes to the knowledge agent, then the agent uses the multi-tier retrieval engine to find relevant bubbles, presents organized results with references, and can update/link/tag bubbles conversationally.

2. **Context injection into sub-agent prompts**: Given a sub-agent task about "SQLite backup strategies", when the prompt builder prepares the prompt, then relevant knowledge is retrieved by the retrieval engine and injected as context.

3. **Token budget enforcement**: Given the knowledge retrieval finds 10 relevant bubbles, when the token budget is 2000 tokens, then only the top-ranked bubbles (by embedding similarity + recency + permanence weight) fitting within the budget are injected.

4. **Empty results — no placeholder**: Given no relevant knowledge exists for a task, when retrieval returns empty results, then no knowledge section is added to the prompt (no empty placeholder).

5. **Recency and permanence weighting**: Given a knowledge bubble was updated recently, when relevance scoring runs, then recency is factored in — newer relevant bubbles rank higher; `robust` permanence bubbles get a retrieval boost.

6. **Conversational knowledge management**: Given the user asks the knowledge agent to organize or link bubbles, when the agent processes the request, then it can create/remove links, reassign domains, adjust permanence, merge bubbles, and update tags through the knowledge store API.

## Tasks / Subtasks

- [ ] Task 1: Context injector module (AC: #2, #3, #4, #5)
  - [ ] 1.1 Create `packages/core/src/knowledge-engine/context-injector.ts` — factory function `createContextInjector(deps)`
  - [ ] 1.2 Implement `retrieveContext(query: string, options?: ContextInjectionOptions): Promise<KnowledgeContext | null>` — calls retrieval engine, formats results as structured context
  - [ ] 1.3 Format results as markdown: bubble title, content preview, tags, provenance tier label. Include `bubbleId` references for drill-down
  - [ ] 1.4 Return `null` when retrieval returns zero results (AC #4 — no empty placeholder)
  - [ ] 1.5 Token budget default: 2000 tokens for context injection (separate from the retrieval engine's 4000 default). Configurable via `RAVEN_KNOWLEDGE_CONTEXT_BUDGET`

- [ ] Task 2: Prompt builder integration (AC: #2, #4)
  - [ ] 2.1 Modify `buildSystemPrompt()` in `packages/core/src/agent-manager/prompt-builder.ts` to accept optional `knowledgeContext: string` parameter
  - [ ] 2.2 When `knowledgeContext` is non-empty, add `## Relevant Knowledge` section before the existing `## Project Context` section
  - [ ] 2.3 When `knowledgeContext` is null/undefined/empty, skip the section entirely (no placeholder)

- [ ] Task 3: Orchestrator context injection (AC: #2, #3, #4, #5)
  - [ ] 3.1 Add `contextInjector` to `OrchestratorDeps` interface
  - [ ] 3.2 In `handleUserChat()`: before emitting `agent:task:request`, call `contextInjector.retrieveContext(message)` asynchronously
  - [ ] 3.3 Add retrieved context string to the task payload via a new `knowledgeContext` field on the `agent:task:request` event payload
  - [ ] 3.4 In `handleSchedule()` and `handleNewEmail()`: also inject context when relevant (schedule tasks may benefit from knowledge context about the scheduled topic)

- [ ] Task 4: Agent session context wiring (AC: #2)
  - [ ] 4.1 In `runAgentTask()` in `agent-session.ts`: read `knowledgeContext` from task and pass to `buildSystemPrompt()`
  - [ ] 4.2 The `AgentTask` type already has all needed fields — pass `knowledgeContext` through the event → task → prompt pipeline

- [ ] Task 5: Knowledge management agent definition (AC: #1, #6)
  - [ ] 5.1 Create `packages/core/src/knowledge-engine/knowledge-agent.ts` — factory function `createKnowledgeAgent(deps)`
  - [ ] 5.2 Define the knowledge agent as a `SubAgentDefinition` with a comprehensive system prompt describing all available operations
  - [ ] 5.3 The agent uses `WebFetch` to call the local knowledge REST API (`http://localhost:${port}/api/knowledge/*`) for CRUD and management operations
  - [ ] 5.4 Register the agent definition in the boot sequence so it's included in `suiteRegistry.collectAgentDefinitions()` results
  - [ ] 5.5 The knowledge agent's prompt lists all available endpoints with example payloads for: search, get, create, update, delete, link, tag, domain, permanence, merge resolution

- [ ] Task 6: Knowledge agent registration (AC: #1)
  - [ ] 6.1 Add method `registerBuiltInAgent(name: string, definition: SubAgentDefinition)` to `SuiteRegistry`
  - [ ] 6.2 In boot sequence (`index.ts`): call `suiteRegistry.registerBuiltInAgent('knowledge', knowledgeAgentDef)` after API server starts (agent needs the port)
  - [ ] 6.3 `collectAgentDefinitions()` must include built-in agents alongside suite agents

- [ ] Task 7: Event types and shared types (AC: all)
  - [ ] 7.1 Add `knowledgeContext?: string` field to `AgentTaskRequestEvent` payload in `packages/shared/src/types/events.ts`
  - [ ] 7.2 Add `KnowledgeContext` interface to `packages/shared/src/types/knowledge.ts`: `{ results: KnowledgeContextItem[]; tokenBudgetUsed: number; query: string }`
  - [ ] 7.3 Add `KnowledgeContextItem` interface: `{ bubbleId: string; title: string; snippet: string; score: number; tierName: string; tags: string[] }`
  - [ ] 7.4 Add `ContextInjectionOptions` interface: `{ tokenBudget?: number; minScore?: number }`

- [ ] Task 8: Tests (AC: all)
  - [ ] 8.1 Unit tests for context-injector: mock retrieval engine, verify formatted output, verify null on empty results, verify token budget respected
  - [ ] 8.2 Unit tests for prompt-builder changes: verify knowledge section appears when provided, absent when null
  - [ ] 8.3 Integration test for orchestrator context injection: mock retrieval engine + event bus, send user:chat:message, verify agent:task:request includes knowledgeContext
  - [ ] 8.4 Integration test for knowledge agent definition: verify agent definition is registered and included in collectAgentDefinitions()
  - [ ] 8.5 Integration test for knowledge agent WebFetch operations: mock the API server, verify agent prompt includes correct endpoint documentation
  - [ ] 8.6 Test empty knowledge base: no errors, no knowledge section in prompt

## Dev Notes

### Core Design: Two-Part Architecture

Story 6.5 has two distinct components:

1. **Context Injection** (passive, automatic) — Every agent task gets relevant knowledge injected into its system prompt. This is the "second brain" capability.
2. **Knowledge Management Agent** (active, conversational) — A dedicated sub-agent the orchestrator delegates to when the user wants to search, browse, organize, or manage their knowledge base.

### Context Injection Architecture

```
User chat message
     ↓
Orchestrator.handleUserChat()
     ↓
contextInjector.retrieveContext(message, { tokenBudget: 2000 })
     ↓
retrievalEngine.search(message, { tokenBudget: 2000 })
     ↓
Format results as markdown string (or null if empty)
     ↓
Attach to agent:task:request payload as knowledgeContext
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
}

// In handleUserChat():
private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
  // ... existing code ...

  // NEW: Retrieve knowledge context
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

  this.eventBus.emit({
    // ... existing fields ...
    payload: {
      // ... existing payload ...
      knowledgeContext, // NEW field
    },
  });
}
```

**CRITICAL**: The `handleUserChat` method signature changes from sync `void` to `async Promise<void>`. The event bus `.on()` handler must accommodate async handlers — verify this works with `void` return in the `on()` type. If the event bus handler doesn't await, wrap with `.catch()`:
```typescript
this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => {
  this.handleUserChat(e).catch(err => log.error({ err }, 'handleUserChat failed'));
});
```

### Knowledge Management Agent

The knowledge agent is a `SubAgentDefinition` registered as a built-in agent (not from a skill/suite). It uses `WebFetch` to call the local knowledge REST API.

**knowledge-agent.ts:**

```typescript
import type { SubAgentDefinition } from '@raven/shared';

interface KnowledgeAgentDeps {
  port: number; // API server port
}

export function createKnowledgeAgentDefinition(deps: KnowledgeAgentDeps): SubAgentDefinition {
  const baseUrl = `http://localhost:${deps.port}`;
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

### SuiteRegistry Changes

```typescript
// In SuiteRegistry class:
private builtInAgents = new Map<string, SubAgentDefinition>();

registerBuiltInAgent(name: string, definition: SubAgentDefinition): void {
  this.builtInAgents.set(name, definition);
}

collectAgentDefinitions(suiteNames?: string[]): Record<string, SubAgentDefinition> {
  const defs: Record<string, SubAgentDefinition> = {};

  // Include built-in agents
  for (const [name, def] of this.builtInAgents) {
    defs[name] = def;
  }

  // ... existing suite agent collection ...
  return defs;
}
```

### Boot Sequence Changes (index.ts)

```typescript
// After API server starts and port is known:
const knowledgeAgentDef = createKnowledgeAgentDefinition({ port: config.RAVEN_PORT });
suiteRegistry.registerBuiltInAgent('knowledge', knowledgeAgentDef);
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

### Reuse from Existing Code — DO NOT REINVENT

| What | Where | How to reuse |
|------|-------|-------------|
| `RetrievalEngine.search()` | `retrieval.ts` | Direct call for context injection |
| `classifyQuery()` | `retrieval.ts` | Already classifies query type |
| Token budget assembly | `retrieval.ts` | Already handles budget in search results |
| Permanence weighting | `retrieval.ts` | Already applies permanence weights (0.9/1.0/1.2) |
| All knowledge API routes | `api/routes/knowledge.ts` | Knowledge agent uses these via WebFetch |
| `SubAgentDefinition` type | `shared/types/events.ts` | For agent definition |
| `SuiteRegistry` | `suite-registry.ts` | Add built-in agent support |
| `buildSystemPrompt()` | `prompt-builder.ts` | Extend with knowledge context param |
| `EventBus` async pattern | `orchestrator.ts` | Follow `.catch()` pattern for async handlers |
| Factory function pattern | All knowledge engine files | Follow for `createContextInjector(deps)` |

### What NOT to Build

- No MCP server for knowledge operations — the agent uses WebFetch to call REST API instead (simpler, avoids MCP overhead for in-process functionality)
- No LLM-based query routing to decide "is this a knowledge question?" — the orchestrator delegates via Agent tool, Claude decides when to use the knowledge agent based on its description
- No custom tool framework — WebFetch to localhost REST API is sufficient
- No knowledge dashboard UI changes — that's story 6.7
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
- **Test suite registry**: verify `registerBuiltInAgent()` works and `collectAgentDefinitions()` includes built-in agents
- **Test knowledge agent definition**: verify prompt includes all API endpoints and WebFetch instructions
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
│   ├── agent-session.ts       # MODIFY — pass knowledgeContext to buildSystemPrompt()
│   └── prompt-builder.ts      # MODIFY — add knowledgeContext parameter and section
├── orchestrator/
│   └── orchestrator.ts        # MODIFY — add contextInjector dep, async handleUserChat, inject context
├── suite-registry/
│   └── suite-registry.ts      # MODIFY — add registerBuiltInAgent(), include in collectAgentDefinitions()
├── index.ts                   # MODIFY — wire context-injector, register knowledge agent

packages/shared/src/types/
├── events.ts                  # MODIFY — add knowledgeContext to AgentTaskRequestEvent payload
├── knowledge.ts               # MODIFY — add KnowledgeContext, KnowledgeContextItem, ContextInjectionOptions types
```

### Existing Code to Understand

| File | Why |
|------|-----|
| `packages/core/src/knowledge-engine/retrieval.ts` | Context injector calls `search()` directly |
| `packages/core/src/agent-manager/prompt-builder.ts` | Extend with knowledge context section |
| `packages/core/src/agent-manager/agent-session.ts` | Wire knowledge context through to prompt builder |
| `packages/core/src/orchestrator/orchestrator.ts` | Add async context retrieval before task emission |
| `packages/core/src/suite-registry/suite-registry.ts` | Add built-in agent registration |
| `packages/core/src/index.ts` | Wire context injector and knowledge agent in boot sequence |
| `packages/core/src/api/routes/knowledge.ts` | Knowledge agent's WebFetch target — review all endpoints |
| `packages/shared/src/types/events.ts` | Add knowledgeContext field to task request payload |
| `packages/shared/src/types/knowledge.ts` | Add new context types |
| `packages/core/src/agent-manager/agent-manager.ts` | Where agent:task:request events are consumed → verify knowledgeContext propagates to AgentTask |

### Project Structure Notes

- `context-injector.ts` and `knowledge-agent.ts` are new files in `packages/core/src/knowledge-engine/`
- Extend `packages/shared/src/types/knowledge.ts` with 3 new interfaces
- Extend `packages/shared/src/types/events.ts` with 1 new field on existing type
- Modify 5 existing files: `prompt-builder.ts`, `agent-session.ts`, `orchestrator.ts`, `suite-registry.ts`, `index.ts`
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

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
