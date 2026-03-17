# Story 6.2: Knowledge Ingestion Pipeline

Status: done

## Story

As the system operator,
I want Raven to ingest content from any source — text, files of any type, voice transcriptions, and web URLs — into structured knowledge bubbles with AI-generated metadata,
So that information is captured automatically without manual note-taking regardless of format or origin.

## Acceptance Criteria

1. **Given** a file path to any supported document (PDF, .docx, .txt, .md, .html, .csv, .json, .xml) is submitted for ingestion, **When** the ingestion processor extracts/reads the content and the AI agent analyzes it, **Then** a knowledge bubble is created with an AI-generated title, processed content, source type reference, original file path in metadata, and AI-generated tags
2. **Given** a voice memo transcription is submitted for ingestion, **When** the ingestion agent processes it, **Then** a knowledge bubble is created with the transcribed content, source "voice-memo", an AI-generated title (if not provided), and AI-generated tags
3. **Given** plain text is submitted with a title, **When** ingestion runs, **Then** a bubble is created with the provided text, auto-generated tags from AI analysis, and the provided title preserved
4. **Given** plain text is submitted without a title, **When** ingestion runs, **Then** the AI agent generates a concise, descriptive title from the content
5. **Given** a web URL is submitted for ingestion, **When** the ingestion agent fetches and processes it, **Then** a knowledge bubble is created with the extracted page content, source "url", the original URL stored in metadata, and AI-generated tags
6. **Given** a file type the system cannot extract text from (e.g., binary, video, compressed archive), **When** ingestion is attempted, **Then** the request fails gracefully with a descriptive error and a `knowledge:ingest:failed` event is emitted
7. **Given** ingestion is triggered via a pipeline step or event (including `media:received` from Telegram), **When** the event payload contains content or a file path, **Then** the content is processed through the ingestion flow automatically and a `knowledge:ingest:complete` event is emitted

## Tasks / Subtasks

