# Story 10.9: Project Knowledge Bubbles & Agent-Driven Discovery

Status: ready-for-dev

## Story

As the system operator,
I want a per-project knowledge system where agents proactively discover and suggest relevant knowledge to link,
So that every project accumulates institutional memory without me manually curating it.

## Acceptance Criteria

1. **Given** the user selects the **Knowledge** tab within a project, **When** the tab loads, **Then** it shows: linked knowledge bubbles, linked documents/data sources, and a project instructions editor (system prompt).

2. **Given** the knowledge tab is displayed, **When** the user clicks "Link Document" or "Add Data Source", **Then** they can specify a URI (Google Drive link, local file path, URL, or any accessible location) with a label and description — stored as a knowledge reference for the project.

3. **Given** a data source is linked to a project, **When** an agent is spawned for that project, **Then** the agent's context includes a "Project Data Sources" block listing all linked sources with their labels, descriptions, and access instructions.

4. **Given** an agent is working within a project session, **When** it encounters information that could be valuable as project knowledge (patterns, findings, external references, data locations), **Then** it proposes a knowledge bubble to the user: "I found [X] — want me to add this to project knowledge?" with a preview of the bubble content.

5. **Given** the agent proposes a knowledge bubble, **When** the user approves it, **Then** the bubble is created in the knowledge store, linked to the project, and tagged with the source session ID.

6. **Given** the agent proposes a knowledge bubble, **When** the user rejects or modifies it, **Then** the rejection is noted (to avoid re-suggesting similar content) or the modified version is saved.

7. **Given** the project knowledge management is part of the core system, **When** any agent is spawned for a project, **Then** the knowledge agent (already merged into all orchestrator agent definitions) has access to project-scoped knowledge operations: linking bubbles, managing data sources, and proposing new knowledge.

8. **Given** any project session is active, **When** the orchestrator processes a request, **Then** project knowledge capabilities are always available without requiring a separate suite — they are part of the core knowledge engine.

9. **Given** a knowledge bubble is linked to a project, **When** the user views it in the knowledge tab, **Then** they can see: content preview, source (which session/agent created it), tags, linked data sources, and creation date — with edit and unlink actions.

10. **Given** the user edits project instructions in the knowledge tab, **When** they save, **Then** the system prompt is updated and all future sessions in this project use the updated instructions.

## Tasks / Subtasks

- [x] **Task 1: Database migration & Neo4j schema — project data sources + knowledge links** (AC: 2, 3, 5)
  - [x] 1.1 Create `migrations/020-project-data-sources.sql` — CREATE TABLE `project_data_sources` with columns: `id TEXT PRIMARY KEY`, `project_id TEXT NOT NULL REFERENCES projects(id)`, `uri TEXT NOT NULL`, `label TEXT NOT NULL`, `description TEXT`, `source_type TEXT NOT NULL` (one of: 'gdrive', 'file', 'url', 'other'), `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`. Add index: `idx_project_data_sources_project`. Also CREATE TABLE `knowledge_rejections` with columns: `id TEXT PRIMARY KEY`, `project_id TEXT NOT NULL`, `session_id TEXT NOT NULL`, `content_hash TEXT NOT NULL`, `reason TEXT`, `created_at TEXT NOT NULL`. Add index on `(project_id, content_hash)`.
  - [x] 1.2 Add Neo4j schema in `neo4j-client.ts` `ensureSchema()`: CREATE CONSTRAINT `project_node_id` FOR `(p:Project)` REQUIRE `p.id` IS UNIQUE. This enables `(:Bubble)-[:BELONGS_TO_PROJECT]->(:Project)` relationships in the graph.
  - [x] 1.3 Add a `syncProjectNodes()` function in the knowledge engine that ensures each project from SQLite has a corresponding `(:Project {id, name})` node in Neo4j. Called during boot and when projects are created/updated.

