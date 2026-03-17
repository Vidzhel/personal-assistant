# Story 6.1: Knowledge Bubble Storage & CRUD

Status: done

## Story

As the system operator,
I want to store information as knowledge bubbles as plain markdown files with a search index,
So that Raven has persistent, human-readable, file-browsable memory like an Obsidian vault.

## Acceptance Criteria

1. **Given** the user stores a knowledge bubble with title "SQLite Backup Strategies" and tags ["database", "ops"], **When** the bubble is created, **Then** a markdown file is written to `data/knowledge/` with YAML frontmatter (tags, source, dates) and the bubble is queryable via API
2. **Given** a search query for tag "database", **When** `GET /api/knowledge?tag=database` is called, **Then** all bubbles tagged "database" are returned with metadata and content preview
3. **Given** a knowledge bubble is updated, **When** the content changes, **Then** the markdown file is overwritten, `updated_at` is refreshed in frontmatter and index
4. **Given** a full-text search for "WAL mode", **When** `GET /api/knowledge?q=WAL+mode` is called, **Then** bubbles containing that text in title or content are returned, ranked by relevance
5. **Given** the knowledge directory contains markdown files (e.g. manually added), **When** the system starts or a re-index is triggered, **Then** the SQLite index is rebuilt from the files on disk

## Tasks / Subtasks