- [x] Task 1: Shared types — ingestion schemas, extended bubble metadata, and event types (AC: #1–#7)
  - [x] 1.1 Add `IngestKnowledgeSchema` Zod schema to `packages/shared/src/types/knowledge.ts` with types: `text`, `file`, `voice-memo`, `url`
  - [x] 1.2 Extend `KnowledgeBubble` and frontmatter with optional `source_file` field (relative path in `data/media/`)
  - [x] 1.3 Extend `CreateKnowledgeBubbleSchema` with optional `sourceFile` field
  - [x] 1.4 Add ingestion event types to `packages/shared/src/types/events.ts` (`knowledge:ingest:request`, `knowledge:ingest:complete`, `knowledge:ingest:failed`)
  - [x] 1.5 Export new types from `packages/shared/src/types/index.ts`

- [x] Task 2: Content extraction utilities (AC: #1, #5, #6)
  - [x] 2.1 Add `unpdf` dependency to `packages/core/package.json`
  - [x] 2.2 Create `packages/core/src/knowledge-engine/content-extractor.ts` with:
    - `extractFromFile(filePath)` — routes by extension/MIME: PDF → `unpdf`, text-based (.txt, .md, .html, .csv, .json, .xml, .ts, .js, etc.) → direct `readFileSync`, unsupported → throw
    - `extractFromUrl(url)` — fetches URL content, strips HTML to text (basic DOM text extraction)
    - `detectFileType(filePath)` — returns category: 'pdf' | 'text' | 'unsupported' based on extension
    - `copyToMediaDir(sourcePath, mediaDir)` — copies source file to `data/media/` if not already there, returns relative path
  - [x] 2.3 Handle extraction errors gracefully (corrupted PDF, empty content, unreachable URL, unsupported type)

- [x] Task 3: Ingestion processor — core async flow (AC: #1–#7)
  - [x] 3.1 Create `packages/core/src/knowledge-engine/ingestion.ts` with factory function `createIngestionProcessor(deps)`
  - [x] 3.2 Implement `ingest()` method: validates input → copies source file to `data/media/` → extracts content → emits `agent:task:request` for AI analysis → listens for completion → creates bubble (with `sourceFile` reference) via `knowledgeStore.insert()` → emits `knowledge:ingest:complete`
  - [x] 3.3 Build AI prompt that instructs the agent to return structured JSON: `{ title, tags, summary }`
  - [x] 3.4 Implement result parser that extracts structured JSON from agent output text
  - [x] 3.5 Handle agent task failure — emit `knowledge:ingest:failed` event with error details

- [x] Task 4: API endpoint — ingestion route (AC: #1–#6)
  - [x] 4.1 Add `POST /api/knowledge/ingest` endpoint in `packages/core/src/api/routes/knowledge.ts`
  - [x] 4.2 Validate request body with `IngestKnowledgeSchema`
  - [x] 4.3 Return `{ taskId }` immediately (202 Accepted) — ingestion is async
  - [x] 4.4 Add `GET /api/knowledge/ingest/:taskId` for polling ingestion status (reuse agent task status from execution logger)

- [x] Task 5: Event-driven ingestion handler (AC: #7)
  - [x] 5.1 Register `knowledge:ingest:request` event handler in ingestion processor
  - [x] 5.2 Wire ingestion processor into boot sequence in `packages/core/src/index.ts` — ensure `data/media/` directory created on boot (like `data/knowledge/`)
  - [x] 5.3 Ensure pipeline nodes can trigger ingestion by emitting `knowledge:ingest:request` events
  - [x] 5.4 Document how `media:received` events from Telegram (story 3.4) can be routed to ingestion — the orchestrator or a pipeline can bridge `media:received` → `knowledge:ingest:request`

- [x] Task 6: Tests (AC: #1–#7)
  - [x] 6.1 Unit tests for content extractor: PDF extraction, text file read, markdown read, HTML text extraction, URL fetch, unsupported file rejection, missing file, oversized file, unreachable URL, copyToMediaDir (new file, already-in-media-dir skip, filename collision)
  - [x] 6.2 Ingestion processor tests: text ingestion, file ingestion (PDF + text-based), voice-memo ingestion, URL ingestion, missing title generation, agent failure handling, result parsing, unsupported file type failure, sourceFile reference stored in bubble
  - [x] 6.3 API route tests: POST /ingest validation, 202 response with taskId, invalid type rejection, missing required fields

## Dev Notes

### Architecture — Async AI-Powered Ingestion

The ingestion pipeline adds an AI processing layer on top of story 6.1's synchronous CRUD. The key difference:
- **Story 6.1** (`POST /api/knowledge`): Synchronous CRUD — user provides title, content, tags directly
- **Story 6.2** (`POST /api/knowledge/ingest`): Async AI pipeline — system extracts content from any source, generates title/tags/summary via Claude

**Ingestion Flow:**
```
POST /api/knowledge/ingest
  → Validate input (Zod)
  → Extract content based on type:
      file  → copy source file to data/media/ → detectFileType → PDF? unpdf : readFileSync
      url   → fetch + strip HTML (no file to store)
      text/voice-memo → use content directly (no file to store)
  → Emit agent:task:request (Claude analyzes content → returns { title, tags, summary })
  → Return { taskId } (202 Accepted)

  [async]
  → Agent completes → parse structured output
  → knowledgeStore.insert({ title, content, tags, source, sourceFile })
  → Emit knowledge:ingest:complete { bubbleId, taskId }
```

**Event-driven flow (pipeline/event trigger):**
```
knowledge:ingest:request event
  → Same flow as above, but triggered by event bus instead of API
```

**Telegram media → knowledge ingestion bridge:**
```
Telegram file received → media:received event (story 3.4, already done)
  → Files already saved to data/media/ by Telegram bot
  → Orchestrator routes to skill OR pipeline step
  → Pipeline/orchestrator emits knowledge:ingest:request { type: 'file', filePath: 'data/media/...' }
  → Ingestion flow detects file is already in data/media/, skips copy
  → Processes and creates bubble with sourceFile reference
```
This bridge is NOT built in this story — but the ingestion processor's event handler makes it possible. The orchestrator or a pipeline definition connects these.

### Source File Storage — `data/media/`

**All source files are stored in `data/media/` and referenced from knowledge bubbles.**

```
data/
├── knowledge/                    # Knowledge bubble markdown files (story 6.1)
│   ├── sqlite-backup-strategies.md
│   └── event-driven-architecture.md
├── media/                        # Source files for ingested content
│   ├── 1710672000000-report.pdf  # Telegram upload (story 3.4 naming)
│   ├── conference-talk-notes.pdf # API-ingested file
│   └── lab-results-march.pdf     # Pipeline-ingested file
└── raven.db
```

**Storage rules:**
- **File ingestion:** Source file is copied to `data/media/` before processing. If the file is already in `data/media/` (e.g., Telegram uploads from story 3.4), no copy — use as-is.
- **URL ingestion:** No file stored in `data/media/` — the URL itself is the reference (stored in frontmatter as `source_url`).
- **Text / voice-memo:** No file stored — content is the knowledge bubble itself.
- **Filename in media dir:** Preserve original filename. Handle collisions by prepending timestamp: `{Date.now()}-{originalName}`.
- **The `source_file` field in bubble frontmatter** stores the relative path from project root: `data/media/report.pdf`.

**Knowledge bubble frontmatter with source reference:**
```yaml
---
id: a1b2c3d4-...
title: Quarterly Lab Results Analysis
tags:
  - health
  - lab-results
source: "file:pdf"
source_file: "data/media/lab-results-march.pdf"    # NEW — relative path to source file
source_url: null                                     # NEW — original URL (for url type)
created_at: "2026-03-17T10:30:00.000Z"
updated_at: "2026-03-17T10:30:00.000Z"
---

# Quarterly Lab Results Analysis

Key findings from the March 2026 lab results...
```

### Supported Content Types

| Ingestion Type | Source | Content Extraction |
|---|---|---|
| `text` | Direct text content | No extraction needed — content used as-is |
| `voice-memo` | Transcribed text (from Gemini/Telegram) | No extraction needed — already text |
| `file` | Any file path on disk | Routes by extension (see table below) |
| `url` | Web URL | Fetch page, extract text content |

**File type routing by extension:**

| Category | Extensions | Extraction Method |
|---|---|---|
| PDF | `.pdf` | `unpdf` library → extracted text |
| Text-based | `.txt`, `.md`, `.markdown`, `.html`, `.htm`, `.csv`, `.json`, `.xml`, `.yaml`, `.yml`, `.ts`, `.js`, `.py`, `.log`, `.env`, `.toml`, `.ini`, `.cfg`, `.rst`, `.tex` | Direct `readFileSync` as UTF-8 |
| Unsupported | Everything else (`.zip`, `.mp4`, `.exe`, `.png`, `.jpg`, etc.) | Reject with descriptive error |

**HTML special handling:** For `.html`/`.htm` files (and URL fetches), strip HTML tags to extract text content. Use a simple regex-based approach — no heavy DOM library needed for single-user knowledge ingestion:
```typescript
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

### Shared Types — `packages/shared/src/types/knowledge.ts`

**Extend existing interfaces** — add optional source file/URL references:

```typescript
// Add to KnowledgeBubble interface:
export interface KnowledgeBubble {
  // ... existing fields ...
  sourceFile: string | null;    // NEW — relative path to source file in data/media/
  sourceUrl: string | null;     // NEW — original URL for url-type ingestions
}

// Add to KnowledgeBubbleSummary interface:
export interface KnowledgeBubbleSummary {
  // ... existing fields ...
  sourceFile: string | null;    // NEW
  sourceUrl: string | null;     // NEW
}

// Extend CreateKnowledgeBubbleSchema:
export const CreateKnowledgeBubbleSchema = z.object({
  // ... existing fields ...
  sourceFile: z.string().max(500).nullable().optional(),  // NEW
  sourceUrl: z.string().url().nullable().optional(),      // NEW
});

// Extend UpdateKnowledgeBubbleSchema:
export const UpdateKnowledgeBubbleSchema = z.object({
  // ... existing fields ...
  sourceFile: z.string().max(500).nullable().optional(),  // NEW
  sourceUrl: z.string().url().nullable().optional(),      // NEW
});
```

**Extend `BubbleFrontmatter`** in `knowledge-file.ts`:
```typescript
export interface BubbleFrontmatter {
  // ... existing fields ...
  source_file: string | null;   // NEW — relative path: "data/media/report.pdf"
  source_url: string | null;    // NEW — original URL
}
```

**Note:** The frontmatter uses `snake_case` (YAML convention, matching existing `created_at`/`updated_at`), while the TypeScript interfaces use `camelCase`. The store maps between them on read/write — follow the existing pattern in `knowledge-store.ts`.

**DB schema extension** — add columns to `knowledge_index`:

```sql
-- Migration 006 or ALTER TABLE in the migration file
ALTER TABLE knowledge_index ADD COLUMN source_file TEXT;
ALTER TABLE knowledge_index ADD COLUMN source_url TEXT;
```

Create `migrations/006-knowledge-source-refs.sql` for this.

**New ingestion schema:**

```typescript
export const IngestKnowledgeSchema = z.object({
  type: z.enum(['text', 'file', 'voice-memo', 'url']),
  content: z.string().optional(),              // Required for text/voice-memo
  filePath: z.string().optional(),             // Required for file
  url: z.string().url().optional(),            // Required for url
  title: z.string().min(1).max(500).optional(), // AI generates if missing
  source: z.string().max(100).optional(),      // Auto-derived if missing (see defaults below)
  tags: z.array(z.string().min(1).max(100)).max(50).optional(), // Hint tags — AI may add more
}).refine(
  (data) => {
    if (data.type === 'file') return !!data.filePath;
    if (data.type === 'url') return !!data.url;
    return !!data.content;  // text, voice-memo need content
  },
  { message: 'file requires filePath; url requires url; text and voice-memo require content' }
);

export type IngestKnowledge = z.infer<typeof IngestKnowledgeSchema>;

export interface IngestionResult {
  taskId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  bubbleId?: string;    // Set on completion
  error?: string;       // Set on failure
}
```

**Source defaults when not provided:**

| Type | Default Source |
|---|---|
| `text` | `'manual'` |
| `voice-memo` | `'voice-memo'` |
| `file` | `'file:<extension>'` e.g. `'file:pdf'`, `'file:md'` |
| `url` | `'url'` |

### Event Types — `packages/shared/src/types/events.ts`

Add three new events following existing knowledge event pattern:

```typescript
export interface KnowledgeIngestRequestEvent extends BaseEvent {
  type: 'knowledge:ingest:request';
  payload: {
    taskId: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
    content?: string;
    filePath?: string;
    url?: string;
    title?: string;
    source?: string;
    tags?: string[];
  };
}

export interface KnowledgeIngestCompleteEvent extends BaseEvent {
  type: 'knowledge:ingest:complete';
  payload: {
    taskId: string;
    bubbleId: string;
    title: string;
    filePath: string;      // Knowledge bubble file path (in data/knowledge/)
    sourceFilePath?: string; // Original source file (for file type)
    sourceUrl?: string;      // Original URL (for url type)
  };
}

export interface KnowledgeIngestFailedEvent extends BaseEvent {
  type: 'knowledge:ingest:failed';
  payload: {
    taskId: string;
    error: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
  };
}
```

Add all three to the `RavenEvent` union type and `RavenEventType` string union.

### Content Extractor — `packages/core/src/knowledge-engine/content-extractor.ts`

Replaces the narrow "pdf-extractor" with a general-purpose content extraction module.

```typescript
import { extractText } from 'unpdf';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { createLogger } from '@raven/shared';

const log = createLogger('content-extractor');

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.html', '.htm', '.csv', '.json',
  '.xml', '.yaml', '.yml', '.ts', '.js', '.py', '.log',
  '.toml', '.ini', '.cfg', '.rst', '.tex', '.env',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export type FileCategory = 'pdf' | 'text' | 'unsupported';

export function detectFileType(filePath: string): FileCategory {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

export async function extractFromFile(filePath: string): Promise<string> {
  // 1. Check file exists and get size
  // 2. Reject if > MAX_FILE_SIZE_BYTES
  // 3. detectFileType → route:
  //    pdf → readFileSync buffer → extractText({ data }) from unpdf → join pages
  //    text → readFileSync as utf-8
  //    unsupported → throw Error('Unsupported file type: <ext>')
  // 4. If HTML extension, stripHtml() before returning
  // 5. Return extracted text
}

export async function extractFromUrl(url: string): Promise<string> {
  // 1. fetch(url) with timeout (30s)
  // 2. Check response ok
  // 3. Get response text
  // 4. If content-type is HTML, stripHtml()
  // 5. Truncate to reasonable limit (500KB of text)
  // 6. Return text content
}

export function copyToMediaDir(params: {
  sourcePath: string;
  mediaDir: string;
}): string {
  // 1. Check if sourcePath is already inside mediaDir → return relative path as-is (skip copy)
  // 2. Get original filename from sourcePath
  // 3. Build target path: mediaDir/filename
  // 4. If target exists (collision), prepend timestamp: mediaDir/{Date.now()}-{filename}
  // 5. copyFileSync(sourcePath, targetPath)
  // 6. Return relative path from project root: "data/media/{filename}"
}

function stripHtml(html: string): string {
  // Remove script/style tags, then all HTML tags, collapse whitespace
}
```

**Key notes:**
- `extractFromFile` is `async` because `unpdf.extractText()` is async. For text files, it's still effectively sync (readFileSync) but wrapped in async for uniform interface.
- `extractFromUrl` uses native `fetch()` (available in Node 22).
- `stripHtml` is intentionally simple — no jsdom/cheerio dependency. Regex strip is sufficient for knowledge ingestion of single-user content.
- The `TEXT_EXTENSIONS` set is deliberately generous — if it's a text file, we can read it. Better to ingest slightly messy content than reject valid files.

### Ingestion Processor — `packages/core/src/knowledge-engine/ingestion.ts`

**Factory function:**
```typescript
export interface IngestionDeps {
  knowledgeStore: KnowledgeStore;
  eventBus: EventBus;
  executionLogger: ExecutionLogger;  // For tracking task status
}

export interface IngestionProcessor {
  ingest: (input: IngestKnowledge) => Promise<{ taskId: string }>;
  start: () => void;   // Register event handlers
}

export function createIngestionProcessor(deps: IngestionDeps): IngestionProcessor
```

**`ingest()` implementation outline:**

```
1. Generate taskId via generateId()
2. Resolve source file and extract content based on type:
   - text / voice-memo → use input.content directly, sourceFile = null
   - file → copyToMediaDir(input.filePath, mediaDir) → get sourceFile relative path
          → await extractFromFile(input.filePath)
          → if unsupported, emit knowledge:ingest:failed, return { taskId }
   - url → await extractFromUrl(input.url), sourceFile = null, sourceUrl = input.url
3. Determine source: input.source ?? derive default from type + extension
4. Build AI prompt (see below)
5. Emit agent:task:request event:
   {
     taskId,
     prompt: buildIngestionPrompt({ content, title, tags, source, type, sourceFile, sourceUrl }),
     skillName: 'knowledge-ingestion',
     priority: 'normal',
   }
6. Register one-time listener for agent:task:complete matching taskId
7. On completion:
   a. Parse agent output for { title, tags, summary }
   b. Create bubble: knowledgeStore.insert({ title, content, source, tags, sourceFile, sourceUrl })
   c. Emit knowledge:ingest:complete { bubbleId, taskId, sourceFile?, sourceUrl? }
8. On failure:
   a. Emit knowledge:ingest:failed
9. Return { taskId }
```

**The `sourceFile` field enables sub-agents to access the original source material.** Knowledge bubbles store an AI-generated summary and extracted text, but the original document at `sourceFile` retains full fidelity. When a sub-agent needs deeper detail than the bubble provides — richer context, exact figures, charts, or full document structure — it can `Read` the source file directly. This two-tier model (bubble for fast retrieval + source file for deep dives) means story 6.4's context injection can start with bubble summaries and let agents drill into originals on demand, without bloating every prompt with full document content.

**`start()` implementation:**
Register handler for `knowledge:ingest:request` events → calls `ingest()`.

### AI Prompt for Ingestion Agent

The agent task prompt instructs Claude to return structured JSON:

```
You are a knowledge ingestion agent for a personal knowledge management system. Analyze the following content and return a JSON object.

Requirements:
1. "title": A concise, descriptive title (max 100 chars). ${input.title ? `Use exactly this title: "${input.title}"` : 'Generate a clear title from the content.'}
2. "tags": An array of 3-8 relevant tags (lowercase, single words or short hyphenated phrases). ${input.tags?.length ? `Include these hint tags: ${JSON.stringify(input.tags)}. Add more relevant ones.` : 'Generate from content themes.'}
3. "summary": A 1-3 sentence summary of the key information.

Source: ${source} ${originalPath ? `(file: ${originalPath})` : ''} ${originalUrl ? `(url: ${originalUrl})` : ''}

Content to analyze:
---
${content.slice(0, MAX_CONTENT_FOR_PROMPT)}
---

Return ONLY a valid JSON object, no markdown fencing, no explanation. Example:
{"title": "SQLite Backup Strategies", "tags": ["database", "sqlite", "backup", "ops"], "summary": "Overview of backup approaches for SQLite databases including WAL mode considerations."}
```

**Content truncation:** Limit content passed to the agent to 30,000 characters (~7,500 tokens) to keep context manageable. The full content is stored in the bubble regardless.

### Agent Output Parsing

The agent's response text needs to be parsed for JSON. The agent might return:
- Clean JSON: `{"title": "...", "tags": [...], "summary": "..."}`
- JSON in markdown fencing: `` ```json ... ``` ``
- JSON mixed with explanation text

**Parser strategy:**

```typescript
function parseIngestionResult(agentOutput: string): {
  title: string;
  tags: string[];
  summary: string;
} {
  // 1. Try JSON.parse on the full output (trimmed)
  // 2. If fails, extract JSON from markdown code fences (```json ... ```)
  // 3. If fails, find first { and last } and try parsing that substring
  // 4. If all fail, throw with descriptive error
  // 5. Validate required fields exist (title must be string, tags must be array)
  // 6. Sanitize: trim title, lowercase tags, trim summary
}
```

### Agent Task Completion Listening

The ingestion processor listens for `agent:task:complete` events for specific taskIds. Pattern from pipeline executor:

```typescript
function waitForTaskCompletion(params: {
  eventBus: EventBus;
  taskId: string;
  timeoutMs: number;
}): Promise<{ result?: string; error?: string }>
```

Use a one-time event listener with a timeout (default 120s). On `agent:task:complete` matching taskId → resolve. On timeout → reject with error. On `agent:task:failed` → reject with error.

**Important:** Check the `AgentTaskCompleteEvent` and `AgentTaskFailedEvent` interfaces in events.ts to match the correct event type names and payload shapes. The actual event names may be `agent:task:complete` or similar — verify in the codebase.

### API Route — Add to existing `knowledge.ts`

Add to `packages/core/src/api/routes/knowledge.ts`:

```typescript
// POST /api/knowledge/ingest — async AI-powered ingestion
app.post('/api/knowledge/ingest', async (request, reply) => {
  const parsed = IngestKnowledgeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });

  const { taskId } = await deps.ingestionProcessor.ingest(parsed.data);
  return reply.status(HTTP_STATUS.ACCEPTED).send({ taskId });
});
```

**Route registration order:** Register `/api/knowledge/ingest` BEFORE `/api/knowledge/:id` (same pattern as `/api/knowledge/tags` and `/api/knowledge/reindex`).

**Update `KnowledgeRouteDeps`:** Add `ingestionProcessor` to the deps interface.

### Boot Sequence Wiring — `packages/core/src/index.ts`

After knowledge store creation (existing), add:

```typescript
// 12e. Init knowledge ingestion processor
const ingestionProcessor = createIngestionProcessor({
  knowledgeStore,
  eventBus,
  executionLogger,
});
ingestionProcessor.start(); // Register event handlers
```

Pass `ingestionProcessor` through to `ApiDeps` → knowledge routes.

### File Structure — New Files

```
migrations/006-knowledge-source-refs.sql                   # ALTER TABLE: add source_file, source_url columns
packages/core/src/knowledge-engine/content-extractor.ts    # Multi-format content extraction (PDF, text, HTML, URL) + copyToMediaDir
packages/core/src/knowledge-engine/ingestion.ts            # Ingestion processor (factory, AI prompt, completion handler)
packages/core/src/__tests__/knowledge-ingestion.test.ts    # Ingestion + extractor tests
```

### File Structure — Modified Files

```
packages/shared/src/types/knowledge.ts       # Add IngestKnowledgeSchema, extend KnowledgeBubble with sourceFile/sourceUrl
packages/shared/src/types/events.ts          # Add 3 ingestion event types to union
packages/shared/src/types/index.ts           # Export new types
packages/core/src/knowledge-engine/knowledge-file.ts   # Extend BubbleFrontmatter with source_file, source_url
packages/core/src/knowledge-engine/knowledge-store.ts  # Handle sourceFile/sourceUrl in insert/update/getById/list, map camelCase↔snake_case
packages/core/src/api/routes/knowledge.ts    # Add POST /ingest endpoint, update deps interface
packages/core/src/api/server.ts              # Pass ingestionProcessor in deps
packages/core/src/index.ts                   # Create and wire ingestion processor, ensure data/media/ dir exists
packages/core/package.json                   # Add unpdf dependency
package-lock.json                            # Updated by npm install
```

### New Dependency

```bash
npm install unpdf -w packages/core
```

`unpdf` — modern ESM-native PDF text extraction library from the UnJS ecosystem. Wraps Mozilla's pdf.js, optimized for Node.js/serverless. TypeScript-first, actively maintained (2026). Only needed for PDF files — all other text-based formats use direct `readFileSync`. This is the only new dependency for this story.

### Architecture Constraints

- **No classes** — factory functions only
- **No `console.log`** — use `createLogger('ingestion')` / `createLogger('content-extractor')`
- **`.ts` extensions** in all relative imports
- **Zod validation** at API boundary (`IngestKnowledgeSchema.safeParse`)
- **ISO 8601 strings** for all timestamps
- **`crypto.randomUUID()`** via `generateId()` for task IDs
- **Max 300 lines per file** — content-extractor.ts and ingestion.ts should stay well under this
- **Max 50 lines per function** — extract sub-functions (prompt builder, result parser, completion handler, each extraction method)
- **`node:` prefix** for Node.js builtins
- **No base64 for files** — use file paths on disk (feedback memory)
- **No heavy DOM libraries** — use regex-based HTML stripping (no jsdom, cheerio, etc.)
- **Mock `@anthropic-ai/claude-code` in all tests** — never spawn real Claude subprocesses
- **`agent:task:request` is the ONLY way to run Claude** — never import the SDK directly in ingestion code

### Existing Infrastructure to Reuse (DO NOT Recreate)

| Component | Location | Reuse How |
|---|---|---|
| `KnowledgeStore` | `knowledge-engine/knowledge-store.ts` | Call `insert()` after agent completes |
| `KnowledgeStore.insert()` | knowledge-store.ts | Creates bubble (file + index + FTS) |
| `EventBus` | `event-bus/event-bus.ts` | Emit/listen for ingestion + agent events |
| `generateId()` | `@raven/shared` | Task IDs |
| `createLogger()` | `@raven/shared` | Logging |
| `HTTP_STATUS` | `@raven/shared` | Status codes (use `ACCEPTED` = 202) |
| `ExecutionLogger` | `execution-logging/` | Track agent task status for polling |
| `AgentManager` event flow | `agent-manager/` | Emit `agent:task:request`, listen for `agent:task:complete` |
| `media:received` event | Story 3.4 (done) | Telegram files already saved to `data/media/` — can be ingested via `type: 'file'`, copyToMediaDir detects they're already there |
| `data/media/` directory | Story 3.4 created it | Canonical location for all source media files — Telegram uploads + API-ingested files share this dir |
| `knowledge-file.ts` helpers | `knowledge-engine/knowledge-file.ts` | `slugify`, file I/O (used internally by store) |
| Existing `POST /api/knowledge` route | `api/routes/knowledge.ts` | Pattern reference for the new endpoint |
| Native `fetch()` | Node.js 22 built-in | URL content fetching — no external HTTP library |

### Testing Strategy

**Content extractor tests** (unit):
- PDF file → returns extracted text (mock `unpdf`)
- Text file (.txt) → returns file contents
- Markdown file (.md) → returns file contents
- HTML file → returns stripped text (no tags)
- CSV file → returns raw CSV text
- JSON file → returns raw JSON text
- URL fetch → returns page text content (mock `fetch`)
- URL fetch of HTML page → returns stripped text
- Unsupported file (.zip, .png) → throws descriptive error
- Non-existent file → throws descriptive error
- Oversized file (>50MB, mock stat) → throws size limit error
- Unreachable URL → throws descriptive error
- URL fetch timeout → throws timeout error

**Ingestion processor tests** (integration, mock Claude SDK):
- Text ingestion with title: emits agent task, parses result, creates bubble with provided title
- Text ingestion without title: AI generates title from content
- File ingestion (PDF): extracts text, processes through agent, creates bubble with source "file:pdf"
- File ingestion (text-based): reads file, processes through agent
- File ingestion (unsupported): emits `knowledge:ingest:failed`, no bubble created
- URL ingestion: fetches content, processes through agent, creates bubble with source "url" and sourceUrl in event
- Voice-memo ingestion: processes provided content with source "voice-memo"
- Agent returns clean JSON → parsed correctly
- Agent returns JSON in markdown fences → extracted and parsed
- Agent returns JSON mixed with text → extracted and parsed
- Agent failure → `knowledge:ingest:failed` event emitted, no bubble created
- Agent timeout → failed event emitted
- Hint tags included in prompt and merged with AI-generated tags
- Content truncation: very long content truncated to 30,000 chars in prompt
- Event-driven: `knowledge:ingest:request` event → triggers full ingestion flow

**Mock pattern for agent tasks:**
```typescript
// Mock the event bus to capture agent:task:request
// Then simulate agent:task:complete with structured JSON output
eventBus.on('agent:task:request', (event) => {
  // Verify prompt contains expected content
  // Simulate completion
  eventBus.emit({
    type: 'agent:task:complete',
    payload: {
      taskId: event.payload.taskId,
      result: JSON.stringify({ title: 'Test Title', tags: ['test'], summary: 'Test summary' }),
    },
  });
});
```

**API route tests** (integration):
- POST /api/knowledge/ingest with valid text → 202 + `{ taskId }`
- POST /api/knowledge/ingest with valid file path → 202
- POST /api/knowledge/ingest with valid URL → 202
- POST /api/knowledge/ingest with missing content for text type → 400
- POST /api/knowledge/ingest with missing filePath for file type → 400
- POST /api/knowledge/ingest with missing url for url type → 400
- POST /api/knowledge/ingest with invalid type → 400
- POST /api/knowledge/ingest with invalid URL format → 400

### Previous Story Intelligence (Story 6.1)

Key learnings to apply:
- **FTS5 query sanitization**: Story 6.1 added `sanitizeFtsQuery()` to strip special chars from search input. Apply similar input sanitization for agent prompt content.
- **Transaction wrapping**: Story 6.1 wraps CRUD index operations in transactions. The ingestion processor calls `knowledgeStore.insert()` which already handles this.
- **`max-lines-per-function` (50)**: Plan from the start. Extract `buildIngestionPrompt()`, `parseIngestionResult()`, `handleCompletion()`, `extractFromFile()`, `extractFromUrl()`, `stripHtml()` as separate functions.
- **Magic numbers**: Extract `MAX_CONTENT_FOR_PROMPT = 30000`, `INGESTION_TIMEOUT_MS = 120000`, `MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024`, `URL_FETCH_TIMEOUT_MS = 30000`, `MAX_URL_CONTENT_BYTES = 512000`.
- **gray-matter** already installed in `packages/core` — no duplicate dependency needed.
- **`content_preview`** column exists in `knowledge_index` — `insert()` handles it automatically.
- **Pino logger**: Use string-only `log.info(msg)`, not structured `log.info(obj, msg)`. This project's Pino config uses string messages only.

### Git Intelligence

Recent commits show:
- Story 6.1 (`5d076ad`) added the complete knowledge engine — store, file helpers, API routes, tests
- Story 3.4 added media routing from Telegram — files saved to `data/media/` with event-driven routing
- All stories follow `feat: description (story X.Y)` commit format
- Code review fixes are separate commits: `fix: description`
- 659 tests currently pass — zero regressions expected

### Anti-Patterns to Avoid

1. **DO NOT import `@anthropic-ai/claude-code` directly** — use event bus `agent:task:request` pattern. The agent manager handles all Claude SDK interaction.
2. **DO NOT make ingestion synchronous** — it uses Claude for AI analysis, which is inherently async. Return taskId immediately.
3. **DO NOT add clustering or auto-organization** — that's story 6.3.
4. **DO NOT add context injection for sub-agents** — that's story 6.4.
5. **DO NOT add frontend UI** — this is API-only infrastructure.
6. **DO NOT use base64 for file content** — use file paths on disk (feedback memory).
7. **DO NOT reinvent the knowledge store** — use `knowledgeStore.insert()` for all bubble creation.
8. **DO NOT reinvent agent task handling** — use the existing `agent:task:request` → `agent:task:complete` event flow.
9. **DO NOT add Google Drive file watching** — that's a future story (Epic 8). Pipeline integration here means emitting/handling `knowledge:ingest:request` events.
10. **DO NOT process raw audio files** — voice memos arrive as already-transcribed text (Gemini handles transcription in skill-telegram). The ingestion pipeline receives text, not audio.
11. **DO NOT add jsdom or cheerio** — use simple regex HTML stripping. This is single-user knowledge ingestion, not a web scraper.
12. **DO NOT build the Telegram→ingestion bridge** — story 3.4's `media:received` events already exist. The orchestrator or a pipeline config connects them to `knowledge:ingest:request`. This story provides the ingestion handler; wiring is a configuration concern.

### Project Structure Notes

- `content-extractor.ts` and `ingestion.ts` go in the existing `packages/core/src/knowledge-engine/` directory alongside `knowledge-store.ts` and `knowledge-file.ts`
- The ingestion processor is core infrastructure, NOT a skill/suite — it has no MCPs and doesn't need MCP isolation
- The Claude agent task for analysis runs through the standard agent manager — the ingestion processor only emits events
- `unpdf` is the sole new dependency, added to `packages/core/package.json`
- The `POST /api/knowledge/ingest` endpoint is added to the existing knowledge routes file, not a new routes file
- The `TEXT_EXTENSIONS` set should be generous — better to accept and ingest slightly messy text than reject valid content
- Native `fetch()` in Node.js 22 is used for URL fetching — no need for `node-fetch` or `axios`

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 6, Story 6.2]
- [Source: _bmad-output/planning-artifacts/prd.md — FR43 (system ingests text, audio, documents)]
- [Source: _bmad-output/planning-artifacts/prd.md — FR22 (send photos, files, screenshots for processing)]
- [Source: _bmad-output/planning-artifacts/architecture.md — Event bus patterns, Agent task flow, API conventions]
- [Source: _bmad-output/implementation-artifacts/3-4-media-and-file-routing.md — Telegram media routing, media:received events, data/media/ file storage]
- [Source: packages/core/src/knowledge-engine/knowledge-store.ts — Store API, insert() interface]
- [Source: packages/core/src/knowledge-engine/knowledge-file.ts — File helpers, frontmatter parsing]
- [Source: packages/shared/src/types/knowledge.ts — Existing Zod schemas, type exports]
- [Source: packages/shared/src/types/events.ts — Knowledge event patterns, BaseEvent interface]
- [Source: packages/core/src/agent-manager/agent-session.ts — Agent task execution flow]
- [Source: packages/core/src/api/routes/knowledge.ts — Existing route patterns, KnowledgeRouteDeps]
- [Source: packages/core/src/index.ts — Boot sequence, knowledge store wiring]
- [Source: _bmad-output/implementation-artifacts/6-1-knowledge-bubble-storage-and-crud.md — Previous story learnings]
- [Source: _bmad-output/project-context.md — Coding conventions, anti-patterns, testing rules]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- ✅ Task 1: Extended KnowledgeBubble/Summary interfaces with sourceFile/sourceUrl, added IngestKnowledgeSchema with Zod refine validation, added 3 ingestion event types to RavenEvent union, created migration 006
- ✅ Task 2: Created content-extractor.ts with detectFileType, extractFromFile (PDF via unpdf, text via readFileSync, HTML stripping), extractFromUrl (fetch with timeout), copyToMediaDir (collision handling, skip-if-already-there)
- ✅ Task 3: Created ingestion.ts with factory function, async ingest flow (extract → emit agent:task:request → wait for completion → parse JSON → create bubble), robust JSON parser (clean/fenced/mixed), deriveSource defaults
- ✅ Task 4: Added POST /api/knowledge/ingest endpoint returning 202 + taskId, validation via IngestKnowledgeSchema, updated KnowledgeRouteDeps and ApiDeps interfaces
- ✅ Task 5: Registered knowledge:ingest:request event handler, wired ingestion processor into boot sequence, ensured data/media/ created on boot
- ✅ Task 6: 42 new tests — content extractor unit tests (detectFileType, text/md/html/csv/json extraction, URL fetch, unsupported rejection, copyToMediaDir), ingestion processor integration tests (text/voice-memo/file/URL ingestion, agent output parsing variants, failure handling, event-driven flow, sourceFile/sourceUrl storage), API route tests (validation, 202 response, invalid inputs)

### Change Log

- 2026-03-17: Implemented story 6.2 — knowledge ingestion pipeline with AI-powered metadata generation
- 2026-03-17: Code review fixes — made ingestionProcessor required in KnowledgeRouteDeps, added GET /api/knowledge/ingest/:taskId polling endpoint (Task 4.4), passed executionLogger to knowledge routes

### File List

**New Files:**
- migrations/006-knowledge-source-refs.sql
- packages/core/src/knowledge-engine/content-extractor.ts
- packages/core/src/knowledge-engine/ingestion.ts
- packages/core/src/__tests__/knowledge-ingestion.test.ts

**Modified Files:**
- packages/shared/src/types/knowledge.ts
- packages/shared/src/types/events.ts
- packages/core/src/knowledge-engine/knowledge-file.ts
- packages/core/src/knowledge-engine/knowledge-store.ts
- packages/core/src/api/routes/knowledge.ts
- packages/core/src/api/server.ts
- packages/core/src/index.ts
- packages/core/package.json
- package-lock.json