- [x] **Task 2: Shared types — data sources, project knowledge links, discovery proposals** (AC: 2, 4, 5, 6)
  - [x] 2.1 Add `ProjectDataSource` interface in `packages/shared/src/types/projects.ts`: `{ id: string; projectId: string; uri: string; label: string; description?: string; sourceType: 'gdrive' | 'file' | 'url' | 'other'; createdAt: string; updatedAt: string }`.
  - [x] 2.2 Add `ProjectKnowledgeLink` interface: `{ projectId: string; bubbleId: string; linkedBy?: string; createdAt: string }`. Note: no separate `id` — the Neo4j relationship is identified by the `(bubble)-[:BELONGS_TO_PROJECT]->(project)` pair.
  - [x] 2.3 Add `KnowledgeDiscoveryProposal` interface: `{ bubbleTitle: string; bubbleContent: string; tags: string[]; sourceSessionId: string; sourceDescription: string }`.
  - [x] 2.4 Add Zod schemas: `CreateDataSourceSchema` (uri, label, description?, sourceType), `CreateProjectKnowledgeLinkSchema` (bubbleId), `KnowledgeProposalResponseSchema` (action: 'approve' | 'reject' | 'modify', modifiedContent?: string, reason?: string).
  - [x] 2.5 Export all new types from `packages/shared/src/types/index.ts`.

- [x] **Task 3: Backend — project data source CRUD** (AC: 2, 3)
  - [x] 3.1 Create `packages/core/src/project-manager/project-data-sources.ts` — functions: `createDataSource(projectId, input): ProjectDataSource`, `getDataSources(projectId): ProjectDataSource[]`, `getDataSource(id): ProjectDataSource | undefined`, `updateDataSource(id, input): void`, `deleteDataSource(id): void`. Uses `getDb()` from `../db/database.ts`.
  - [x] 3.2 Add `buildProjectDataSourcesContext(projectId: string): string | undefined` — queries all data sources for project, returns formatted markdown: `## Project Data Sources\n- **{label}** ({sourceType}): {uri}\n  {description}`. Returns undefined if none.

- [x] **Task 4: Backend — project knowledge linking via Neo4j** (AC: 5, 6, 9)
  - [x] 4.1 Create `packages/core/src/knowledge-engine/project-knowledge.ts` — functions that use the `Neo4jClient`:
    - `linkBubbleToProject(neo4j, projectId, bubbleId, linkedBy?): Promise<ProjectKnowledgeLink>` — creates `(:Bubble {id: bubbleId})-[:BELONGS_TO_PROJECT {linkedBy, createdAt}]->(:Project {id: projectId})` relationship. Return the link. Fail gracefully if relationship already exists (upsert/MERGE).
    - `unlinkBubbleFromProject(neo4j, projectId, bubbleId): Promise<void>` — deletes the `BELONGS_TO_PROJECT` relationship between the specific bubble and project.
    - `getProjectKnowledgeLinks(neo4j, projectId): Promise<ProjectKnowledgeLink[]>` — MATCH `(b:Bubble)-[r:BELONGS_TO_PROJECT]->(p:Project {id: projectId})` RETURN bubble id, title, contentPreview, tags, source, linkedBy, createdAt. Returns enriched link data (bubble summary included) in a single graph query — no separate lookups needed.
    - `getProjectsForBubble(neo4j, bubbleId): Promise<string[]>` — returns project IDs a bubble belongs to.
  - [x] 4.2 Add `recordKnowledgeRejection(projectId, sessionId, contentHash, reason?): void` and `isContentRejected(projectId, contentHash): boolean` functions in a separate `packages/core/src/knowledge-engine/knowledge-rejections.ts` file. These use SQLite (`getDb()`) since rejections are simple metadata tracking, not graph relationships.