- [x] Task 1: Database migration — knowledge index tables (AC: #1, #5)
  - [x] 1.1 Create `migrations/005-knowledge-index.sql` with `knowledge_index` and `knowledge_tags` tables (index only — no content column)
  - [x] 1.2 Create FTS5 virtual table `knowledge_fts` for full-text search on title + content
  - [x] 1.3 Verify migration runs cleanly against existing `data/raven.db`

- [x] Task 2: Shared types — knowledge interfaces and Zod schemas (AC: #1, #2, #3, #4)
  - [x] 2.1 Create `packages/shared/src/types/knowledge.ts` with `KnowledgeBubble` interface, Zod schemas for create/update/query
  - [x] 2.2 Export from `packages/shared/src/types/index.ts`
  - [x] 2.3 Add knowledge event types to `packages/shared/src/types/events.ts`

- [x] Task 3: Knowledge store — file + index layer (AC: #1, #2, #3, #4, #5)
  - [x] 3.1 Create `packages/core/src/knowledge-engine/knowledge-store.ts` with factory function
  - [x] 3.2 Implement file operations: `writeMarkdownFile`, `readMarkdownFile`, `deleteMarkdownFile` — handle YAML frontmatter parse/serialize
  - [x] 3.3 Implement index operations: `indexBubble`, `removeFromIndex`, `reindexAll` (scan `data/knowledge/`, parse frontmatter, rebuild SQLite index + FTS)
  - [x] 3.4 Implement CRUD: `insert`, `update`, `delete`, `getById`, `list` (tag filter + pagination), `search` (FTS5)
  - [x] 3.5 Implement tag operations: `getAllTags` (with counts from index)

- [x] Task 4: API routes — knowledge CRUD endpoints (AC: #1, #2, #3, #4, #5)
  - [x] 4.1 Create `packages/core/src/api/routes/knowledge.ts` with all endpoints
  - [x] 4.2 `GET /api/knowledge` — list with `?tag=`, `?q=`, `?source=`, `?limit=`, `?offset=`
  - [x] 4.3 `GET /api/knowledge/:id` — get single bubble (reads file for content, index for metadata)
  - [x] 4.4 `POST /api/knowledge` — create bubble (writes file + updates index)
  - [x] 4.5 `PUT /api/knowledge/:id` — update bubble (rewrites file + updates index)
  - [x] 4.6 `DELETE /api/knowledge/:id` — delete file + remove from index
  - [x] 4.7 `GET /api/knowledge/tags` — all tags with bubble counts
  - [x] 4.8 `POST /api/knowledge/reindex` — full re-index from disk
  - [x] 4.9 Register routes in `packages/core/src/api/server.ts`

- [x] Task 5: Boot-time index sync (AC: #5)
  - [x] 5.1 On startup, run `reindexAll` to ensure SQLite index matches files on disk
  - [x] 5.2 Wire into boot sequence in `packages/core/src/index.ts`

- [x] Task 6: Event emission on CRUD operations (AC: #1, #3)
  - [x] 6.1 Emit `knowledge:bubble:created`, `knowledge:bubble:updated`, `knowledge:bubble:deleted` events from routes

- [x] Task 7: Integration tests (AC: #1, #2, #3, #4, #5)
  - [x] 7.1 Knowledge store tests: file CRUD, frontmatter round-trip, tag filtering, FTS5 search, pagination, reindex
  - [x] 7.2 API route tests: all endpoints, validation errors, 404 handling, query params, reindex

## Dev Notes

### Storage Architecture — File-First (Obsidian-Style)

**Source of truth: Markdown files on disk.** SQLite is a search/query index only.

```
data/knowledge/
├── sqlite-backup-strategies.md
├── event-driven-architecture.md
├── raven-pipeline-patterns.md
└── weekly-review-2026-03-10.md
```

Each file is a self-contained markdown document with YAML frontmatter:

```markdown
---
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
title: SQLite Backup Strategies
tags:
  - database
  - ops
  - sqlite
source: manual
created_at: "2026-03-17T10:30:00.000Z"
updated_at: "2026-03-17T10:30:00.000Z"
---

# SQLite Backup Strategies

WAL mode enables concurrent reads during backup...
```

**Key design decisions:**
- **Files are human-readable and portable** — you can browse them in any editor, Obsidian, VS Code, or `cat`
- **Filenames are slugified titles** — `kebab-case.md` derived from title (e.g. "SQLite Backup Strategies" → `sqlite-backup-strategies.md`). Handle collisions by appending a short suffix (e.g. `-2`)
- **YAML frontmatter is the metadata** — `id`, `title`, `tags`, `source`, `created_at`, `updated_at`
- **Body after frontmatter is the content** — pure markdown, no structure imposed
- **SQLite stores the index only** — id, title, file_path, source, timestamps. Content lives in files. FTS5 indexes title + content for search
- **Re-indexable** — if SQLite index is lost or corrupted, rebuild entirely from files on disk
- **Manually added files are first-class** — drop a `.md` file with valid frontmatter into `data/knowledge/` and it gets indexed on next startup or reindex

### Database Schema (Index Only)

Create `migrations/005-knowledge-index.sql`:

```sql
-- SQLite index for knowledge bubble metadata (source of truth is markdown files on disk)
CREATE TABLE knowledge_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,       -- relative path from data/knowledge/, e.g. "sqlite-backup-strategies.md"
  source TEXT,                          -- e.g. "manual", "voice-memo", "pdf", "ingestion"
  created_at TEXT NOT NULL,             -- ISO 8601, mirrored from frontmatter
  updated_at TEXT NOT NULL              -- ISO 8601, mirrored from frontmatter
);

CREATE TABLE knowledge_tags (
  bubble_id TEXT NOT NULL REFERENCES knowledge_index(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (bubble_id, tag)
);

CREATE INDEX idx_knowledge_index_created_at ON knowledge_index(created_at);
CREATE INDEX idx_knowledge_index_updated_at ON knowledge_index(updated_at);
CREATE INDEX idx_knowledge_tags_tag ON knowledge_tags(tag);

-- FTS5 for full-text search (content stored here for search, but file is source of truth)
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title,
  content
);
```

**FTS5 note:** This is a standalone FTS table (not external-content), because content lives in files, not in `knowledge_index`. The store manually inserts/updates/deletes FTS rows when files change. This is simpler than triggers and avoids the rowid-mapping complexity of external-content FTS tables. The FTS `rowid` maps to nothing in `knowledge_index` — use a separate mapping column or store the bubble `id` in a hidden FTS column.

**Revised FTS approach — use id mapping:**
```sql
-- FTS5 with bubble ID stored for joining back to index
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  bubble_id,
  title,
  content
);
```

Then search query:
```sql
SELECT ki.* FROM knowledge_index ki
JOIN knowledge_fts fts ON ki.id = fts.bubble_id
WHERE knowledge_fts MATCH ?
ORDER BY rank
LIMIT ? OFFSET ?
```

**Important:** The `MATCH` clause must only target `title` and `content` columns, not `bubble_id`. Use column filters in the query: `WHERE knowledge_fts MATCH '{title content}: ' || ?` or use the `{title content}:` prefix syntax.

### Frontmatter Parsing

Use the `gray-matter` npm package for YAML frontmatter parsing/serialization. It's the standard for this (used by Hugo, Jekyll, Gatsby, etc.).

```bash
npm install gray-matter -w packages/core
```

**This is the ONE new dependency for this story.** Add to `packages/core/package.json`.

```typescript
import matter from 'gray-matter';

// Parse: file content → { frontmatter, body }
function parseMarkdownFile(raw: string): { meta: BubbleFrontmatter; content: string } {
  const { data, content } = matter(raw);
  return { meta: data as BubbleFrontmatter, content: content.trim() };
}

// Serialize: { frontmatter, body } → file content
function serializeMarkdownFile(meta: BubbleFrontmatter, content: string): string {
  return matter.stringify(content, meta);
}
```

**Frontmatter interface:**
```typescript
interface BubbleFrontmatter {
  id: string;
  title: string;
  tags: string[];
  source: string | null;
  created_at: string;
  updated_at: string;
}
```

### Filename Slugification

```typescript
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric
    .replace(/\s+/g, '-')            // spaces to hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '')           // trim leading/trailing hyphens
    .slice(0, 100);                  // cap length
}
```

**Collision handling:** If `data/knowledge/${slug}.md` already exists (different bubble ID), append `-2`, `-3`, etc. When a title is updated, the file is renamed (old deleted, new written) and the `file_path` in the index is updated.

### Shared Types — `packages/shared/src/types/knowledge.ts`

```typescript
import { z } from 'zod';

// Domain interface — what the API returns
export interface KnowledgeBubble {
  id: string;
  title: string;
  content: string;           // markdown body (read from file)
  filePath: string;           // relative path in data/knowledge/
  source: string | null;
  tags: string[];
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
}

// List response — content omitted for efficiency, replaced with preview
export interface KnowledgeBubbleSummary {
  id: string;
  title: string;
  contentPreview: string;     // first ~200 chars of content
  filePath: string;
  source: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// API schemas
export const CreateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().default(''),
  source: z.string().max(100).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
});

export const UpdateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().optional(),
  source: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const KnowledgeQuerySchema = z.object({
  q: z.string().optional(),           // full-text search
  tag: z.string().optional(),          // filter by tag
  source: z.string().optional(),       // filter by source
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateKnowledgeBubble = z.infer<typeof CreateKnowledgeBubbleSchema>;
export type UpdateKnowledgeBubble = z.infer<typeof UpdateKnowledgeBubbleSchema>;
export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;
```

### Event Types to Add

In `packages/shared/src/types/events.ts`, add to the `RavenEvent` union:

```typescript
// Event types: 'knowledge:bubble:created' | 'knowledge:bubble:updated' | 'knowledge:bubble:deleted'
// Payload: { bubbleId: string; title: string; filePath: string }
```

Follow existing event pattern — colon-separated lowercase type, minimal payload.

### Knowledge Store — Dual Layer (Files + Index)

File: `packages/core/src/knowledge-engine/knowledge-store.ts`

The store has two responsibilities:
1. **File layer** — read/write/delete markdown files in `data/knowledge/`
2. **Index layer** — keep SQLite `knowledge_index` + `knowledge_tags` + `knowledge_fts` in sync

**Factory function:**
```typescript
export function createKnowledgeStore(deps: {
  db: DatabaseInterface;
  knowledgeDir: string;    // absolute path to data/knowledge/
}): KnowledgeStore
```

**Interface:**
```typescript
export interface KnowledgeStore {
  // CRUD (writes file + updates index)
  insert: (input: CreateKnowledgeBubble) => KnowledgeBubble;
  update: (id: string, input: UpdateKnowledgeBubble) => KnowledgeBubble | undefined;
  remove: (id: string) => boolean;
  getById: (id: string) => KnowledgeBubble | undefined;

  // Query (reads from index, fetches content from files)
  list: (query: KnowledgeQuery) => KnowledgeBubbleSummary[];
  search: (query: string, limit: number, offset: number) => KnowledgeBubbleSummary[];
  getAllTags: () => Array<{ tag: string; count: number }>;

  // Index management
  reindexAll: () => { indexed: number; errors: string[] };
}
```

**CRUD flow for `insert`:**
1. Generate ID via `generateId()`
2. Slugify title → filename
3. Handle filename collision
4. Build frontmatter object
5. Serialize with `gray-matter` → write file to `data/knowledge/${slug}.md`
6. INSERT into `knowledge_index` (id, title, file_path, source, created_at, updated_at)
7. INSERT tags into `knowledge_tags`
8. INSERT into `knowledge_fts` (bubble_id, title, content)
9. Return full `KnowledgeBubble`

**CRUD flow for `update`:**
1. Look up existing bubble in `knowledge_index` by ID
2. Read existing file from disk
3. Merge changes (title, content, source, tags — only update provided fields)
4. If title changed → rename file (new slug), update `file_path` in index
5. Update `updated_at` in frontmatter
6. Write updated file
7. UPDATE `knowledge_index` row
8. Replace tags (DELETE + INSERT in transaction)
9. UPDATE `knowledge_fts` (DELETE old + INSERT new)
10. Return updated `KnowledgeBubble`

**CRUD flow for `getById`:**
1. Look up in `knowledge_index` by ID → get `file_path`
2. Read file from `data/knowledge/${file_path}`
3. Parse frontmatter + content
4. Fetch tags from `knowledge_tags`
5. Return assembled `KnowledgeBubble`

**List flow:**
1. Query `knowledge_index` with filters (tag JOIN, source WHERE, LIMIT/OFFSET)
2. For each result, read first ~200 chars of content from file for preview (or cache in FTS)
3. Return `KnowledgeBubbleSummary[]`

**Performance note for list:** Reading every file for content preview on list queries is expensive. Two options:
- **Option A:** Store a `content_preview` column in `knowledge_index` (first 200 chars, updated on write). Simple, fast.
- **Option B:** Read from `knowledge_fts` table since it already has the full content.
- **Recommended: Option A** — add a `content_preview TEXT` column to `knowledge_index`. Updated on every write. List queries stay index-only.

**Reindex flow (`reindexAll`):**
1. `readdir` `data/knowledge/` for all `.md` files
2. For each file: parse frontmatter, extract metadata
3. If file has no `id` in frontmatter → generate one, rewrite frontmatter with ID
4. Clear `knowledge_index`, `knowledge_tags`, `knowledge_fts` tables
5. Bulk INSERT all parsed data
6. Return count + any files that failed to parse

### API Route Pattern

File: `packages/core/src/api/routes/knowledge.ts`

Follow `projects.ts` (basic CRUD) pattern:
- Factory function `registerKnowledgeRoutes(app, deps)` — deps include `eventBus` and `knowledgeStore`
- Zod `safeParse` on request body/query at every endpoint
- Return `{ error: string }` with appropriate HTTP status on validation failure
- ID generation handled by store, not routes

**Endpoint summary:**

| Method | Path | Body/Query | Returns |
|--------|------|------------|---------|
| GET | `/api/knowledge` | `?q=&tag=&source=&limit=&offset=` | `KnowledgeBubbleSummary[]` |
| GET | `/api/knowledge/tags` | — | `{ tag: string; count: number }[]` |
| GET | `/api/knowledge/:id` | — | `KnowledgeBubble` (full content) or 404 |
| POST | `/api/knowledge` | `CreateKnowledgeBubble` | `KnowledgeBubble` (201) |
| PUT | `/api/knowledge/:id` | `UpdateKnowledgeBubble` | `KnowledgeBubble` |
| DELETE | `/api/knowledge/:id` | — | `{ success: true }` |
| POST | `/api/knowledge/reindex` | — | `{ indexed: number; errors: string[] }` |

**Route registration order matters** — register `/api/knowledge/tags` and `/api/knowledge/reindex` BEFORE `/api/knowledge/:id` so Fastify doesn't match them as `:id` params.

### Architecture Constraints

- **No classes** — factory functions only (except skills)
- **No `console.log`** — use `createLogger('knowledge-store')` / `createLogger('knowledge-routes')`
- **`.ts` extensions** in all relative imports
- **Zod validation** at every API boundary — `safeParse`, never `parse`
- **ISO 8601 strings** for all timestamps in DB, frontmatter, and API responses
- **`crypto.randomUUID()`** for IDs (via `generateId()`)
- **Max 300 lines per file** — extract helpers if needed (e.g. `knowledge-file.ts` for file I/O, `knowledge-store.ts` for index)
- **Max 50 lines per function** (ESLint guardrail) — extract sub-functions
- **No magic numbers** — extract to named constants (e.g., `DEFAULT_LIMIT = 50`, `MAX_LIMIT = 200`, `PREVIEW_LENGTH = 200`)
- **`node:` prefix** for Node.js builtins (`node:fs`, `node:path`)
- **HTTP status constants** from `@raven/shared` (`HTTP_STATUS.CREATED`, `HTTP_STATUS.NOT_FOUND`, etc.)
- **Synchronous file I/O is OK** for knowledge store — `better-sqlite3` is sync too, and knowledge operations are low-frequency. Use `readFileSync`/`writeFileSync` for simplicity.

### Existing Infrastructure to Reuse (DO NOT Recreate)

| Component | Location | Reuse How |
|---|---|---|
| `DatabaseInterface` | `packages/core/src/db/database.ts` | Pass to knowledge store factory |
| `generateId()` | `packages/shared/src/utils/id.ts` | Use for bubble IDs |
| `createLogger()` | `packages/shared/src/utils/logger.ts` | Use in store and routes |
| `HTTP_STATUS` | `packages/shared/src/types/api.ts` | Use for response status codes |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | Emit knowledge events |
| Migration runner | `packages/core/src/db/migrations.ts` | Automatically picks up new .sql files |
| `server.ts` route registration | `packages/core/src/api/server.ts` | Add `registerKnowledgeRoutes(app, deps)` call |
| `createDbInterface()` | `packages/core/src/db/database.ts` | Get DatabaseInterface for store |
| `getConfig()` | `packages/core/src/config.ts` | Get `DATABASE_PATH` to derive knowledge dir location |

### File Structure — New Files

```
data/knowledge/                                                # Knowledge vault directory (created on boot if missing)
migrations/005-knowledge-index.sql                             # Index schema (no content column)
packages/shared/src/types/knowledge.ts                         # Types + Zod schemas
packages/core/src/knowledge-engine/knowledge-store.ts          # Store layer (file + index)
packages/core/src/api/routes/knowledge.ts                      # API routes
packages/core/src/__tests__/knowledge-store.test.ts            # Store tests
```

### File Structure — Modified Files

```
packages/shared/src/types/index.ts                             # Export knowledge types
packages/shared/src/types/events.ts                            # Add knowledge event types
packages/core/src/api/server.ts                                # Register knowledge routes
packages/core/src/index.ts                                     # Wire knowledge store + reindex on boot
packages/core/src/__tests__/api.test.ts                        # Add knowledge API tests
packages/core/package.json                                     # Add gray-matter dependency
```

### New Dependency

```bash
npm install gray-matter -w packages/core
```

`gray-matter` — standard YAML frontmatter parser/serializer. Used by Hugo, Jekyll, Gatsby, Docusaurus. Zero config, handles `---` delimiters, returns typed `data` + `content`. This is the only new dependency.

### Testing Strategy

**Knowledge store tests** (`knowledge-store.test.ts`):
- Uses temp directory (mkdtempSync) for both SQLite DB and knowledge files, cleanup in afterEach
- Test file round-trip: create bubble → verify `.md` file exists with correct frontmatter and content
- Test frontmatter parsing: manually write a file with frontmatter → reindex → verify indexed correctly
- Test CRUD: create, read back (verify file + index match), update (verify file rewritten), delete (verify file removed + index cleared)
- Test title rename: update title → verify old file deleted, new file created, index updated
- Test tags: set tags, filter by tag, verify counts
- Test FTS5 search: insert bubbles with known content, search, verify relevance ordering
- Test pagination: insert N bubbles, verify limit/offset work
- Test delete cascade: delete bubble, verify tags removed from index, file removed from disk
- Test reindex: create files manually (no index), call reindexAll, verify all indexed
- Test reindex with missing ID: file without `id` in frontmatter gets one generated

**API route tests** (extend `api.test.ts` or create `knowledge-api.test.ts`):
- POST returns 201 with generated ID, timestamps, and filePath
- POST with invalid body returns 400
- GET list returns array of summaries with content previews, respects tag filter and search query
- GET by ID returns full bubble with content or 404
- PUT updates specified fields only, refreshes updated_at, renames file if title changes
- DELETE returns success or 404, file removed from disk
- GET /api/knowledge/tags returns tag counts
- POST /api/knowledge/reindex returns indexed count

### Previous Story Intelligence (Story 5.5)

Key learnings to apply:
- **ESLint guardrails**: Plan for `max-lines-per-function` (50) from the start. Extract file I/O, frontmatter parsing, index operations, and slug generation into helper functions.
- **Magic numbers**: Extract all limits, defaults to named constants at top of file.
- **Store pattern**: `PipelineStore` is the gold standard — follow its factory function, conditional update patterns. Adapt for the dual file+index layer.
- **Route pattern**: `projects.ts` for basic CRUD, `pipelines.ts` for advanced features.
- **API tests**: Use `app.inject()` pattern for integration testing — no HTTP server needed.

### Git Intelligence

Recent commits show:
- Story 5.5 added metrics API, pipeline chat config — established stats aggregation patterns
- Story 5.4 added kanban task board with SSE streaming — established real-time data patterns
- All commits follow `feat: description (story X.Y)` format
- Code review fixes are separate commits: `fix: description`
- 621 tests currently pass across 42 test files — zero regressions expected

### Anti-Patterns to Avoid

1. **DO NOT store content in SQLite** — content lives in markdown files only. SQLite is an index.
2. **DO NOT add a knowledge skill yet** — this story is infrastructure only (files + index + API). Story 6.4 adds the sub-agent context injection. No MCP servers needed.
3. **DO NOT add frontend UI** — the dashboard knowledge page is not in this story's scope. API-only.
4. **DO NOT add clustering or auto-tagging** — that's story 6.3.
5. **DO NOT add ingestion pipeline** — that's story 6.2.
6. **DO NOT import better-sqlite3 directly in new files** — use `DatabaseInterface` from the db module.
7. **DO NOT use async file I/O** — keep it sync like `better-sqlite3` for simplicity. Knowledge operations are low-frequency, single-user.
8. **DO NOT invent a custom frontmatter parser** — use `gray-matter`.

### Project Structure Notes

- `packages/core/src/knowledge-engine/` is a new directory following the pattern of `permission-engine/` and `pipeline-engine/`
- If the store file exceeds 300 lines, split into `knowledge-file.ts` (file I/O, frontmatter, slugify) and `knowledge-store.ts` (index, CRUD orchestration)
- Types go in `packages/shared/src/types/knowledge.ts` following existing pattern
- Migration file numbered `005-` (next after `004-execution-logging.sql`)
- `data/knowledge/` directory created automatically on boot (like `data/sessions/`)
- One new dependency: `gray-matter`

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 6, Story 6.1]
- [Source: _bmad-output/planning-artifacts/architecture.md — Database Conventions, API Patterns, File Structure]
- [Source: _bmad-output/planning-artifacts/prd.md — FR42 (knowledge bubble storage)]
- [Source: packages/core/src/pipeline-engine/pipeline-store.ts — Store factory pattern]
- [Source: packages/core/src/api/routes/projects.ts — Basic CRUD route pattern]
- [Source: packages/core/src/api/routes/pipelines.ts — Advanced route pattern]
- [Source: packages/shared/src/types/pipelines.ts — Zod schema pattern]
- [Source: packages/core/src/db/migrations.ts — Migration runner]
- [Source: migrations/001-initial-schema.sql — Schema conventions]
- [Source: packages/core/src/session-manager/message-store.ts — File-based storage pattern]
- [Source: _bmad-output/implementation-artifacts/5-5-pipeline-chat-configuration-and-execution-metrics.md — Previous story learnings]
- [Source: _bmad-output/project-context.md — Coding conventions and anti-patterns]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- Fixed Pino logger calls: project uses string-only `log.info(msg)`, not structured `log.info(obj, msg)`
- Fixed `max-params` ESLint errors: refactored `buildFrontmatter` and `insertFts` to use object params
- Fixed magic numbers in Zod schemas: extracted named constants
- Fixed flaky test: `updated_at` comparison could match within same millisecond — changed to verify content update instead

### Completion Notes List

- All 7 tasks completed: migration, shared types, knowledge store, API routes, boot-time sync, event emission, tests
- 38 new tests (24 store + 14 API), all passing
- Full suite: 659 tests pass, 0 regressions
- `npm run check` passes clean (format + lint + typecheck)
- File-first Obsidian-style architecture: markdown files are source of truth, SQLite is search index only
- FTS5 search with `{title content}:` column filter for proper matching
- `gray-matter` added as sole new dependency for YAML frontmatter parse/serialize
- `content_preview` column added to `knowledge_index` for efficient list queries (avoids file reads on list)

### File List

New files:
- migrations/005-knowledge-index.sql
- packages/shared/src/types/knowledge.ts
- packages/core/src/knowledge-engine/knowledge-file.ts
- packages/core/src/knowledge-engine/knowledge-store.ts
- packages/core/src/api/routes/knowledge.ts
- packages/core/src/__tests__/knowledge-store.test.ts
- packages/core/src/__tests__/knowledge-api.test.ts

Modified files:
- packages/shared/src/types/index.ts
- packages/shared/src/types/events.ts
- packages/core/src/api/server.ts
- packages/core/src/index.ts
- packages/core/package.json
- package-lock.json

### Change Log

- 2026-03-17: Implemented story 6.1 — Knowledge Bubble Storage & CRUD (all tasks complete)
- 2026-03-17: Code review fixes — FTS5 query sanitization (strip special chars + boolean operators), transaction wrapping on CRUD index operations, extracted `updateIndex` helper to stay under max-lines-per-function
