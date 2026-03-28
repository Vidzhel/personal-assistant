# Capability Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tightly-coupled suite system with a shared capability library where MCPs, skills, and vendor packages are independently referenceable.

**Architecture:** Three-layer library (`library/mcps/`, `library/skills/`, `library/vendor/`) loaded by a new `CapabilityLibrary` class that replaces `SuiteRegistry`. Agent definitions (currently in `suites/*/agents/*.ts`) become skill definitions under `library/skills/`. Services remain separate (moved to `library/services/`). The `CapabilityLibrary` exposes the same interface shape that current consumers (`AgentResolver`, `McpManager`, `Orchestrator`, `PermissionEngine`) depend on, enabling incremental migration.

**Tech Stack:** TypeScript ESM, Zod validation, Node.js `fs/promises`, existing `@raven/shared` patterns

**Key constraint:** The system must remain functional after each task. No big-bang migration.

---

## File Structure

### New files to create:

```
library/
├── mcps/
│   ├── ticktick.json
│   ├── gmail.json
│   └── markdownify.json
├── skills/
│   ├── _index.md
│   ├── file-management/
│   │   ├── _index.md
│   │   ├── documents/
│   │   │   ├── _index.md
│   │   │   ├── pdf/
│   │   │   │   ├── skill.md
│   │   │   │   └── config.json
│   │   │   ├── docx/
│   │   │   ├── xlsx/
│   │   │   └── pptx/
│   │   └── media/
│   │       ├── _index.md
│   │       ├── ffmpeg/
│   │       │   ├── skill.md
│   │       │   └── config.json
│   │       └── transcription/
│   │           ├── skill.md
│   │           └── config.json
│   ├── communication/
│   │   ├── _index.md
│   │   ├── email/
│   │   │   ├── _index.md
│   │   │   └── gmail/
│   │   │       ├── skill.md
│   │   │       └── config.json
│   │   └── messaging/
│   │       ├── _index.md
│   │       └── telegram/
│   │           ├── skill.md
│   │           └── config.json
│   ├── productivity/
│   │   ├── _index.md
│   │   ├── task-management/
│   │   │   ├── _index.md
│   │   │   └── ticktick/
│   │   │       ├── skill.md
│   │   │       └── config.json
│   │   ├── scheduling/
│   │   │   ├── _index.md
│   │   │   └── calendar/
│   │   │       ├── skill.md
│   │   │       └── config.json
│   │   └── briefing/
│   │       ├── _index.md
│   │       └── daily-digest/
│   │           ├── skill.md
│   │           └── config.json
│   ├── finance/
│   │   ├── _index.md
│   │   └── banking/
│   │       ├── _index.md
│   │       └── monobank/
│   │           ├── skill.md
│   │           └── config.json
│   └── system/
│       ├── _index.md
│       ├── orchestration/
│       │   ├── skill.md
│       │   └── config.json
│       ├── pattern-analysis/
│       │   ├── skill.md
│       │   └── config.json
│       └── config-management/
│           ├── skill.md
│           └── config.json
├── vendor/                            # moved from vendor/
│   ├── anthropic-skills/
│   ├── markdownify-mcp/
│   ├── smart-extractors/
│   └── claude-plugin-marketplace/
└── services/                          # moved from suites/*/services/
    ├── imap-watcher.ts
    ├── telegram-bot.ts
    ├── delivery-scheduler.ts
    ├── voice-transcriber.ts
    └── ... (other services)

packages/shared/src/
├── types/
│   └── library.ts                     # New: SkillConfig, McpDefinition, LibraryIndex types
└── library/
    └── schemas.ts                     # New: Zod schemas for library validation

packages/core/src/
└── capability-library/
    ├── library-loader.ts              # New: loads library/ from filesystem
    ├── capability-library.ts          # New: replaces SuiteRegistry
    ├── skill-catalog.ts               # New: builds Tier 0 catalog for agent prompts
    └── library-validator.ts           # New: validates library structure + references
```

### Files to modify:

```
packages/core/src/agent-registry/agent-resolver.ts  — resolve from skills instead of suiteIds
packages/core/src/mcp-manager/mcp-manager.ts        — read from library/mcps/ instead of suites
packages/core/src/orchestrator/orchestrator.ts       — use CapabilityLibrary instead of SuiteRegistry
packages/core/src/agent-manager/agent-manager.ts     — accept CapabilityLibrary
packages/core/src/index.ts                           — boot with CapabilityLibrary
packages/shared/src/types/agents.ts                  — NamedAgent.skills replaces suiteIds
packages/shared/src/suites/constants.ts              — add skill name constants
config/agents.json                                   — migrate suiteIds → skills
```

### Files to eventually remove (after migration verified):

```
packages/core/src/suite-registry/suite-loader.ts
packages/core/src/suite-registry/suite-registry.ts
suites/                                              # entire directory (contents migrated)
config/suites.json
config/skills.json
```

---

### Task 1: Define Library Types and Schemas

**Files:**
- Create: `packages/shared/src/types/library.ts`
- Create: `packages/shared/src/library/schemas.ts`
- Modify: `packages/shared/src/index.ts` (export new types)
- Test: `packages/shared/src/__tests__/library-schemas.test.ts`

- [ ] **Step 1: Write the failing test for SkillConfig schema validation**

```typescript
// packages/shared/src/__tests__/library-schemas.test.ts
import { describe, it, expect } from 'vitest';
import { SkillConfigSchema, McpDefinitionSchema, LibraryIndexSchema } from '../library/schemas.ts';

describe('McpDefinitionSchema', () => {
  it('validates a valid MCP definition', () => {
    const result = McpDefinitionSchema.safeParse({
      name: 'ticktick',
      displayName: 'TickTick Task Manager',
      command: 'node',
      args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
      env: { TICKTICK_ACCESS_TOKEN: '${TICKTICK_ACCESS_TOKEN}' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects MCP without command', () => {
    const result = McpDefinitionSchema.safeParse({
      name: 'bad',
      displayName: 'Bad',
    });
    expect(result.success).toBe(false);
  });
});

describe('SkillConfigSchema', () => {
  it('validates a valid skill config', () => {
    const result = SkillConfigSchema.safeParse({
      name: 'pdf',
      displayName: 'PDF Processing',
      description: 'Read, create, merge, split PDF files',
      mcps: ['markdownify'],
      vendorSkills: ['anthropic-skills/pdf'],
      tools: ['Bash', 'Read', 'Write'],
      model: 'sonnet',
      maxTurns: 10,
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional fields', () => {
    const result = SkillConfigSchema.parse({
      name: 'simple',
      displayName: 'Simple Skill',
      description: 'A simple skill',
    });
    expect(result.model).toBe('sonnet');
    expect(result.maxTurns).toBe(10);
    expect(result.mcps).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  it('rejects invalid model tier', () => {
    const result = SkillConfigSchema.safeParse({
      name: 'bad',
      displayName: 'Bad',
      description: 'Bad skill',
      model: 'gpt-4',
    });
    expect(result.success).toBe(false);
  });

  it('validates skill name is kebab-case', () => {
    const result = SkillConfigSchema.safeParse({
      name: 'NotKebab',
      displayName: 'Bad',
      description: 'Bad',
    });
    expect(result.success).toBe(false);
  });
});

describe('LibraryIndexSchema', () => {
  it('validates a library index entry', () => {
    const result = LibraryIndexSchema.safeParse({
      skills: [
        { name: 'pdf', path: 'file-management/documents/pdf', description: 'PDF ops' },
      ],
      mcps: [
        { name: 'ticktick', path: 'ticktick.json' },
      ],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/library-schemas.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the schemas and types**

```typescript
// packages/shared/src/library/schemas.ts
import { z } from 'zod';