- [x] **Task 5: API routes — data sources and project knowledge** (AC: 1, 2, 5, 6, 9, 10)
  - [x] 5.1 Create `packages/core/src/api/routes/project-knowledge.ts` — new route module registered alongside existing routes.
  - [x] 5.2 Add `GET /api/projects/:id/data-sources` — returns all data sources for project.
  - [x] 5.3 Add `POST /api/projects/:id/data-sources` — create data source. Validates with `CreateDataSourceSchema`.
  - [x] 5.4 Add `PUT /api/projects/:id/data-sources/:dsId` — update data source.
  - [x] 5.5 Add `DELETE /api/projects/:id/data-sources/:dsId` — remove data source.
  - [x] 5.6 Add `GET /api/projects/:id/knowledge-links` — returns linked bubbles for project. Single Neo4j query via `getProjectKnowledgeLinks()` returns bubble metadata (title, tags, source, contentPreview) alongside the link relationship data — no separate lookups needed.
  - [x] 5.7 Add `POST /api/projects/:id/knowledge-links` — link existing bubble to project. Validates with `CreateProjectKnowledgeLinkSchema`.
  - [x] 5.8 Add `DELETE /api/projects/:id/knowledge-links/:bubbleId` — unlink bubble from project.
  - [x] 5.9 Add `POST /api/projects/:id/knowledge-proposals/:action` — handle discovery proposal response (approve/reject/modify). On approve: create bubble via knowledge API, link to project. On reject: record rejection hash. On modify: create with modified content, link to project.
  - [x] 5.10 Register new route file in the API server setup (same pattern as other route modules).

- [x] **Task 6: Orchestrator — data source context injection** (AC: 3)
  - [x] 6.1 In `orchestrator.ts` `handleUserChat()`, after session references context, call `buildProjectDataSourcesContext(project.id)` and pass result to the `agent:task:request` event payload as `projectDataSourcesContext`.
  - [x] 6.2 In `prompt-builder.ts` `buildSystemPrompt()`, add a new context block after session references: if `task.projectDataSourcesContext` exists, append `## Project Data Sources` section.
  - [x] 6.3 Add `projectDataSourcesContext?: string` to the `AgentTaskRequestEvent` payload in `packages/shared/src/types/events.ts`.

- [x] **Task 7: Core knowledge agent — extend with project knowledge endpoints** (AC: 7, 8)
  - [x] 7.1 Extend the existing knowledge agent definition in `packages/core/src/knowledge-engine/context-injector.ts` `createKnowledgeAgentDefinition()` — add the new project knowledge API endpoints to the agent's prompt so it knows about data source CRUD (`/api/projects/:id/data-sources`) and knowledge linking (`/api/projects/:id/knowledge-links`).
  - [x] 7.2 Ensure the knowledge agent's prompt includes the current project ID context so it can make project-scoped API calls. The project ID is already available in the system prompt via the project context block.
  - [x] 7.3 No new suite, no new agent definition file — this is an extension of the existing always-available knowledge agent that is already merged into all orchestrator agent definitions.

- [x] **Task 8: Knowledge discovery — agent instruction injection** (AC: 4, 5, 6)
  - [x] 8.1 In `prompt-builder.ts`, when building the system prompt for a project session, add a "Knowledge Discovery" instruction block telling the agent to watch for valuable information and propose knowledge bubbles when it finds patterns, findings, external references, or data locations.
  - [x] 8.2 The instruction should specify the format: agents propose knowledge via a structured message. The knowledge agent (always available as a delegatable sub-agent) handles creating the bubble and linking it to the project via the REST API.
  - [x] 8.3 Include a reference to the rejection tracking — if a content hash has been rejected for this project, don't re-suggest similar content.

- [x] **Task 9: Frontend — redesigned Knowledge tab** (AC: 1, 9, 10)
  - [x] 9.1 Rewrite `packages/web/src/components/project/ProjectKnowledgeTab.tsx` — replace the global `KnowledgeView` wrapper with a project-scoped layout containing three sections: "Linked Knowledge", "Data Sources", and "Project Instructions".
  - [x] 9.2 **Linked Knowledge section** — fetch from `GET /api/projects/:id/knowledge-links`, display as cards: title, content preview (first 100 chars), tags (as pills), source session name, created date. Each card has "View" (opens bubble detail) and "Unlink" (calls DELETE) actions.
  - [x] 9.3 **Data Sources section** — fetch from `GET /api/projects/:id/data-sources`, display as a list: label, URI (as link if URL), source type badge, description. "Add Data Source" button opens an inline form (label, URI, description, source type dropdown). Each entry has edit/delete actions.
  - [x] 9.4 **Project Instructions editor** — textarea pre-filled with `project.systemPrompt`, auto-saves on blur via `PATCH /api/projects/:id { systemPrompt: value }`. Show "Saved" indicator briefly after save.
  - [x] 9.5 Add "Link Knowledge" button — opens a search/picker that queries `GET /api/knowledge?q=...&limit=10` and lets the user select a bubble to link. Calls `POST /api/projects/:id/knowledge-links`.

- [x] **Task 10: Frontend — API client extensions** (AC: all)
  - [x] 10.1 Add types: `ProjectDataSource`, `ProjectKnowledgeLink`, `LinkedBubbleSummary` (bubble metadata + link info) to `packages/web/src/lib/api-client.ts`.
  - [x] 10.2 Add API methods: `getProjectDataSources(projectId)`, `createProjectDataSource(projectId, data)`, `updateProjectDataSource(projectId, dsId, data)`, `deleteProjectDataSource(projectId, dsId)`.
  - [x] 10.3 Add API methods: `getProjectKnowledgeLinks(projectId)`, `linkKnowledgeToProject(projectId, bubbleId)`, `unlinkKnowledgeFromProject(projectId, bubbleId)`.

- [x] **Task 11: Integration tests** (AC: all)
  - [x] 11.1 Test data source CRUD (SQLite): create, read, update, delete. Verify project scoping.
  - [x] 11.2 Test knowledge linking (mocked Neo4j): link bubble, list links, unlink. Verify MERGE prevents duplicates.
  - [x] 11.3 Test rejection tracking (SQLite): record rejection, check `isContentRejected` returns true for same hash.
  - [x] 11.4 Test `buildProjectDataSourcesContext()` — returns formatted markdown with all data sources.
  - [x] 11.5 Test API routes: data sources CRUD, knowledge links CRUD, proposal actions.
  - [x] 11.6 Test context injection: verify `projectDataSourcesContext` appears in agent task payload when data sources exist.
  - [x] 11.7 Test `syncProjectNodes()` — verify Neo4j MERGE queries issued for each project.

## Dev Notes

### Architecture & Patterns

**Database Migration (020-project-data-sources.sql):**
Next sequential migration after `019-session-management.sql`. Two SQLite tables (data sources + rejections):
```sql
CREATE TABLE IF NOT EXISTS project_data_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  uri TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('gdrive', 'file', 'url', 'other')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_data_sources_project ON project_data_sources(project_id);

CREATE TABLE IF NOT EXISTS knowledge_rejections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_rejections_lookup ON knowledge_rejections(project_id, content_hash);
```

**Knowledge Links Stored in Neo4j Graph (NOT SQLite):**
Project-to-bubble links are stored as Neo4j relationships, keeping the knowledge graph unified:
```cypher
-- Schema (added to ensureSchema())
CREATE CONSTRAINT project_node_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE

-- Linking a bubble to a project
MATCH (b:Bubble {id: $bubbleId})
MERGE (p:Project {id: $projectId})
MERGE (b)-[r:BELONGS_TO_PROJECT]->(p)
SET r.linkedBy = $linkedBy, r.createdAt = $createdAt

-- Querying linked bubbles (single query, no separate lookups)
MATCH (b:Bubble)-[r:BELONGS_TO_PROJECT]->(p:Project {id: $projectId})
RETURN b.id, b.title, b.contentPreview, b.tags, b.source, r.linkedBy, r.createdAt
ORDER BY r.createdAt DESC
```
This means `getProjectKnowledgeLinks()` returns enriched data (bubble title, tags, preview) in one graph query. No SQLite join table needed for knowledge links.

**Project Node Sync:**
`:Project` nodes in Neo4j are lightweight mirrors of the SQLite `projects` table (just `id` and `name`). Synced at boot via `syncProjectNodes()` and on project create/update. The `MERGE` in the link query also ensures the node exists as a fallback.

**Project Data Sources vs Knowledge Bubbles:**
- Data sources = external URIs (Google Drive, files, URLs) — metadata only, stored in SQLite
- Knowledge bubbles = Raven's knowledge store (Neo4j) — linked to projects via `BELONGS_TO_PROJECT` graph relationship
- These are two separate concepts shown in separate sections on the Knowledge tab