const KebabCaseRegex = /^[a-z][a-z0-9-]*$/;

export const McpDefinitionSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const SkillConfigSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  displayName: z.string().min(1),
  description: z.string().min(1),

  // Dependencies
  mcps: z.array(z.string()).default([]),
  vendorSkills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  systemDeps: z.array(z.string()).default([]),

  // Execution
  model: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  maxTurns: z.number().int().positive().default(10),

  // Actions (permission tiers)
  actions: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    defaultTier: z.enum(['green', 'yellow', 'red']),
    reversible: z.boolean(),
  })).default([]),

  // Validation hints for harness
  expectedOutputs: z.array(z.object({
    type: z.enum(['file', 'data', 'text']),
    description: z.string(),
  })).default([]),
});

export const SkillIndexEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
});

export const McpIndexEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});

export const LibraryIndexSchema = z.object({
  skills: z.array(SkillIndexEntrySchema).default([]),
  mcps: z.array(McpIndexEntrySchema).default([]),
});
```

```typescript
// packages/shared/src/types/library.ts
import type { z } from 'zod';
import type {
  McpDefinitionSchema,
  SkillConfigSchema,
  LibraryIndexSchema,
  SkillIndexEntrySchema,
  McpIndexEntrySchema,
} from '../library/schemas.ts';

export type McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
export type LibraryIndex = z.infer<typeof LibraryIndexSchema>;
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;
export type McpIndexEntry = z.infer<typeof McpIndexEntrySchema>;

export interface LoadedSkill {
  config: SkillConfig;
  skillMd: string;
  path: string;             // relative path within library/skills/
  domain: string;            // top-level domain (file-management, communication, etc.)
}

export interface LoadedLibrary {
  skills: Map<string, LoadedSkill>;
  mcps: Map<string, McpDefinition>;
  vendorPaths: Map<string, string>;  // vendorSkill name → absolute path
  index: LibraryIndex;
}
```

- [ ] **Step 4: Export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export { McpDefinitionSchema, SkillConfigSchema, LibraryIndexSchema } from './library/schemas.ts';
export type { McpDefinition, SkillConfig, LoadedSkill, LoadedLibrary, LibraryIndex } from './types/library.ts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/__tests__/library-schemas.test.ts`
Expected: PASS

- [ ] **Step 6: Run full check**

Run: `npm run build -w packages/shared && npm run check`
Expected: PASS — no type errors, lint clean

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/library/ packages/shared/src/types/library.ts packages/shared/src/__tests__/library-schemas.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add capability library types and Zod schemas"
```

---

### Task 2: Create MCP Definition Files

**Files:**
- Create: `library/mcps/ticktick.json`
- Create: `library/mcps/gmail.json`
- Create: `library/mcps/markdownify.json`

No test needed — these are static JSON files. Validated by schemas in Task 1.

- [ ] **Step 1: Create library/mcps/ directory and extract MCPs from suites**

```bash
mkdir -p library/mcps
```

```json
// library/mcps/ticktick.json
{
  "name": "ticktick",
  "displayName": "TickTick Task Manager",
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-ticktick/src/index.ts"],
  "env": {
    "TICKTICK_CLIENT_ID": "${TICKTICK_CLIENT_ID}",
    "TICKTICK_CLIENT_SECRET": "${TICKTICK_CLIENT_SECRET}",
    "TICKTICK_ACCESS_TOKEN": "${TICKTICK_ACCESS_TOKEN}"
  }
}
```

```json
// library/mcps/gmail.json
{
  "name": "gmail",
  "displayName": "Gmail",
  "command": "npx",
  "args": ["-y", "@shinzolabs/gmail-mcp"],
  "env": {
    "GMAIL_CLIENT_ID": "${GMAIL_CLIENT_ID}",
    "GMAIL_CLIENT_SECRET": "${GMAIL_CLIENT_SECRET}",
    "GMAIL_REFRESH_TOKEN": "${GMAIL_REFRESH_TOKEN}"
  }
}
```

```json
// library/mcps/markdownify.json
{
  "name": "markdownify",
  "displayName": "Markdownify Document Extractor",
  "command": "node",
  "args": ["library/vendor/markdownify-mcp/dist/index.js"],
  "env": {}
}
```

- [ ] **Step 2: Commit**

```bash
git add library/mcps/
git commit -m "feat(library): extract MCP definitions from suites to library/mcps/"
```

---

### Task 3: Create Initial Skill Structure

**Files:**
- Create: All `_index.md` files and initial `config.json` + `skill.md` for each skill
- Focus on 3 representative skills first: `ticktick`, `gmail`, `pdf`

- [ ] **Step 1: Create domain index files**

```markdown
<!-- library/skills/_index.md -->
# Raven Skill Library

Available skill domains:

- **file-management** — Document and media processing (PDF, DOCX, XLSX, PPTX, ffmpeg)
- **communication** — Email and messaging (Gmail, Telegram)
- **productivity** — Task management, scheduling, briefings (TickTick, Calendar, Digest)
- **finance** — Banking and budgeting (Monobank, PrivatBank, YNAB)
- **system** — Internal orchestration, pattern analysis, config management
```

Create similar `_index.md` files for each domain and category. These are navigational — they list what's inside and when to use each skill.

- [ ] **Step 2: Create ticktick skill (extracted from suites/task-management/agents/ticktick-agent.ts)**

```json
// library/skills/productivity/task-management/ticktick/config.json
{
  "name": "ticktick",
  "displayName": "TickTick Task Management",
  "description": "Manage tasks, projects, and lists in TickTick",
  "mcps": ["ticktick"],
  "tools": ["Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 10,
  "actions": [
    { "name": "ticktick:get-tasks", "description": "Read tasks from TickTick", "defaultTier": "green", "reversible": true },
    { "name": "ticktick:get-task-details", "description": "Read task details", "defaultTier": "green", "reversible": true },
    { "name": "ticktick:create-task", "description": "Create new task in TickTick", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:update-task", "description": "Update existing task", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:complete-task", "description": "Mark task complete", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:delete-task", "description": "Delete task permanently", "defaultTier": "red", "reversible": false }
  ]
}
```

```markdown
<!-- library/skills/productivity/task-management/ticktick/skill.md -->
You are a TickTick task management agent within Raven personal assistant.

## Capabilities

You have access to the TickTick MCP server which provides tools for managing tasks, projects, and lists.

## Guidelines

- When creating tasks, always set a due date if the user mentions any time reference
- Use project/list context from the conversation to assign tasks to the right project
- For task queries, default to showing incomplete tasks unless asked otherwise
- Return structured data: task title, due date, priority, project, status

## Output Format

Always return task operations in a structured summary:
- Action taken (created/updated/completed/deleted)
- Task title
- Due date (if set)
- Project/list assignment
```

- [ ] **Step 3: Create gmail skill (extracted from suites/email/agents/gmail-agent.ts)**

```json
// library/skills/communication/email/gmail/config.json
{
  "name": "gmail",
  "displayName": "Gmail Email Management",
  "description": "Search, read, label, archive, and compose emails via Gmail",
  "mcps": ["gmail"],
  "tools": ["Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 15,
  "actions": [
    { "name": "gmail:search-emails", "description": "Search emails", "defaultTier": "green", "reversible": true },
    { "name": "gmail:get-email", "description": "Read email content", "defaultTier": "green", "reversible": true },
    { "name": "gmail:label-email", "description": "Apply label to email", "defaultTier": "yellow", "reversible": true },
    { "name": "gmail:archive-email", "description": "Archive email", "defaultTier": "yellow", "reversible": true },
    { "name": "gmail:mark-read", "description": "Mark email as read", "defaultTier": "green", "reversible": true },
    { "name": "gmail:send-email", "description": "Send new email", "defaultTier": "red", "reversible": false },
    { "name": "gmail:reply-email", "description": "Reply to email", "defaultTier": "red", "reversible": false },
    { "name": "gmail:delete-email", "description": "Delete email permanently", "defaultTier": "red", "reversible": false }
  ]
}
```

```markdown
<!-- library/skills/communication/email/gmail/skill.md -->
You are a Gmail email management agent within Raven personal assistant.

## Capabilities

You have access to the Gmail MCP server for searching, reading, labeling, archiving, and composing emails.

## Guidelines

- Always confirm before sending or replying to emails (red-tier actions)
- When triaging, categorize by: urgent/action-needed/informational/archive
- Extract action items from emails and present them clearly
- For search queries, use Gmail search operators (from:, subject:, after:, before:)

## Output Format

For email summaries:
- From, Subject, Date
- Category (urgent/action/info/archive)
- Action items extracted (if any)
- Recommended action
```

- [ ] **Step 4: Create pdf skill (extracted from suites/file-processing, referencing vendor)**

```json
// library/skills/file-management/documents/pdf/config.json
{
  "name": "pdf",
  "displayName": "PDF Processing",
  "description": "Read, create, merge, split, OCR, watermark, encrypt PDF files",
  "mcps": ["markdownify"],
  "vendorSkills": ["anthropic-skills/pdf"],
  "tools": ["Bash", "Read", "Write", "Skill"],
  "systemDeps": ["poppler-utils"],
  "model": "sonnet",
  "maxTurns": 15,
  "actions": [
    { "name": "file-processing:read", "description": "Read/extract file content", "defaultTier": "green", "reversible": true },
    { "name": "file-processing:create", "description": "Create new document", "defaultTier": "yellow", "reversible": true }
  ],
  "expectedOutputs": [
    { "type": "file", "description": "Processed PDF file" }
  ]
}
```

```markdown
<!-- library/skills/file-management/documents/pdf/skill.md -->
You are a PDF processing specialist within Raven personal assistant.

## Capabilities

- **Read/Extract**: Use markdownify MCP for quick text extraction to markdown
- **Create/Edit**: Use the Skill tool to load the `pdf` vendor skill for full capabilities
- **OCR**: Extract text from scanned PDFs
- **Merge/Split**: Combine or split PDF files
- **Watermark/Encrypt**: Add watermarks or password protection

## File Output Convention

Save output files to `data/files/documents/` with descriptive filenames.
Return all output file paths in an `## Output Files` section.

## Tools

- Use markdownify MCP for extraction (fastest)
- Load `pdf` vendor skill via Skill tool for advanced operations
- Use Bash for poppler-utils commands (pdftotext, pdfinfo, pdfseparate)
```

- [ ] **Step 5: Create remaining skill configs and skill.md files**

Create `config.json` + `skill.md` for each remaining skill by extracting from existing suite agent definitions. Each pair follows the same pattern as above. Skills to create:

- `library/skills/file-management/documents/docx/` — from file-agent prompt
- `library/skills/file-management/documents/xlsx/` — from file-agent prompt
- `library/skills/file-management/documents/pptx/` — from file-agent prompt
- `library/skills/file-management/media/ffmpeg/` — from file-agent prompt + vendor ffmpeg-master
- `library/skills/file-management/media/transcription/` — from gemini-transcription agents
- `library/skills/communication/messaging/telegram/` — from telegram-notifier agent
- `library/skills/productivity/scheduling/calendar/` — from gws-agent (calendar subset)
- `library/skills/productivity/briefing/daily-digest/` — from digest-agent
- `library/skills/finance/banking/monobank/` — from financial-tracking suite
- `library/skills/system/orchestration/` — from raven-orchestrator agent
- `library/skills/system/pattern-analysis/` — from pattern-analyzer agent
- `library/skills/system/config-management/` — from config-manager agent

For each, extract the agent's `prompt` → `skill.md` and the agent's metadata (model, tools, mcps, maxTurns) + suite actions → `config.json`.

- [ ] **Step 6: Commit**

```bash
git add library/skills/
git commit -m "feat(library): create hierarchical skill structure with configs and skill.md files"
```

---

### Task 4: Move Vendor to Library

**Files:**
- Modify: `.gitmodules` (update paths)
- Modify: `scripts/update-vendor.sh` (update paths)
- Modify: `.gitignore` (if needed)

- [ ] **Step 1: Move vendor submodules to library/vendor/**

```bash
# Update .gitmodules paths from vendor/ to library/vendor/
# Then move the directories
mkdir -p library/vendor
git mv vendor/anthropic-skills library/vendor/anthropic-skills
git mv vendor/claude-plugin-marketplace library/vendor/claude-plugin-marketplace
git mv vendor/markdownify-mcp library/vendor/markdownify-mcp
git mv vendor/smart-extractors library/vendor/smart-extractors
```

Update `.gitmodules` — change all `path = vendor/X` to `path = library/vendor/X`.

- [ ] **Step 2: Update scripts/update-vendor.sh**

Change line 14 from:
```bash
cd "$PROJECT_ROOT/vendor/markdownify-mcp"
```
to:
```bash
cd "$PROJECT_ROOT/library/vendor/markdownify-mcp"
```

- [ ] **Step 3: Update markdownify MCP path**

Update `library/mcps/markdownify.json` args to:
```json
"args": ["library/vendor/markdownify-mcp/dist/index.js"]
```

Update `suites/file-processing/mcp.json` (kept for backward compat during migration):
```json
"args": ["library/vendor/markdownify-mcp/dist/index.js"]
```

- [ ] **Step 4: Verify vendor still builds**

Run: `bash scripts/update-vendor.sh`
Expected: Builds successfully with new paths

- [ ] **Step 5: Commit**

```bash
git add .gitmodules library/vendor/ scripts/update-vendor.sh library/mcps/markdownify.json suites/file-processing/mcp.json
git commit -m "refactor: move vendor packages to library/vendor/"
```

---

### Task 5: Build Library Loader

**Files:**
- Create: `packages/core/src/capability-library/library-loader.ts`
- Test: `packages/core/src/__tests__/library-loader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/library-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLibrary } from '../capability-library/library-loader.ts';

describe('loadLibrary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'raven-lib-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupLibrary(structure: Record<string, string>): void {
    for (const [path, content] of Object.entries(structure)) {
      const fullPath = join(tempDir, path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  it('loads MCP definitions from mcps/ directory', async () => {
    setupLibrary({
      'mcps/ticktick.json': JSON.stringify({
        name: 'ticktick',
        displayName: 'TickTick',
        command: 'node',
        args: ['test.ts'],
      }),
    });

    const lib = await loadLibrary(tempDir);
    expect(lib.mcps.has('ticktick')).toBe(true);
    expect(lib.mcps.get('ticktick')!.command).toBe('node');
  });

  it('loads skill configs from nested skill directories', async () => {
    setupLibrary({
      'skills/productivity/task-management/ticktick/config.json': JSON.stringify({
        name: 'ticktick',
        displayName: 'TickTick',
        description: 'Task management',
      }),
      'skills/productivity/task-management/ticktick/skill.md': '# TickTick Agent',
    });

    const lib = await loadLibrary(tempDir);
    expect(lib.skills.has('ticktick')).toBe(true);
    const skill = lib.skills.get('ticktick')!;
    expect(skill.config.displayName).toBe('TickTick');
    expect(skill.skillMd).toContain('# TickTick Agent');
    expect(skill.domain).toBe('productivity');
    expect(skill.path).toBe('productivity/task-management/ticktick');
  });

  it('validates skill configs with Zod schema', async () => {
    setupLibrary({
      'skills/bad/invalid/config.json': JSON.stringify({
        name: 'INVALID_NAME',
        displayName: 'Bad',
        description: 'Bad skill',
      }),
      'skills/bad/invalid/skill.md': '# Bad',
    });

    const lib = await loadLibrary(tempDir);
    // Invalid skills are skipped with warning, not loaded
    expect(lib.skills.has('INVALID_NAME')).toBe(false);
  });

  it('resolves vendor plugin paths', async () => {
    setupLibrary({
      'vendor/anthropic-skills/.gitkeep': '',
      'skills/docs/pdf/config.json': JSON.stringify({
        name: 'pdf',
        displayName: 'PDF',
        description: 'PDF processing',
        vendorSkills: ['anthropic-skills/pdf'],
      }),
      'skills/docs/pdf/skill.md': '# PDF',
    });

    const lib = await loadLibrary(tempDir);
    expect(lib.vendorPaths.has('anthropic-skills')).toBe(true);
  });

  it('builds a complete library index', async () => {
    setupLibrary({
      'mcps/gmail.json': JSON.stringify({
        name: 'gmail',
        displayName: 'Gmail',
        command: 'npx',
        args: ['-y', '@shinzolabs/gmail-mcp'],
      }),
      'skills/communication/email/gmail/config.json': JSON.stringify({
        name: 'gmail',
        displayName: 'Gmail',
        description: 'Email management',
        mcps: ['gmail'],
      }),
      'skills/communication/email/gmail/skill.md': '# Gmail',
    });

    const lib = await loadLibrary(tempDir);
    expect(lib.index.skills).toHaveLength(1);
    expect(lib.index.skills[0].name).toBe('gmail');
    expect(lib.index.mcps).toHaveLength(1);
    expect(lib.index.mcps[0].name).toBe('gmail');
  });

  it('detects duplicate skill names across domains', async () => {
    setupLibrary({
      'skills/domain-a/dupe/config.json': JSON.stringify({
        name: 'dupe-skill',
        displayName: 'Dupe A',
        description: 'First',
      }),
      'skills/domain-a/dupe/skill.md': '# A',
      'skills/domain-b/dupe/config.json': JSON.stringify({
        name: 'dupe-skill',
        displayName: 'Dupe B',
        description: 'Second',
      }),
      'skills/domain-b/dupe/skill.md': '# B',
    });

    // Should warn and keep first, skip second
    const lib = await loadLibrary(tempDir);
    expect(lib.skills.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/library-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement library-loader.ts**

```typescript
// packages/core/src/capability-library/library-loader.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { createLogger, McpDefinitionSchema, SkillConfigSchema } from '@raven/shared';
import type { McpDefinition, SkillConfig, LoadedSkill, LoadedLibrary, LibraryIndex } from '@raven/shared';

const logger = createLogger('library-loader');

export async function loadLibrary(libraryDir: string): Promise<LoadedLibrary> {
  const skills = new Map<string, LoadedSkill>();
  const mcps = new Map<string, McpDefinition>();
  const vendorPaths = new Map<string, string>();
  const index: LibraryIndex = { skills: [], mcps: [] };

  // Load MCPs
  const mcpsDir = join(libraryDir, 'mcps');
  if (await dirExists(mcpsDir)) {
    const files = await readdir(mcpsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(mcpsDir, file), 'utf-8'));
        const mcp = McpDefinitionSchema.parse(raw);
        mcps.set(mcp.name, mcp);
        index.mcps.push({ name: mcp.name, path: file });
        logger.debug({ mcp: mcp.name }, 'loaded MCP definition');
      } catch (err) {
        logger.warn({ file, err }, 'failed to load MCP definition');
      }
    }
  }

  // Load skills (recursive walk)
  const skillsDir = join(libraryDir, 'skills');
  if (await dirExists(skillsDir)) {
    await walkSkills(skillsDir, skillsDir, skills, index);
  }

  // Check for duplicate skill names
  // (handled in walkSkills — second occurrence is skipped)

  // Resolve vendor paths
  const vendorDir = join(libraryDir, 'vendor');
  if (await dirExists(vendorDir)) {
    const vendorEntries = await readdir(vendorDir);
    for (const entry of vendorEntries) {
      const entryPath = join(vendorDir, entry);
      if (await isDirectory(entryPath)) {
        vendorPaths.set(entry, entryPath);
      }
    }
  }

  logger.info(
    { skills: skills.size, mcps: mcps.size, vendors: vendorPaths.size },
    'library loaded',
  );

  return { skills, mcps, vendorPaths, index };
}

async function walkSkills(
  dir: string,
  skillsRoot: string,
  skills: Map<string, LoadedSkill>,
  index: LibraryIndex,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const hasConfig = entries.some((e) => e.name === 'config.json');

  if (hasConfig) {
    // This is a skill directory
    try {
      const configRaw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8'));
      const config = SkillConfigSchema.parse(configRaw);

      if (skills.has(config.name)) {
        logger.warn({ name: config.name, path: dir }, 'duplicate skill name, skipping');
        return;
      }

      let skillMd = '';
      const skillMdPath = join(dir, 'skill.md');
      if (await fileExists(skillMdPath)) {
        skillMd = await readFile(skillMdPath, 'utf-8');
      }

      const relPath = relative(skillsRoot, dir);
      const domain = relPath.split('/')[0];

      const loaded: LoadedSkill = { config, skillMd, path: relPath, domain };
      skills.set(config.name, loaded);
      index.skills.push({ name: config.name, path: relPath, description: config.description });
      logger.debug({ skill: config.name, path: relPath }, 'loaded skill');
    } catch (err) {
      logger.warn({ dir, err }, 'failed to load skill');
    }
    return; // Don't recurse into skill subdirectories (examples/ etc.)
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'examples') {
      await walkSkills(join(dir, entry.name), skillsRoot, skills, index);
    }
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return dirExists(path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/library-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-library/library-loader.ts packages/core/src/__tests__/library-loader.test.ts
git commit -m "feat(core): add library loader for reading capability library from filesystem"
```

---

### Task 6: Build CapabilityLibrary Class

**Files:**
- Create: `packages/core/src/capability-library/capability-library.ts`
- Create: `packages/core/src/capability-library/skill-catalog.ts`
- Test: `packages/core/src/__tests__/capability-library.test.ts`

This class provides the same interface that `SuiteRegistry` consumers need: `collectMcpServers()`, `collectAgentDefinitions()`, `collectActions()`, etc. — but backed by the library.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/capability-library.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';

describe('CapabilityLibrary', () => {
  let tempDir: string;
  let lib: CapabilityLibrary;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'raven-cap-test-'));
    setupTestLibrary(tempDir);
    lib = new CapabilityLibrary();
    await lib.load(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('collectMcpServers returns all MCPs for given skills', () => {
    const mcps = lib.collectMcpServers(['ticktick', 'gmail']);
    expect(Object.keys(mcps)).toContain('ticktick');
    expect(Object.keys(mcps)).toContain('gmail');
    expect(mcps['ticktick'].command).toBe('node');
  });

  it('collectMcpServers returns all MCPs when no skills specified', () => {
    const mcps = lib.collectMcpServers();
    expect(Object.keys(mcps).length).toBeGreaterThanOrEqual(2);
  });

  it('collectMcpServers deduplicates MCPs referenced by multiple skills', () => {
    // If two skills both reference 'gmail', only one entry
    const mcps = lib.collectMcpServers(['gmail', 'gmail']);
    const gmailCount = Object.keys(mcps).filter((k) => k === 'gmail').length;
    expect(gmailCount).toBe(1);
  });

  it('collectAgentDefinitions builds SubAgentDefinition from skills', () => {
    const agents = lib.collectAgentDefinitions(['ticktick']);
    expect(agents['ticktick']).toBeDefined();
    expect(agents['ticktick'].description).toBe('Task management');
    expect(agents['ticktick'].prompt).toContain('TickTick');
    expect(agents['ticktick'].model).toBe('sonnet');
    expect(agents['ticktick'].mcpServers).toContain('ticktick');
  });

  it('collectAgentDefinitions includes MCP tool patterns in tools', () => {
    const agents = lib.collectAgentDefinitions(['ticktick']);
    const tools = agents['ticktick'].tools!;
    expect(tools).toContain('mcp__ticktick__*');
    expect(tools).toContain('Read');
    expect(tools).toContain('Grep');
  });

  it('collectActions returns actions from specified skills', () => {
    const actions = lib.collectActions(['ticktick']);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].name).toMatch(/^ticktick:/);
  });

  it('collectActions returns all actions when no skills specified', () => {
    const allActions = lib.collectActions();
    expect(allActions.length).toBeGreaterThanOrEqual(2);
  });

  it('resolveVendorPlugins returns paths for skills with vendorSkills', () => {
    const plugins = lib.resolveVendorPlugins(['pdf']);
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0].type).toBe('local');
  });

  it('getSkillCatalog returns Tier 0 text catalog', () => {
    const catalog = lib.getSkillCatalog(['ticktick', 'gmail']);
    expect(catalog).toContain('ticktick');
    expect(catalog).toContain('gmail');
    expect(catalog).toContain('Task management');
  });

  it('getSkillNames returns all loaded skill names', () => {
    const names = lib.getSkillNames();
    expect(names).toContain('ticktick');
    expect(names).toContain('gmail');
  });
});

function setupTestLibrary(dir: string): void {
  const files: Record<string, string> = {
    'mcps/ticktick.json': JSON.stringify({
      name: 'ticktick', displayName: 'TickTick', command: 'node', args: ['test.ts'],
    }),
    'mcps/gmail.json': JSON.stringify({
      name: 'gmail', displayName: 'Gmail', command: 'npx', args: ['-y', 'gmail-mcp'],
    }),
    'skills/productivity/tasks/ticktick/config.json': JSON.stringify({
      name: 'ticktick', displayName: 'TickTick', description: 'Task management',
      mcps: ['ticktick'], tools: ['Read', 'Grep'], model: 'sonnet',
      actions: [
        { name: 'ticktick:get-tasks', description: 'Read tasks', defaultTier: 'green', reversible: true },
      ],
    }),
    'skills/productivity/tasks/ticktick/skill.md': 'You are a TickTick agent.',
    'skills/communication/email/gmail/config.json': JSON.stringify({
      name: 'gmail', displayName: 'Gmail', description: 'Email management',
      mcps: ['gmail'], tools: ['Read', 'Grep'], model: 'sonnet',
      actions: [
        { name: 'gmail:search', description: 'Search email', defaultTier: 'green', reversible: true },
      ],
    }),
    'skills/communication/email/gmail/skill.md': 'You are a Gmail agent.',
    'skills/docs/pdf/config.json': JSON.stringify({
      name: 'pdf', displayName: 'PDF', description: 'PDF processing',
      mcps: ['markdownify'], vendorSkills: ['anthropic-skills/pdf'],
      tools: ['Bash', 'Read', 'Write', 'Skill'],
    }),
    'skills/docs/pdf/skill.md': 'You are a PDF agent.',
    'vendor/anthropic-skills/.gitkeep': '',
  };

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/capability-library.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement capability-library.ts**

```typescript
// packages/core/src/capability-library/capability-library.ts
import { createLogger, buildMcpToolPattern } from '@raven/shared';
import type {
  McpDefinition, LoadedSkill, LoadedLibrary,
  McpServerConfig, SubAgentDefinition, ActionDefinition,
} from '@raven/shared';
import { loadLibrary } from './library-loader.ts';

const logger = createLogger('capability-library');

export class CapabilityLibrary {
  private library: LoadedLibrary | null = null;

  async load(libraryDir: string): Promise<void> {
    this.library = await loadLibrary(libraryDir);
  }

  private ensureLoaded(): LoadedLibrary {
    if (!this.library) throw new Error('Library not loaded. Call load() first.');
    return this.library;
  }

  getSkillNames(): string[] {
    return [...this.ensureLoaded().skills.keys()];
  }

  getSkill(name: string): LoadedSkill | undefined {
    return this.ensureLoaded().skills.get(name);
  }

  getMcp(name: string): McpDefinition | undefined {
    return this.ensureLoaded().mcps.get(name);
  }

  /**
   * Collect MCP server configs for a set of skills.
   * If no skills specified, returns MCPs for ALL skills.
   * Returns Record<mcpName, McpServerConfig> (flat, no namespacing needed).
   */
  collectMcpServers(skillNames?: string[]): Record<string, McpServerConfig> {
    const lib = this.ensureLoaded();
    const result: Record<string, McpServerConfig> = {};
    const skills = skillNames
      ? skillNames.map((n) => lib.skills.get(n)).filter(Boolean) as LoadedSkill[]
      : [...lib.skills.values()];

    const mcpNames = new Set<string>();
    for (const skill of skills) {
      for (const mcpName of skill.config.mcps) {
        mcpNames.add(mcpName);
      }
    }

    for (const mcpName of mcpNames) {
      const mcp = lib.mcps.get(mcpName);
      if (mcp) {
        result[mcpName] = {
          command: mcp.command,
          args: mcp.args,
          env: resolveEnvVars(mcp.env),
        };
      } else {
        logger.warn({ mcpName }, 'MCP referenced by skill not found in library');
      }
    }

    return result;
  }

  /**
   * Build SubAgentDefinitions from skills.
   * Each skill becomes a sub-agent with its prompt, tools, and MCP bindings.
   */
  collectAgentDefinitions(skillNames?: string[]): Record<string, SubAgentDefinition> {
    const lib = this.ensureLoaded();
    const result: Record<string, SubAgentDefinition> = {};
    const skills = skillNames
      ? skillNames.map((n) => lib.skills.get(n)).filter(Boolean) as LoadedSkill[]
      : [...lib.skills.values()];

    for (const skill of skills) {
      const tools: string[] = [...skill.config.tools];
      const mcpServers: string[] = [];

      for (const mcpName of skill.config.mcps) {
        tools.push(buildMcpToolPattern(mcpName));
        mcpServers.push(mcpName);
      }

      result[skill.config.name] = {
        description: skill.config.description,
        prompt: skill.skillMd,
        tools,
        model: skill.config.model,
        mcpServers,
      };
    }

    return result;
  }

  /**
   * Collect actions from specified skills (or all skills).
   */
  collectActions(skillNames?: string[]): ActionDefinition[] {
    const lib = this.ensureLoaded();
    const skills = skillNames
      ? skillNames.map((n) => lib.skills.get(n)).filter(Boolean) as LoadedSkill[]
      : [...lib.skills.values()];

    const actions: ActionDefinition[] = [];
    const seen = new Set<string>();

    for (const skill of skills) {
      for (const action of skill.config.actions) {
        if (!seen.has(action.name)) {
          seen.add(action.name);
          actions.push(action);
        }
      }
    }

    return actions;
  }

  /**
   * Resolve vendor plugin paths for skills that reference vendorSkills.
   */
  resolveVendorPlugins(skillNames?: string[]): Array<{ type: 'local'; path: string }> {
    const lib = this.ensureLoaded();
    const skills = skillNames
      ? skillNames.map((n) => lib.skills.get(n)).filter(Boolean) as LoadedSkill[]
      : [...lib.skills.values()];

    const plugins: Array<{ type: 'local'; path: string }> = [];
    const seen = new Set<string>();

    for (const skill of skills) {
      for (const vendorRef of skill.config.vendorSkills) {
        const vendorName = vendorRef.split('/')[0];
        const vendorPath = lib.vendorPaths.get(vendorName);
        if (vendorPath && !seen.has(vendorPath)) {
          seen.add(vendorPath);
          plugins.push({ type: 'local', path: vendorPath });
        }
      }
    }

    return plugins;
  }

  /**
   * Build Tier 0 skill catalog text for agent system prompts.
   */
  getSkillCatalog(skillNames?: string[]): string {
    const lib = this.ensureLoaded();
    const entries = skillNames
      ? lib.index.skills.filter((s) => skillNames.includes(s.name))
      : lib.index.skills;

    if (entries.length === 0) return '';

    const lines = ['## Available Skills', ''];
    for (const entry of entries) {
      lines.push(`- **${entry.name}** — ${entry.description}`);
    }
    return lines.join('\n');
  }
}

function resolveEnvVars(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val.startsWith('${') && val.endsWith('}')) {
      const envVar = val.slice(2, -1);
      resolved[key] = process.env[envVar] ?? '';
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Implement skill-catalog.ts** (optional helper, can be inlined later)

The catalog logic is already in `getSkillCatalog()` above. Create the file as a re-export for clarity:

```typescript
// packages/core/src/capability-library/skill-catalog.ts
// Skill catalog generation is handled by CapabilityLibrary.getSkillCatalog()
// This file exists as an extension point for future Tier 1/2 catalog building.
export { CapabilityLibrary } from './capability-library.ts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/capability-library.test.ts`
Expected: PASS

- [ ] **Step 6: Run full check**

Run: `npm run build && npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/capability-library/ packages/core/src/__tests__/capability-library.test.ts
git commit -m "feat(core): add CapabilityLibrary class with MCP/skill/action resolution"
```

---

### Task 7: Build Library Validator

**Files:**
- Create: `packages/core/src/capability-library/library-validator.ts`
- Test: `packages/core/src/__tests__/library-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/library-validator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateLibrary } from '../capability-library/library-validator.ts';

describe('validateLibrary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'raven-val-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(tempDir, path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  it('returns no errors for a valid library', async () => {
    setup({
      'mcps/ticktick.json': JSON.stringify({
        name: 'ticktick', displayName: 'TT', command: 'node', args: [],
      }),
      'skills/prod/ticktick/config.json': JSON.stringify({
        name: 'ticktick', displayName: 'TT', description: 'Tasks',
        mcps: ['ticktick'],
      }),
      'skills/prod/ticktick/skill.md': '# TT Agent',
      'skills/_index.md': '# Skills',
      'skills/prod/_index.md': '# Prod',
    });

    const errors = await validateLibrary(tempDir);
    expect(errors).toEqual([]);
  });

  it('reports missing skill.md', async () => {
    setup({
      'skills/prod/bad/config.json': JSON.stringify({
        name: 'bad', displayName: 'Bad', description: 'No skill.md',
      }),
    });

    const errors = await validateLibrary(tempDir);
    expect(errors.some((e) => e.includes('skill.md'))).toBe(true);
  });

  it('reports unresolved MCP reference', async () => {
    setup({
      'skills/prod/orphan/config.json': JSON.stringify({
        name: 'orphan', displayName: 'Orphan', description: 'References missing MCP',
        mcps: ['nonexistent-mcp'],
      }),
      'skills/prod/orphan/skill.md': '# Orphan',
    });

    const errors = await validateLibrary(tempDir);
    expect(errors.some((e) => e.includes('nonexistent-mcp'))).toBe(true);
  });

  it('reports missing _index.md for directories with skills', async () => {
    setup({
      'skills/prod/ticktick/config.json': JSON.stringify({
        name: 'ticktick', displayName: 'TT', description: 'Tasks',
      }),
      'skills/prod/ticktick/skill.md': '# TT',
      // Missing skills/_index.md and skills/prod/_index.md
    });

    const errors = await validateLibrary(tempDir);
    expect(errors.some((e) => e.includes('_index.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/library-validator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement library-validator.ts**

```typescript
// packages/core/src/capability-library/library-validator.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillConfigSchema, McpDefinitionSchema } from '@raven/shared';

export async function validateLibrary(libraryDir: string): Promise<string[]> {
  const errors: string[] = [];

  // 1. Validate MCP definitions
  const mcpNames = new Set<string>();
  const mcpsDir = join(libraryDir, 'mcps');
  if (await dirExists(mcpsDir)) {
    const files = await readdir(mcpsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(mcpsDir, file), 'utf-8'));
        const result = McpDefinitionSchema.safeParse(raw);
        if (!result.success) {
          errors.push(`mcps/${file}: invalid schema — ${result.error.issues[0].message}`);
        } else {
          mcpNames.add(result.data.name);
        }
      } catch (err) {
        errors.push(`mcps/${file}: invalid JSON`);
      }
    }
  }

  // 2. Walk skills and validate
  const skillsDir = join(libraryDir, 'skills');
  if (await dirExists(skillsDir)) {
    await validateSkillsDir(skillsDir, skillsDir, mcpNames, errors);
  }

  return errors;
}

async function validateSkillsDir(
  dir: string,
  skillsRoot: string,
  mcpNames: Set<string>,
  errors: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const hasConfig = entries.some((e) => e.name === 'config.json');

  if (hasConfig) {
    // This is a skill directory — validate it
    const relPath = dir.replace(skillsRoot + '/', '');

    // Check skill.md exists
    if (!entries.some((e) => e.name === 'skill.md')) {
      errors.push(`skills/${relPath}: missing skill.md`);
    }

    // Validate config.json
    try {
      const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8'));
      const result = SkillConfigSchema.safeParse(raw);
      if (!result.success) {
        errors.push(`skills/${relPath}/config.json: invalid schema — ${result.error.issues[0].message}`);
      } else {
        // Check MCP references
        for (const mcpRef of result.data.mcps) {
          if (!mcpNames.has(mcpRef)) {
            errors.push(`skills/${relPath}: references MCP '${mcpRef}' not found in library/mcps/`);
          }
        }
      }
    } catch {
      errors.push(`skills/${relPath}/config.json: invalid JSON`);
    }

    return;
  }

  // Not a skill directory — check for _index.md if it has subdirectories
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (subdirs.length > 0 && !entries.some((e) => e.name === '_index.md')) {
    const relPath = dir === skillsRoot ? 'skills' : `skills/${dir.replace(skillsRoot + '/', '')}`;
    errors.push(`${relPath}: missing _index.md (directory has ${subdirs.length} subdirectories)`);
  }

  // Recurse
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'examples') {
      await validateSkillsDir(join(dir, entry.name), skillsRoot, mcpNames, errors);
    }
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/library-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-library/library-validator.ts packages/core/src/__tests__/library-validator.test.ts
git commit -m "feat(core): add library validator for skill configs, MCP refs, and structure"
```

---

### Task 8: Update NamedAgent Type — skills Replaces suiteIds

**Files:**
- Modify: `packages/shared/src/types/agents.ts`
- Modify: `packages/core/src/agent-registry/named-agent-store.ts`
- Modify: `config/agents.json`
- Modify: `packages/core/src/api/routes/agents.ts`
- Modify: `packages/web/src/components/agents/AgentFormModal.tsx` (suiteIds → skills)
- Test: Update `packages/core/src/__tests__/agent-resolver.test.ts`

- [ ] **Step 1: Add `skills` field to NamedAgent alongside `suiteIds`**

In `packages/shared/src/types/agents.ts`, add the `skills` field. Keep `suiteIds` for backward compatibility during migration:

```typescript
export interface NamedAgent {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  suiteIds: string[];      // DEPRECATED — kept for migration
  skills: string[];         // NEW — references library skill names
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add migration SQL for skills column**

Create `migrations/021-agent-skills.sql`:

```sql
ALTER TABLE named_agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 3: Update named-agent-store.ts**

Add `skills` to all queries — `createAgent`, `updateAgent`, `getAgent`, `listAgents`. The store reads/writes `skills` as a JSON string column (same pattern as `suite_ids`).

- [ ] **Step 4: Update config/agents.json**

Add `skills: []` to each existing agent (empty means "all skills" for default agent, same semantic as empty suiteIds):

```json
[
  { "name": "raven", "skills": [], "suite_ids": [], "is_default": true, ... },
  { "name": "bound-agent", "skills": ["gmail"], "suite_ids": ["email"], ... }
]
```

- [ ] **Step 5: Update agent API routes**

In `packages/core/src/api/routes/agents.ts`, accept `skills` in create/update payloads.

- [ ] **Step 6: Run tests and fix**

Run: `npm test`
Fix any failures in agent-related tests.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/agents.ts packages/core/src/agent-registry/ migrations/ config/agents.json packages/core/src/api/routes/agents.ts
git commit -m "feat(agents): add skills field to NamedAgent alongside suiteIds for migration"
```

---

### Task 9: Update Agent Resolver to Use CapabilityLibrary

**Files:**
- Modify: `packages/core/src/agent-registry/agent-resolver.ts`
- Test: `packages/core/src/__tests__/agent-resolver.test.ts`

- [ ] **Step 1: Write the failing test for skills-based resolution**

Add new test cases to `agent-resolver.test.ts`:

```typescript
describe('resolveAgentCapabilities with CapabilityLibrary', () => {
  it('resolves capabilities from skills when skills array is populated', () => {
    const resolver = createAgentResolver({ capabilityLibrary: mockLibrary });
    const agent = makeAgent({ skills: ['ticktick', 'gmail'], suiteIds: [] });
    const caps = resolver.resolveAgentCapabilities(agent);
    expect(Object.keys(caps.mcpServers)).toContain('ticktick');
    expect(Object.keys(caps.agentDefinitions)).toContain('ticktick');
  });

  it('falls back to suiteIds when skills is empty and suiteIds populated', () => {
    const resolver = createAgentResolver({ capabilityLibrary: mockLibrary, suiteRegistry: mockRegistry });
    const agent = makeAgent({ skills: [], suiteIds: ['email'] });
    const caps = resolver.resolveAgentCapabilities(agent);
    // Should use suiteRegistry path (backward compat)
    expect(Object.keys(caps.mcpServers)).toContain('email_gmail');
  });

  it('returns all skills for default agent with empty skills', () => {
    const resolver = createAgentResolver({ capabilityLibrary: mockLibrary });
    const agent = makeAgent({ skills: [], suiteIds: [], isDefault: true });
    const caps = resolver.resolveAgentCapabilities(agent);
    // Should return all skills from library
    expect(Object.keys(caps.agentDefinitions).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Update agent-resolver.ts**

```typescript
// packages/core/src/agent-registry/agent-resolver.ts
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';

export function createAgentResolver(deps: {
  capabilityLibrary?: CapabilityLibrary;
  suiteRegistry?: SuiteRegistry;  // kept for backward compat during migration
}): AgentResolver {
  return {
    resolveAgentCapabilities(agent: NamedAgent): ResolvedCapabilities {
      const { capabilityLibrary, suiteRegistry } = deps;

      // NEW PATH: resolve from skills via CapabilityLibrary
      if (capabilityLibrary && (agent.skills.length > 0 || !suiteRegistry)) {
        const skillNames = agent.skills.length > 0 && !agent.isDefault
          ? agent.skills
          : undefined; // undefined = all skills

        return {
          mcpServers: capabilityLibrary.collectMcpServers(skillNames),
          agentDefinitions: capabilityLibrary.collectAgentDefinitions(skillNames),
          plugins: capabilityLibrary.resolveVendorPlugins(skillNames),
        };
      }

      // LEGACY PATH: resolve from suiteIds via SuiteRegistry
      if (suiteRegistry) {
        // ... existing suiteRegistry logic (unchanged)
      }

      return { mcpServers: {}, agentDefinitions: {}, plugins: [] };
    },
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/core/src/__tests__/agent-resolver.test.ts`
Expected: PASS (both old and new tests)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/agent-registry/agent-resolver.ts packages/core/src/__tests__/agent-resolver.test.ts
git commit -m "feat(agent-resolver): resolve capabilities from CapabilityLibrary via skills field"
```

---

### Task 10: Wire CapabilityLibrary into Boot Sequence

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/orchestrator/orchestrator.ts`

- [ ] **Step 1: Add CapabilityLibrary loading to boot sequence**

In `packages/core/src/index.ts`, after suite registry loading (line ~125), add:

```typescript
import { CapabilityLibrary } from './capability-library/capability-library.ts';

// After suite registry loading:
const capabilityLibrary = new CapabilityLibrary();
const libraryDir = resolve(projectRoot, 'library');
try {
  await capabilityLibrary.load(libraryDir);
  logger.info('capability library loaded');
} catch (err) {
  logger.warn({ err }, 'capability library not found, using suite registry only');
}
```

- [ ] **Step 2: Pass CapabilityLibrary to AgentResolver**

Update the agent resolver creation (line ~184):

```typescript
const agentResolver = createAgentResolver({
  capabilityLibrary,
  suiteRegistry,  // keep both during migration
});
```

- [ ] **Step 3: Pass CapabilityLibrary to Orchestrator**

Update orchestrator initialization to accept and use `capabilityLibrary`. The orchestrator can use `capabilityLibrary.getSkillCatalog()` to inject Tier 0 catalog into agent prompts.

- [ ] **Step 4: Run full system test**

Run: `npm run build && npm test`
Expected: PASS — both old suite-based tests and new library-based resolution work

- [ ] **Step 5: Manual smoke test**

```bash
RAVEN_PORT=4001 node packages/core/dist/index.js
curl http://localhost:4001/api/health
curl http://localhost:4001/api/agents
```

Expected: System boots, health check passes, agents list works.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/orchestrator/orchestrator.ts
git commit -m "feat(boot): wire CapabilityLibrary into boot sequence alongside SuiteRegistry"
```

---

### Task 11: Create Services Directory

**Files:**
- Create: `library/services/` (placeholder structure)

Services (imap-watcher, telegram-bot, etc.) stay as TypeScript files but move from `suites/*/services/` to `library/services/`. This is a filesystem move — the service runner in `index.ts` needs to know where to find them.

- [ ] **Step 1: Create library/services/ with README**

```markdown
<!-- library/services/README.md -->
# Services

Long-running background processes. These are started by the ServiceRunner
at boot time and run continuously.

Each service is loaded from its suite's service directory during migration.
Post-migration, services will be loaded from here directly.

Services are NOT skills — they don't have prompts or MCP bindings.
They are background processes (IMAP watchers, Telegram bots, schedulers).
```

Note: Actual service migration happens in Phase 2 (Project Structure) since services need to be rewired in the boot sequence. For now, services continue loading from `suites/*/services/`.

- [ ] **Step 2: Commit**

```bash
git add library/services/
git commit -m "docs(library): add services directory placeholder for Phase 2 migration"
```

---

### Task 12: Add Library Validation CLI Script

**Files:**
- Create: `scripts/validate-library.ts`

- [ ] **Step 1: Create the validation script**

```typescript
// scripts/validate-library.ts
import { resolve } from 'node:path';
import { validateLibrary } from '../packages/core/src/capability-library/library-validator.ts';

const libraryDir = resolve(import.meta.dirname, '..', 'library');

const errors = await validateLibrary(libraryDir);

if (errors.length === 0) {
  console.log('Library validation passed.');
  process.exit(0);
} else {
  console.error(`Library validation failed with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}
```

- [ ] **Step 2: Add npm script**

In root `package.json`, add:
```json
"validate:library": "node --experimental-strip-types scripts/validate-library.ts"
```

- [ ] **Step 3: Run it**

Run: `npm run validate:library`
Expected: Reports any missing `_index.md` files or invalid configs. Fix issues found.

- [ ] **Step 4: Commit**

```bash
git add scripts/validate-library.ts package.json
git commit -m "feat: add library validation CLI script (npm run validate:library)"
```

---

### Task 13: Integration Test — Full Library Resolution

**Files:**
- Create: `packages/core/src/__tests__/library-integration.test.ts`

End-to-end test using the real `library/` directory.

- [ ] **Step 1: Write integration test**

```typescript
// packages/core/src/__tests__/library-integration.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { validateLibrary } from '../capability-library/library-validator.ts';

const LIBRARY_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'library');

describe('library integration', () => {
  it('loads the real library without errors', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    expect(lib.getSkillNames().length).toBeGreaterThan(0);
  });

  it('validates the real library structure', async () => {
    const errors = await validateLibrary(LIBRARY_DIR);
    expect(errors).toEqual([]);
  });

  it('resolves MCPs for ticktick skill', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const mcps = lib.collectMcpServers(['ticktick']);
    expect(mcps['ticktick']).toBeDefined();
    expect(mcps['ticktick'].command).toBe('node');
  });

  it('builds agent definitions with correct tool patterns', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const agents = lib.collectAgentDefinitions(['ticktick']);
    expect(agents['ticktick'].tools).toContain('mcp__ticktick__*');
  });

  it('generates a non-empty skill catalog', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const catalog = lib.getSkillCatalog();
    expect(catalog).toContain('ticktick');
    expect(catalog).toContain('Available Skills');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run packages/core/src/__tests__/library-integration.test.ts`
Expected: PASS — real library loads and validates

- [ ] **Step 3: Fix any validation errors found**

If the integration test reveals missing `_index.md` files, invalid configs, or broken MCP refs, fix them now.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/library-integration.test.ts
git commit -m "test: add integration test for real capability library"
```

---

### Task 14: Run Full Test Suite and Final Verification

- [ ] **Step 1: Build everything**

Run: `npm run build`
Expected: PASS — no type errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS — all existing tests still pass, new tests pass

- [ ] **Step 3: Run lint/format check**

Run: `npm run check`
Expected: PASS — no lint or format issues

- [ ] **Step 4: Run library validation**

Run: `npm run validate:library`
Expected: PASS — library structure is valid

- [ ] **Step 5: Manual smoke test with running system**

```bash
RAVEN_PORT=4001 node packages/core/dist/index.js
# Check logs for "capability library loaded"
curl http://localhost:4001/api/health
curl http://localhost:4001/api/agents
```

Expected: System boots with both SuiteRegistry and CapabilityLibrary loaded. Agents with `skills` field resolve from library. Agents with `suiteIds` field fall back to suite registry.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Phase 1 — capability library with parallel suite support"
```

---

## Summary

After completing all 14 tasks:

- `library/mcps/` contains standalone MCP definitions (extracted from suites)
- `library/skills/` contains hierarchical skill structure with `config.json` + `skill.md`
- `library/vendor/` contains git submodules (moved from `vendor/`)
- `CapabilityLibrary` class loads and resolves skills → MCPs → agents → actions
- `AgentResolver` resolves from library (via `skills` field) or suites (via `suiteIds`, backward compat)
- Library validation catches broken references, missing files, invalid schemas
- System boots with both old and new paths active — no breaking changes
- Suite-based code remains functional — full removal happens in a later phase after all agents migrate to `skills` field

**Next plan**: Phase 2 — Project-Centric File Structure (move agent YAMLs to `projects/`, add hierarchy, inheritance)