**Project Instructions (System Prompt):**
The `Project` model already has `systemPrompt?: string` and `PATCH /api/projects/:id` already supports updating it. The existing `prompt-builder.ts` already injects `project.systemPrompt` into agent context:
```typescript
if (project?.systemPrompt) {
  parts.push('', '## Project Instructions', project.systemPrompt);
}
```
The Knowledge tab's "Project Instructions" editor just needs to read/write this existing field. No new backend work needed for AC10.

**Core Agent Extension (NOT a separate suite):**
Project knowledge management is a core capability, not an optional suite. The existing knowledge agent defined in `context-injector.ts` → `createKnowledgeAgentDefinition()` is already merged into all orchestrator agent definitions. Extend its prompt to include the new project knowledge API endpoints:
- `GET/POST/DELETE /api/projects/:id/data-sources`
- `GET/POST/DELETE /api/projects/:id/knowledge-links`
- `POST /api/projects/:id/knowledge-proposals/:action`

The agent already has `WebFetch` and `Read` tools. No new agent file, no new suite directory, no changes to `config/suites.json`. This keeps project knowledge as a first-class core capability available in every project session.

**Context Injection Chain:**
Extend the existing chain in `orchestrator.ts` → `handleUserChat()`:
1. Knowledge context (already exists via `contextInjector.retrieveContext()`)
2. Session references context (added in 10.8 via `buildSessionReferencesContext()`)
3. **NEW: Project data sources context** via `buildProjectDataSourcesContext()`

In `prompt-builder.ts`, add after session references block:
```typescript
if (task.projectDataSourcesContext) {
  parts.push('', '## Project Data Sources', task.projectDataSourcesContext);
}
```

**Knowledge Discovery Instruction:**
Add to the system prompt for ALL project sessions (since this is a core capability):
```
## Knowledge Discovery
When you encounter valuable information during this conversation — patterns, findings,
external references, data locations, or decisions — you may propose adding it to project
knowledge. Format proposals as structured suggestions the user can approve, reject, or modify.
Do not re-suggest content similar to previously rejected proposals.
```
This is injected by the prompt builder for any session that has a non-meta project. NOT hardcoded in the orchestrator.

### Existing Components to Reuse

| Component | Location | Use For |
|-----------|----------|---------|
| `ProjectKnowledgeTab` | `components/project/ProjectKnowledgeTab.tsx` | Rewrite with project-scoped layout |
| `InlineEditField` | `components/project/InlineEditField.tsx` | Project instructions editor (or use textarea) |
| `KnowledgeView` | `components/knowledge/KnowledgeView.tsx` | Reference for knowledge display patterns — NOT embedded directly |
| `BubbleDetailPanel` | `components/knowledge/BubbleDetailPanel.tsx` | Pattern for bubble detail display |
| `ReferencesPanel` | `components/session/ReferencesPanel.tsx` | Panel pattern reference |
| `api-client.ts` | `web/src/lib/api-client.ts` | Extend with new API methods |
| `context-injector.ts` | `core/src/knowledge-engine/context-injector.ts` | Extend knowledge agent definition with project endpoints |
| `neo4j-client.ts` | `core/src/knowledge-engine/neo4j-client.ts` | Add Project constraint to ensureSchema() |
| `link-ops.ts` | `core/src/knowledge-engine/link-ops.ts` | Pattern for Neo4j relationship CRUD (LINKS_TO → BELONGS_TO_PROJECT) |
| `session-references.ts` | `core/src/session-manager/session-references.ts` | Pattern for standalone SQLite CRUD module |

### Existing API Endpoints (already exist, NO changes needed)

| Endpoint | Method | Use For |
|----------|--------|---------|
| `GET /api/knowledge` | GET | Search/list bubbles for the "Link Knowledge" picker |
| `GET /api/knowledge/:id` | GET | Fetch full bubble details for linked display |
| `POST /api/knowledge` | POST | Create bubble when discovery proposal is approved |
| `PATCH /api/projects/:id` | PATCH | Update project systemPrompt (instructions editor) |
| `GET /api/projects/:id` | GET | Load project with systemPrompt for editor |

### New API Endpoints

| Endpoint | Method | Use For |
|----------|--------|---------|
| `GET /api/projects/:id/data-sources` | GET | List project data sources |
| `POST /api/projects/:id/data-sources` | POST | Add data source |
| `PUT /api/projects/:id/data-sources/:dsId` | PUT | Update data source |
| `DELETE /api/projects/:id/data-sources/:dsId` | DELETE | Remove data source |
| `GET /api/projects/:id/knowledge-links` | GET | List linked knowledge bubbles |
| `POST /api/projects/:id/knowledge-links` | POST | Link bubble to project |
| `DELETE /api/projects/:id/knowledge-links/:bubbleId` | DELETE | Unlink bubble from project |
| `POST /api/projects/:id/knowledge-proposals/:action` | POST | Handle discovery proposal |

### Project Structure Notes

**New files to create:**
```
migrations/020-project-data-sources.sql
packages/core/src/project-manager/project-data-sources.ts
packages/core/src/knowledge-engine/project-knowledge.ts
packages/core/src/knowledge-engine/knowledge-rejections.ts
packages/core/src/api/routes/project-knowledge.ts
packages/core/src/__tests__/project-knowledge.test.ts
```

**Files to modify:**
```
packages/shared/src/types/projects.ts         (add ProjectDataSource, ProjectKnowledgeLink, KnowledgeDiscoveryProposal)
packages/shared/src/types/events.ts           (add projectDataSourcesContext to AgentTaskRequestEvent)
packages/shared/src/types/index.ts            (export new types)
packages/core/src/knowledge-engine/neo4j-client.ts (add Project constraint to ensureSchema(), add syncProjectNodes())
packages/core/src/knowledge-engine/context-injector.ts (extend knowledge agent prompt with project knowledge endpoints)
packages/core/src/orchestrator/orchestrator.ts (inject data sources context)
packages/core/src/agent-manager/prompt-builder.ts (add data sources block, knowledge discovery instruction)
packages/core/src/api/server.ts               (register project-knowledge routes)
packages/web/src/lib/api-client.ts            (add types + API methods)
packages/web/src/components/project/ProjectKnowledgeTab.tsx (rewrite with project-scoped layout)
```

**File size targets:** New files under 150 lines each. Modified files stay under 300 lines.

### Styling Conventions

- CSS variables: `--bg`, `--bg-card`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--accent`, `--success`, `--warning`, `--error`
- Tailwind + inline `style={{}}` with CSS variables (established pattern)
- Cards: `rounded p-4 border` with `background: var(--bg-card)`, `borderColor: var(--border)`
- Tag pills: `text-xs px-2 py-0.5 rounded-full` with accent-based background
- Buttons: `px-3 py-1.5 rounded text-sm` — primary uses `--accent`, secondary uses `--bg-hover`
- Section headings: `text-lg font-semibold mb-3`
- No external UI libraries — hand-built with Tailwind + CSS vars

### Anti-Patterns to Avoid

- **Do NOT embed the global `KnowledgeView` component** in the project Knowledge tab — it's a graph visualization. Build a simpler, project-scoped list/card view.
- **Do NOT store knowledge links in SQLite** — use Neo4j `BELONGS_TO_PROJECT` relationships. The graph DB is the single source of truth for all knowledge relationships.
- **Do NOT create a separate suite** for project management — extend the existing core knowledge agent in `context-injector.ts`. Project knowledge is always-on, not optional.
- **Do NOT create a separate system prompt field** — the `Project.systemPrompt` already exists and is already injected by `prompt-builder.ts`.
- **Do NOT import `better-sqlite3` directly** — use `getDb()` from `../db/database.ts`.
- **Do NOT create a REST route for updating project instructions** — `PATCH /api/projects/:id { systemPrompt }` already exists.
- **Do NOT fetch bubble details one-by-one from Neo4j** — the `BELONGS_TO_PROJECT` query returns bubble metadata in a single graph query.
- **Do NOT hardcode knowledge discovery instructions in the orchestrator** — add them to the prompt builder.
- **Do NOT create files under `packages/skills/` or `suites/`** — this is a core capability extension.

### Previous Story Intelligence (from 10.8)

**Key learnings to apply:**
- Prompt builder now takes `(task: AgentTask, project?: Project)` — just add `projectDataSourcesContext` field to `AgentTask` and read it in `buildSystemPrompt`
- Session references module (`session-references.ts`) is the exact pattern to follow for standalone DB CRUD modules — functions that call `getDb()`, not classes
- API routes pattern: Zod validation inline, error as `{ error: '...' }`, return objects directly, PATCH for partial updates
- Frontend: `InlineEditField` reusable, panel patterns established, `usePolling` for list updates
- Test pattern: temp SQLite DB via `mkdtempSync`, run migrations, clean up in `afterEach`

**Code review fixes from 10.7/10.8 to remember:**
- Always use absolute paths for file operations
- Eliminate query redundancy (don't fetch same data twice)
- Include integration tests for new components
- Handle null/undefined gracefully in UI

### Git Intelligence

Recent commits (10.5-10.8) show consistent patterns:
- Migration files are standalone SQL in `migrations/`
- Shared types updated in `packages/shared/src/types/` with re-exports from `index.ts`
- Backend CRUD modules as standalone function files (not classes)
- API routes added as new handler registrations or new route files
- Suite additions follow `suites/<name>/` directory structure
- Frontend components colocated: `components/project/`, `components/session/`
- Test files: `packages/core/src/__tests__/*.test.ts`

### Testing Standards

- **Framework:** Vitest 4 with `test.projects` in root config
- **Test file:** `packages/core/src/__tests__/project-knowledge.test.ts`
- **Mock Claude SDK** (`@anthropic-ai/claude-code`) — not needed for these tests (no agent spawning)
- **Temp SQLite DBs** via `mkdtempSync()` for isolation, clean up in `afterEach`
- **Run migrations** on temp DB before each test
- **High-value tests:** data source CRUD (SQLite), rejection tracking (SQLite), context builder output, API endpoint responses
- **No cosmetic tests:** don't test CSS classes or exact UI text
- **Neo4j tests:** Mock the `Neo4jClient` interface for project knowledge link tests (linkBubbleToProject, unlinkBubbleFromProject, getProjectKnowledgeLinks). Don't require a running Neo4j instance. Follow the mock patterns in existing knowledge engine tests.
- **Project node sync:** Test `syncProjectNodes()` via mocked Neo4j client — verify MERGE queries are issued for each project.

### Cross-Story Dependencies

- **Story 10.8 (completed)** — session names/descriptions available for knowledge linking UI, session references context pattern established
- **Story 10.10 (next)** — auto-compaction will use knowledge linking to attach retrospective-discovered knowledge to projects, will write to `sessions.summary`
- **Story 10.11 (future)** — execution modes may affect how knowledge discovery agents run

### Build & Quality Checks

```bash
npm run build                    # shared + core (rebuild after type changes)
npm run check                    # format:check + lint + tsc --noEmit (MUST PASS)
npm run format                   # Prettier write mode
npm test                         # Vitest run all tests
```

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.9] — Acceptance criteria
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture] — DB naming, migration pattern
- [Source: packages/shared/src/types/projects.ts] — Existing Project interface with systemPrompt
- [Source: packages/shared/src/types/knowledge.ts] — Knowledge bubble types (Neo4j-backed)
- [Source: packages/core/src/session-manager/session-references.ts] — Pattern for standalone CRUD module
- [Source: packages/core/src/knowledge-engine/context-injector.ts] — Knowledge agent definition pattern
- [Source: packages/core/src/agent-manager/prompt-builder.ts] — System prompt assembly
- [Source: packages/core/src/orchestrator/orchestrator.ts] — Context injection flow
- [Source: packages/core/src/api/routes/knowledge.ts] — Existing knowledge API routes
- [Source: packages/web/src/components/project/ProjectKnowledgeTab.tsx] — Current tab to rewrite
- [Source: packages/web/src/components/project/project-tab-registry.ts] — Tab registration
- [Source: packages/core/src/knowledge-engine/neo4j-client.ts] — Neo4j client, ensureSchema(), relationship patterns
- [Source: packages/core/src/knowledge-engine/link-ops.ts] — Neo4j relationship CRUD pattern (LINKS_TO)
- [Source: migrations/019-session-management.sql] — Last migration (next is 020)
- [Source: _bmad-output/implementation-artifacts/10-8-session-management-and-cross-referencing.md] — Previous story learnings

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
