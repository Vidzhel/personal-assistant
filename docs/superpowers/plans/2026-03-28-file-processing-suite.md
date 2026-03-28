# File Processing Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a file-processing suite with document read/create (PDF, DOCX, XLSX, PPTX), media processing (ffmpeg), upgrade Gemini transcription, add file download API, and Telegram file sending — all powered by vendored Claude Code skills loaded into sub-agents.

**Architecture:** One `file-agent` with all file skills (Anthropic pdf/docx/xlsx/pptx + ffmpeg-master) and markdownify MCP handles any file operation. Orchestrator composes agents dynamically for cross-suite tasks, passing file paths between them. Vendor skills are git submodules loaded into sub-agents via the SDK's `plugins` option.

**Tech Stack:** Claude Agent SDK (`@anthropic-ai/claude-code`), Anthropic skills plugin, ffmpeg-master plugin, markdownify-mcp, Google Gemini File API, Fastify static file serving, grammy `sendDocument`.

---

### Task 1: Vendor Directory Setup

**Files:**
- Create: `vendor/.gitkeep` (placeholder, removed after submodules added)
- Create: `scripts/update-vendor.sh`
- Modify: `.gitignore`
- Modify: `.gitmodules` (auto-created by git submodule add)

- [ ] **Step 1: Add git submodules**

```bash
cd /home/user/projects/personal-assistant
git submodule add https://github.com/anthropics/skills.git vendor/anthropic-skills
git submodule add https://github.com/diegocconsolini/ClaudeSkillCollection.git vendor/smart-extractors
git submodule add https://github.com/zcaceres/markdownify-mcp.git vendor/markdownify-mcp
git submodule add https://github.com/JosiahSiegel/claude-plugin-marketplace.git vendor/claude-plugin-marketplace
```

- [ ] **Step 2: Verify submodules cloned correctly**

```bash
ls vendor/anthropic-skills/skills/pdf/
ls vendor/claude-plugin-marketplace/plugins/ffmpeg-master/
ls vendor/markdownify-mcp/package.json
ls vendor/smart-extractors/
```

Expected: Each directory contains the expected plugin/skill files. If `ffmpeg-master` is at a different path inside the marketplace repo, adjust the path reference in later tasks.

- [ ] **Step 3: Build markdownify-mcp**

```bash
cd vendor/markdownify-mcp
npm install
npm run build
cd /home/user/projects/personal-assistant
```

Expected: `vendor/markdownify-mcp/dist/` directory created with compiled JS.

- [ ] **Step 4: Add vendor build artifacts to .gitignore**

Append to `/home/user/projects/personal-assistant/.gitignore`:

```
# Vendor build artifacts
vendor/markdownify-mcp/node_modules/
vendor/markdownify-mcp/dist/
```

- [ ] **Step 5: Create update script**

Create `/home/user/projects/personal-assistant/scripts/update-vendor.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== Updating vendor submodules ==="
git submodule update --remote --merge

echo ""
echo "=== Building markdownify-mcp ==="
cd "$PROJECT_ROOT/vendor/markdownify-mcp"
npm install
npm run build

cd "$PROJECT_ROOT"

echo ""
echo "=== Vendor status ==="
git submodule status

echo ""
echo "Done. Review changes with 'git diff' and commit if satisfied."
```

- [ ] **Step 6: Make script executable and verify**

```bash
chmod +x scripts/update-vendor.sh
```

- [ ] **Step 7: Commit**

```bash
git add .gitmodules vendor/ scripts/update-vendor.sh .gitignore
git commit -m "chore: add vendor submodules for file processing skills

Vendors: anthropic-skills, claude-plugin-marketplace (ffmpeg-master),
smart-extractors, markdownify-mcp. Includes update script."
```

---

### Task 2: Shared Constants and Event Types

**Files:**
- Modify: `packages/shared/src/suites/constants.ts`
- Modify: `packages/shared/src/types/events.ts`

- [ ] **Step 1: Add constants**

Add to `/home/user/projects/personal-assistant/packages/shared/src/suites/constants.ts`:

```typescript
// File processing suite
export const SUITE_FILE_PROCESSING = 'file-processing';
export const AGENT_FILE = 'file-agent';
export const MCP_MARKDOWNIFY = 'markdownify';

// Transcription agent (addition to gemini-transcription suite)
export const AGENT_TRANSCRIPTION = 'transcription-agent';

// Event sources
export const SOURCE_FILE_PROCESSING = 'file-processing';
export const SOURCE_TRANSCRIPTION = 'transcription';

// Event types
export const EVENT_TRANSCRIPTION_REQUEST = 'transcription:request' as const;
export const EVENT_TRANSCRIPTION_COMPLETE = 'transcription:complete' as const;
export const EVENT_TRANSCRIPTION_FAILED = 'transcription:failed' as const;
```

- [ ] **Step 2: Add TranscriptionRequestEvent type**

Add to `/home/user/projects/personal-assistant/packages/shared/src/types/events.ts`, before the RavenEvent union type:

```typescript
export const TranscriptionRequestPayloadSchema = z.object({
  filePath: z.string(),
  mimeType: z.string(),
  projectId: z.string().optional(),
  createKnowledgeBubble: z.boolean().default(true),
  topicId: z.number().optional(),
  topicName: z.string().optional(),
});

export interface TranscriptionRequestEvent extends BaseEvent {
  type: 'transcription:request';
  payload: z.infer<typeof TranscriptionRequestPayloadSchema>;
}

export interface TranscriptionCompleteEvent extends BaseEvent {
  type: 'transcription:complete';
  payload: {
    filePath: string;
    transcriptPath: string;
    projectId?: string;
    topicId?: number;
    topicName?: string;
  };
}

export interface TranscriptionFailedEvent extends BaseEvent {
  type: 'transcription:failed';
  payload: {
    filePath: string;
    error: string;
    projectId?: string;
  };
}
```

- [ ] **Step 3: Add filePath to notification payload**

In `/home/user/projects/personal-assistant/packages/shared/src/types/events.ts`, add `filePath` to the NotificationEvent and NotificationDeliverEvent payload interfaces:

```typescript
// In NotificationEvent payload:
filePath?: string;

// In NotificationDeliverEvent payload:
filePath?: string;
```

- [ ] **Step 4: Add new events to RavenEvent union**

Add `TranscriptionRequestEvent`, `TranscriptionCompleteEvent`, and `TranscriptionFailedEvent` to the `RavenEvent` union type at the end of the events file.

- [ ] **Step 5: Export new schemas and types**

Ensure all new schemas and types are exported from `packages/shared/src/types/events.ts` and re-exported from `packages/shared/src/types/index.ts` (if it re-exports from events).

- [ ] **Step 6: Verify types compile**

```bash
cd /home/user/projects/personal-assistant
npx tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/suites/constants.ts packages/shared/src/types/events.ts packages/shared/src/types/index.ts
git commit -m "feat: add file-processing constants and transcription event types"
```

---

### Task 3: Suite Manifest Schema — Add vendorPlugins Field

**Files:**
- Modify: `packages/shared/src/suites/define.ts`
- Test: `packages/shared/src/__tests__/define-vendor-plugins.test.ts`

- [ ] **Step 1: Write failing test**

Create `/home/user/projects/personal-assistant/packages/shared/src/__tests__/define-vendor-plugins.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { defineSuite } from '../suites/define.ts';

describe('defineSuite vendorPlugins', () => {
  it('accepts vendorPlugins array and includes it in resolved manifest', () => {
    const suite = defineSuite({
      name: 'test-suite',
      displayName: 'Test Suite',
      description: 'A test',
      capabilities: ['agent-definition'],
      vendorPlugins: ['anthropic-skills', 'ffmpeg-master'],
    });

    expect(suite.vendorPlugins).toEqual(['anthropic-skills', 'ffmpeg-master']);
  });

  it('defaults vendorPlugins to empty array when omitted', () => {
    const suite = defineSuite({
      name: 'test-suite',
      displayName: 'Test Suite',
      description: 'A test',
      capabilities: [],
    });

    expect(suite.vendorPlugins).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/shared/src/__tests__/define-vendor-plugins.test.ts
```

Expected: FAIL — `vendorPlugins` not recognized by schema or not present on output.

- [ ] **Step 3: Add vendorPlugins to SuiteManifestSchema**

In `/home/user/projects/personal-assistant/packages/shared/src/suites/define.ts`, add to `SuiteManifestSchema`:

```typescript
vendorPlugins: z.array(z.string()).default([]),
```

Add it after the `services` field. Also update the `ResolvedSuiteManifest` type if it's explicitly defined (it may be inferred from the schema — check).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/shared/src/__tests__/define-vendor-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify all existing tests still pass**

```bash
npx vitest run
```

Expected: All tests pass — adding an optional field with a default should not break existing suite definitions.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/suites/define.ts packages/shared/src/__tests__/define-vendor-plugins.test.ts
git commit -m "feat: add vendorPlugins field to suite manifest schema"
```

---

### Task 4: Suite Loader — Resolve Vendor Plugin Paths

**Files:**
- Modify: `packages/core/src/suite-registry/suite-loader.ts`
- Modify: `packages/core/src/suite-registry/suite-registry.ts`
- Test: `packages/core/src/__tests__/suite-loader-vendor-plugins.test.ts`

- [ ] **Step 1: Write failing test**

Create `/home/user/projects/personal-assistant/packages/core/src/__tests__/suite-loader-vendor-plugins.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveVendorPlugins } from '../suite-registry/suite-loader.ts';

describe('resolveVendorPlugins', () => {
  it('resolves vendor plugin names to absolute paths', () => {
    const result = resolveVendorPlugins(
      ['anthropic-skills', 'ffmpeg-master'],
      '/project/vendor',
    );

    expect(result).toEqual([
      { type: 'local', path: '/project/vendor/anthropic-skills' },
      { type: 'local', path: '/project/vendor/ffmpeg-master' },
    ]);
  });

  it('returns empty array for no vendor plugins', () => {
    const result = resolveVendorPlugins([], '/project/vendor');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/core/src/__tests__/suite-loader-vendor-plugins.test.ts
```

Expected: FAIL — `resolveVendorPlugins` does not exist.

- [ ] **Step 3: Implement resolveVendorPlugins**

Add to `/home/user/projects/personal-assistant/packages/core/src/suite-registry/suite-loader.ts`:

```typescript
import { resolve } from 'node:path';

export interface ResolvedPlugin {
  type: 'local';
  path: string;
}

export function resolveVendorPlugins(
  vendorPlugins: string[],
  vendorDir: string,
): ResolvedPlugin[] {
  return vendorPlugins.map((name) => ({
    type: 'local' as const,
    path: resolve(vendorDir, name),
  }));
}
```

- [ ] **Step 4: Add vendorPlugins to LoadedSuite interface**

In the same file, add to the `LoadedSuite` interface:

```typescript
vendorPlugins: ResolvedPlugin[];
```

- [ ] **Step 5: Resolve vendor plugins in loadSuite()**

In the `loadSuite()` function, after loading the manifest, resolve vendor plugins:

```typescript
const vendorDir = resolve(suiteDir, '..', '..', 'vendor');
const vendorPlugins = resolveVendorPlugins(manifest.vendorPlugins ?? [], vendorDir);
```

Include `vendorPlugins` in the returned `LoadedSuite` object.

- [ ] **Step 6: Add collectVendorPlugins to SuiteRegistry**

In `/home/user/projects/personal-assistant/packages/core/src/suite-registry/suite-registry.ts`, add a method:

```typescript
collectVendorPlugins(suiteNames?: string[]): ResolvedPlugin[] {
  const plugins: ResolvedPlugin[] = [];
  const seen = new Set<string>();

  for (const [name, suite] of this.suites) {
    if (suiteNames && !suiteNames.includes(name)) continue;
    for (const plugin of suite.vendorPlugins) {
      if (!seen.has(plugin.path)) {
        seen.add(plugin.path);
        plugins.push(plugin);
      }
    }
  }

  return plugins;
}
```

Import `ResolvedPlugin` from `suite-loader.ts`.

- [ ] **Step 7: Run tests**

```bash
npx vitest run packages/core/src/__tests__/suite-loader-vendor-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 8: Verify full test suite**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/suite-registry/suite-loader.ts packages/core/src/suite-registry/suite-registry.ts packages/core/src/__tests__/suite-loader-vendor-plugins.test.ts
git commit -m "feat: resolve vendor plugins in suite loader and registry"
```

---

### Task 5: SDK Backend — Pass Plugins to query()

**Files:**
- Modify: `packages/core/src/agent-manager/agent-session.ts`
- Modify: `packages/core/src/agent-manager/sdk-backend.ts`
- Test: `packages/core/src/__tests__/sdk-backend-plugins.test.ts`

- [ ] **Step 1: Write failing test**

Create `/home/user/projects/personal-assistant/packages/core/src/__tests__/sdk-backend-plugins.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock the SDK query function to capture what options it receives
const mockQuery = vi.fn().mockImplementation(async function* () {
  yield { type: 'result', result: 'ok', sessionId: 'test-session' };
});

vi.mock('@anthropic-ai/claude-code', () => ({
  query: mockQuery,
}));

import { createSdkBackend } from '../agent-manager/sdk-backend.ts';

describe('SDK backend plugins', () => {
  it('passes plugins to query options when provided', async () => {
    const backend = createSdkBackend();
    const plugins = [
      { type: 'local' as const, path: '/vendor/anthropic-skills' },
      { type: 'local' as const, path: '/vendor/ffmpeg-master' },
    ];

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      plugins,
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.plugins).toEqual(plugins);
  });

  it('omits plugins from query options when empty', async () => {
    const backend = createSdkBackend();

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      plugins: [],
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.plugins).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/core/src/__tests__/sdk-backend-plugins.test.ts
```

Expected: FAIL — `plugins` not in `BackendOptions`.

- [ ] **Step 3: Add plugins to BackendOptions**

In `/home/user/projects/personal-assistant/packages/core/src/agent-manager/agent-session.ts`, add to `BackendOptions`:

```typescript
plugins?: Array<{ type: 'local'; path: string }>;
```

Add to `RunOptions`:

```typescript
plugins?: Array<{ type: 'local'; path: string }>;
```

In the `runAgentTask()` function, pass `plugins` through to the backend call:

Find where `BackendOptions` is constructed (the object passed to `backend(...)`) and add:

```typescript
plugins: opts.plugins,
```

- [ ] **Step 4: Pass plugins in sdk-backend.ts**

In `/home/user/projects/personal-assistant/packages/core/src/agent-manager/sdk-backend.ts`, after the existing `queryOptions` setup:

```typescript
if (opts.plugins && opts.plugins.length > 0) {
  queryOptions.plugins = opts.plugins;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run packages/core/src/__tests__/sdk-backend-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify full test suite**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent-manager/agent-session.ts packages/core/src/agent-manager/sdk-backend.ts packages/core/src/__tests__/sdk-backend-plugins.test.ts
git commit -m "feat: support plugins option in SDK backend for vendor skills"
```

---

### Task 6: File-Processing Suite

**Files:**
- Create: `suites/file-processing/suite.ts`
- Create: `suites/file-processing/mcp.json`
- Create: `suites/file-processing/actions.json`
- Create: `suites/file-processing/agents/file-agent.ts`
- Modify: `config/suites.json`

- [ ] **Step 1: Create suite directory**

```bash
mkdir -p /home/user/projects/personal-assistant/suites/file-processing/agents
```

- [ ] **Step 2: Create suite manifest**

Create `/home/user/projects/personal-assistant/suites/file-processing/suite.ts`:

```typescript
import { defineSuite, SUITE_FILE_PROCESSING } from '@raven/shared';

export default defineSuite({
  name: SUITE_FILE_PROCESSING,
  displayName: 'File Processing',
  version: '0.1.0',
  description: 'Document reading/creation, media processing via ffmpeg, and format conversion',
  capabilities: ['mcp-server', 'agent-definition'],
  requiresEnv: [],
  services: [],
  vendorPlugins: ['anthropic-skills', 'claude-plugin-marketplace/plugins/ffmpeg-master'],
});
```

- [ ] **Step 3: Create MCP config**

Create `/home/user/projects/personal-assistant/suites/file-processing/mcp.json`:

```json
{
  "mcpServers": {
    "markdownify": {
      "command": "node",
      "args": ["vendor/markdownify-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Note: If markdownify-mcp uses a different entry point after building, adjust the `args` path. Check `vendor/markdownify-mcp/package.json` for the `main` or `bin` field.

- [ ] **Step 4: Create actions**

Create `/home/user/projects/personal-assistant/suites/file-processing/actions.json`:

```json
[
  {
    "name": "file-processing:read",
    "description": "Read and extract content from documents",
    "defaultTier": "green",
    "reversible": true
  },
  {
    "name": "file-processing:create",
    "description": "Create or modify document files",
    "defaultTier": "yellow",
    "reversible": true
  },
  {
    "name": "file-processing:convert",
    "description": "Convert files between formats",
    "defaultTier": "yellow",
    "reversible": true
  },
  {
    "name": "file-processing:media",
    "description": "Process audio or video with ffmpeg",
    "defaultTier": "yellow",
    "reversible": true
  },
  {
    "name": "file-processing:delete",
    "description": "Permanently delete processed files",
    "defaultTier": "red",
    "reversible": false
  }
]
```

- [ ] **Step 5: Create file-agent**

Create `/home/user/projects/personal-assistant/suites/file-processing/agents/file-agent.ts`:

```typescript
import {
  defineAgent,
  buildMcpToolPattern,
  AGENT_FILE,
  MCP_MARKDOWNIFY,
} from '@raven/shared';

export default defineAgent({
  name: AGENT_FILE,
  description:
    'Handles all file operations: read/extract documents (PDF, DOCX, XLSX, PPTX), create/edit documents, convert between formats, and process audio/video with ffmpeg (transcode, trim, split, extract audio, add subtitles, concatenate, silence removal, etc.).',
  model: 'sonnet',
  tools: [
    buildMcpToolPattern(MCP_MARKDOWNIFY),
    'Skill',
    'Bash',
    'Read',
    'Write',
    'Glob',
    'Grep',
  ],
  mcpServers: [MCP_MARKDOWNIFY],
  maxTurns: 25,
  prompt: `You are a file processing agent within Raven personal assistant.

## Capabilities

**Documents** — Read, extract, create, and edit PDF, DOCX, XLSX, PPTX files.
Use the markdownify MCP tools for quick text extraction to markdown.
Use the Skill tool to load document skills (pdf, docx, xlsx, pptx) for full read/write/edit capabilities.

**Media** — Process audio and video using ffmpeg.
Use the Skill tool to load the ffmpeg-master skill for comprehensive ffmpeg operations, then execute commands via Bash.

**Conversion** — Convert between file formats using extraction + creation tools.

## File Output Convention

1. Save all output files under the data/files/ directory, organized by type:
   - data/files/documents/ for document output
   - data/files/media/ for audio/video output
2. Use descriptive filenames with dates when appropriate.
3. Return ALL output file paths clearly at the end of your response in a section like:

   ## Output Files
   - /absolute/path/to/output.docx

4. If creating multiple files, list them all.

## Skills Available (load on demand via Skill tool)

- pdf — Read, create, merge, split, OCR, watermark, encrypt PDF files
- docx — Read, create, edit Word documents with full formatting
- xlsx — Read, create, edit Excel spreadsheets with formulas and charts
- pptx — Read, create, edit PowerPoint presentations
- ffmpeg-master — Comprehensive ffmpeg video/audio processing

Only load the skills you need for the current task. Do not load all skills preemptively.

## Important

- Always check that input files exist before processing.
- For large media operations, provide progress feedback.
- Ensure output directories exist before writing (mkdir -p via Bash if needed).`,
});
```

- [ ] **Step 6: Enable suite in config**

Add to `/home/user/projects/personal-assistant/config/suites.json`:

```json
"file-processing": { "enabled": true }
```

Add it after the last existing entry (before the closing `}`).

- [ ] **Step 7: Verify suite loads**

```bash
cd /home/user/projects/personal-assistant
npm run build
```

Expected: Build succeeds. The suite-loader will pick up the new suite directory on next startup.

- [ ] **Step 8: Commit**

```bash
git add suites/file-processing/ config/suites.json
git commit -m "feat: add file-processing suite with file-agent

Single agent handles documents (PDF, DOCX, XLSX, PPTX) and media (ffmpeg)
via vendored skills and markdownify MCP server."
```

---

### Task 7: Gemini Transcription Upgrade

**Files:**
- Modify: `suites/gemini-transcription/services/voice-transcriber.ts`
- Create: `suites/gemini-transcription/agents/transcription-agent.ts`
- Modify: `suites/gemini-transcription/suite.ts`
- Test: `suites/gemini-transcription/__tests__/voice-transcriber.test.ts` (update existing)

- [ ] **Step 1: Read existing test file to understand test patterns**

Read `/home/user/projects/personal-assistant/suites/gemini-transcription/__tests__/voice-transcriber.test.ts` to understand the existing mock structure before modifying.

- [ ] **Step 2: Update model in voice-transcriber.ts**

In `/home/user/projects/personal-assistant/suites/gemini-transcription/services/voice-transcriber.ts`, change:

```typescript
// Before:
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// After:
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
```

- [ ] **Step 3: Add file-based transcription function**

In the same file, add a new function for transcribing files (as opposed to inline base64 audio). Add this after the existing `createTranscriber` function:

```typescript
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const FILE_TRANSCRIPTION_TIMEOUT_MS = 600_000; // 10 minutes for long files
const TRANSCRIPTS_DIR = 'data/files/transcripts';

async function transcribeFile(filePath: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');

  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  log.info(`Uploading file for transcription: ${filePath}`);
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: basename(filePath),
  });

  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    log.info(`Waiting for file processing: ${file.name} (state: ${file.state})`);
    await new Promise((r) => setTimeout(r, 5000));
    file = await fileManager.getFile(file.name);
  }

  if (file.state === 'FAILED') {
    throw new Error(`File processing failed: ${file.name}`);
  }

  log.info(`File ready, starting transcription: ${file.name}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILE_TRANSCRIPTION_TIMEOUT_MS);

  try {
    const result = await model.generateContent(
      {
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: file.mimeType!, fileUri: file.uri } },
              {
                text: 'Transcribe this audio/video accurately. Return only the transcribed text with natural paragraph breaks. Preserve speaker changes if detectable.',
              },
            ],
          },
        ],
      },
      { signal: controller.signal } as unknown as Record<string, unknown>,
    );

    return result.response.text();
  } finally {
    clearTimeout(timeout);
    // Clean up remote file
    try {
      await fileManager.deleteFile(file.name);
    } catch {
      log.warn(`Failed to delete remote file: ${file.name}`);
    }
  }
}

function saveTranscript(filePath: string, transcript: string): string {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const sourceName = basename(filePath).replace(/\.[^.]+$/, '');
  const transcriptPath = join(TRANSCRIPTS_DIR, `${date}-${sourceName}.txt`);

  writeFileSync(transcriptPath, transcript, 'utf-8');
  log.info(`Transcript saved to ${transcriptPath}`);
  return transcriptPath;
}
```

- [ ] **Step 4: Add transcription:request event handler**

In the `start()` method of the service, add a listener for `transcription:request` events:

```typescript
const transcriptionHandler = async (event: unknown): Promise<void> => {
  const parsed = TranscriptionRequestPayloadSchema.safeParse(
    (event as Record<string, unknown>).payload,
  );
  if (!parsed.success) {
    log.error(`Invalid transcription:request payload: ${parsed.error.message}`);
    return;
  }

  const { filePath, mimeType, projectId, createKnowledgeBubble, topicId, topicName } = parsed.data;

  try {
    const transcript = await transcribeFile(filePath, mimeType);
    const transcriptPath = saveTranscript(filePath, transcript);

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'transcription:complete',
      payload: { filePath, transcriptPath, projectId, topicId, topicName },
    });

    if (createKnowledgeBubble) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SOURCE_GEMINI,
        type: 'knowledge:ingest:request',
        payload: {
          type: 'file',
          filePath: transcriptPath,
          source: 'transcription',
          title: `Transcript: ${basename(filePath)}`,
        },
      });
    }

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'notification',
      payload: {
        channel: 'telegram',
        title: 'Transcription Complete',
        body: `Transcribed: ${basename(filePath)}`,
        filePath: transcriptPath,
        topicName,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`File transcription failed: ${msg}`);
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'transcription:failed',
      payload: { filePath, error: msg, projectId },
    });
  }
};

context.eventBus.on('transcription:request', transcriptionHandler);
```

Remember to also `off` this handler in `stop()`.

Import `TranscriptionRequestPayloadSchema` from `@raven/shared`.

- [ ] **Step 5: Create transcription-agent**

Create `/home/user/projects/personal-assistant/suites/gemini-transcription/agents/transcription-agent.ts`:

```typescript
import { defineAgent, AGENT_TRANSCRIPTION } from '@raven/shared';

export default defineAgent({
  name: AGENT_TRANSCRIPTION,
  description:
    'Transcribes audio and video files using Google Gemini. Handles files up to 9.5 hours long (2GB max). Saves transcript to data/files/transcripts/ and returns the file path. Use for lectures, meetings, interviews, podcasts, or any audio/video content.',
  model: 'sonnet',
  tools: ['Bash', 'Read', 'Write', 'Glob'],
  maxTurns: 10,
  prompt: `You are a transcription agent within Raven personal assistant.

## How to Transcribe

Emit a transcription:request event by writing a small Node.js script and running it via Bash.
The voice-transcriber service listens for this event and handles the Gemini File API calls.

Alternatively, for simple cases, you can write and run a Node.js script directly that:
1. Uses GoogleAIFileManager from @google/generative-ai/server to upload the file
2. Uses GoogleGenerativeAI to transcribe with gemini-2.5-flash
3. Saves the transcript to data/files/transcripts/

The GOOGLE_API_KEY environment variable is available.

## Output Convention

- Save transcripts as .txt files in data/files/transcripts/
- Filename format: YYYY-MM-DD-<source-description>.txt
- Return the full file path in your response.
- For very long transcripts, also provide a brief summary.`,
});
```

- [ ] **Step 6: Update suite manifest**

In `/home/user/projects/personal-assistant/suites/gemini-transcription/suite.ts`, add `'agent-definition'` to capabilities if not already present:

```typescript
import { defineSuite, SUITE_GEMINI_TRANSCRIPTION } from '@raven/shared';

export default defineSuite({
  name: SUITE_GEMINI_TRANSCRIPTION,
  displayName: 'Gemini Voice Transcription',
  version: '0.2.0',
  description: 'Voice message and file transcription via Google Gemini',
  capabilities: ['agent-definition'],
  requiresEnv: ['GOOGLE_API_KEY'],
  services: ['voice-transcriber'],
});
```

- [ ] **Step 7: Update existing tests**

Read the existing test file and update the model reference from `gemini-2.0-flash` to `gemini-2.5-flash`. Add a test case for the `transcription:request` event handler if the test structure supports it (mock the file operations and Gemini API).

- [ ] **Step 8: Run tests**

```bash
npx vitest run suites/gemini-transcription/
```

Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add suites/gemini-transcription/
git commit -m "feat: upgrade Gemini transcription — 2.5-flash, File API, transcription-agent

- Model upgrade: gemini-2.0-flash -> gemini-2.5-flash
- File API support for long audio/video (up to 9.5 hours)
- New transcription-agent for on-demand orchestrator calls
- New transcription:request event for programmatic transcription
- Saves transcripts to data/files/transcripts/"
```

---

### Task 8: File Download API Route

**Files:**
- Create: `packages/core/src/api/routes/files.ts`
- Modify: `packages/core/src/api/server.ts`
- Test: `packages/core/src/__tests__/file-download-api.test.ts`

- [ ] **Step 1: Write failing test**

Create `/home/user/projects/personal-assistant/packages/core/src/__tests__/file-download-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerFileRoutes } from '../api/routes/files.ts';

describe('file download API', () => {
  let app: ReturnType<typeof Fastify>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'raven-files-test-'));
    mkdirSync(join(dataDir, 'files', 'documents'), { recursive: true });
    writeFileSync(join(dataDir, 'files', 'documents', 'test.txt'), 'hello world');

    app = Fastify();
    registerFileRoutes(app, dataDir);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a file from data/files/', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/documents/test.txt',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('hello world');
  });

  it('returns 404 for non-existent file', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/documents/nope.txt',
    });

    expect(response.statusCode).toBe(404);
  });

  it('blocks path traversal attempts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/../../../etc/passwd',
    });

    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/core/src/__tests__/file-download-api.test.ts
```

Expected: FAIL — `routes/files.ts` does not exist.

- [ ] **Step 3: Implement file download route**

Create `/home/user/projects/personal-assistant/packages/core/src/api/routes/files.ts`:

```typescript
import { resolve, normalize } from 'node:path';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { lookup } from 'node:dns';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@raven/shared';

const log = createLogger('file-routes');

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function registerFileRoutes(app: FastifyInstance, dataDir: string): void {
  const filesRoot = resolve(dataDir, 'files');

  app.get('/api/files/*', async (request, reply) => {
    const requestedPath = (request.params as Record<string, string>)['*'];
    if (!requestedPath) {
      return reply.status(400).send({ error: 'No file path specified' });
    }

    const resolvedPath = resolve(filesRoot, normalize(requestedPath));

    // Path traversal protection
    if (!resolvedPath.startsWith(filesRoot)) {
      log.warn(`Path traversal attempt blocked: ${requestedPath}`);
      return reply.status(403).send({ error: 'Forbidden' });
    }

    if (!existsSync(resolvedPath)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
      return reply.status(400).send({ error: 'Cannot serve directories' });
    }

    const mimeType = getMimeType(resolvedPath);
    const fileName = resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1);

    return reply
      .header('Content-Type', mimeType)
      .header('Content-Disposition', `inline; filename="${fileName}"`)
      .header('Content-Length', stat.size)
      .send(createReadStream(resolvedPath));
  });
}
```

- [ ] **Step 4: Register route in server.ts**

In `/home/user/projects/personal-assistant/packages/core/src/api/server.ts`, add:

```typescript
import { registerFileRoutes } from './routes/files.ts';
```

And in the route registration section, add:

```typescript
registerFileRoutes(app, deps.dataDir);
```

If `deps` doesn't have `dataDir`, check what property provides the data directory path (it might be `deps.config.dataDir` or similar — follow the existing pattern for how other routes access data paths).

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run packages/core/src/__tests__/file-download-api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/api/routes/files.ts packages/core/src/api/server.ts packages/core/src/__tests__/file-download-api.test.ts
git commit -m "feat: add file download API route (GET /api/files/*)"
```

---

### Task 9: Telegram File Sending

**Files:**
- Modify: `suites/notifications/services/telegram-bot.ts`
- Test: `suites/notifications/__tests__/telegram-bot.test.ts` (update existing)

- [ ] **Step 1: Read existing telegram-bot.ts notification handling**

Read the full notification handling section of `/home/user/projects/personal-assistant/suites/notifications/services/telegram-bot.ts` to find where notifications are delivered (look for `notification:deliver` or `notification` event handler and the `sendMessage` call).

- [ ] **Step 2: Add sendDocument capability**

In the notification delivery handler, add file attachment support. After the existing `sendMessage` call, add a check for `filePath`:

```typescript
import { InputFile } from 'grammy';
import { existsSync, statSync } from 'node:fs';

// Inside the notification delivery handler, after sending the text message:
if (payload.filePath && existsSync(payload.filePath)) {
  const stat = statSync(payload.filePath);
  const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50MB

  if (stat.size <= TELEGRAM_FILE_LIMIT) {
    try {
      await bot.api.sendDocument(
        targetChatId,
        new InputFile(payload.filePath),
        {
          ...(messageThreadId !== undefined && operatingMode === 'group'
            ? { message_thread_id: messageThreadId }
            : {}),
        },
      );
    } catch (err) {
      log.error(`Failed to send document via Telegram: ${err}`);
    }
  } else {
    // File too large for Telegram — send download link
    const relativePath = payload.filePath.replace(/^data\/files\//, '');
    const downloadUrl = `${process.env.RAVEN_BASE_URL ?? 'http://localhost:3001'}/api/files/${relativePath}`;
    await sendMessage(
      `File too large for Telegram. Download: ${downloadUrl}`,
      undefined,
      messageThreadId,
    );
  }
}
```

- [ ] **Step 3: Update existing telegram-bot tests**

Read the existing test file and add a test case for file sending. Mock `bot.api.sendDocument` and verify it's called when `filePath` is in the notification payload.

- [ ] **Step 4: Run tests**

```bash
npx vitest run suites/notifications/__tests__/telegram-bot.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add suites/notifications/services/telegram-bot.ts suites/notifications/__tests__/telegram-bot.test.ts
git commit -m "feat: add Telegram file sending for notification attachments

Sends documents via sendDocument when notification includes filePath.
Falls back to download link for files over 50MB."
```

---

### Task 10: Wire Plugins into Orchestrator and Agent Manager

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts`
- Modify: `packages/core/src/agent-manager/agent-manager.ts`

- [ ] **Step 1: Read orchestrator to understand task emission**

Read `/home/user/projects/personal-assistant/packages/core/src/orchestrator/orchestrator.ts` to find where `agent:task:request` events are emitted, specifically for user chat messages. Understand how `mcpServers` and `agentDefinitions` are currently passed.

- [ ] **Step 2: Read agent-manager to understand task consumption**

Read `/home/user/projects/personal-assistant/packages/core/src/agent-manager/agent-manager.ts` to find where `runAgentTask()` is called and how `RunOptions` is constructed.

- [ ] **Step 3: Pass vendor plugins in orchestrator task emission**

In the orchestrator, when emitting `agent:task:request` for user chat or scheduled tasks, include vendor plugins from the suite registry. The `agent:task:request` payload needs a `plugins` field.

In the user chat handler (or the general task emission logic):

```typescript
// Collect all vendor plugins for the orchestrator (it needs all, since it can delegate to any sub-agent)
const allPlugins = this.suiteRegistry.collectVendorPlugins();
```

Add `plugins: allPlugins` to the `agent:task:request` payload.

For suite-specific tasks (scheduled, event-driven), pass only that suite's vendor plugins:

```typescript
const suite = this.suiteRegistry.getSuite(suiteName);
const plugins = suite?.vendorPlugins ?? [];
```

- [ ] **Step 4: Pass plugins in agent-manager task execution**

In the agent-manager, when calling `runAgentTask()`, pass the `plugins` from the task payload:

```typescript
const result = await runAgentTask({
  task,
  eventBus: this.eventBus,
  mcpServers,
  agentDefinitions,
  plugins: task.plugins, // Add this
  // ... other opts
});
```

- [ ] **Step 5: Update AgentTask type if needed**

Check `packages/shared/src/types/agents.ts` for the `AgentTask` interface. If it doesn't have a `plugins` field, add:

```typescript
plugins?: Array<{ type: 'local'; path: string }>;
```

Also update the `AgentTaskRequest` event payload type to include `plugins`.

- [ ] **Step 6: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator.ts packages/core/src/agent-manager/agent-manager.ts packages/shared/src/types/agents.ts
git commit -m "feat: wire vendor plugins through orchestrator and agent manager

Orchestrator collects all vendor plugins for user chat tasks.
Suite-specific tasks get only their suite's vendor plugins.
AgentManager passes plugins to runAgentTask -> SDK backend."
```

---

### Task 11: README and Documentation Updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add system dependencies section**

In `/home/user/projects/personal-assistant/README.md`, add or update the Prerequisites section:

```markdown
### System Dependencies

Install these on your host machine (Ubuntu/WSL2):

```bash
# Required
sudo apt install -y ffmpeg libreoffice poppler-utils pandoc tesseract-ocr

# Python (for vendor MCP servers)
# Install uv (Python package manager):
curl -LsSf https://astral.sh/uv/install.sh | sh
```

| Dependency | Purpose |
|---|---|
| Node.js 22+ | Runtime |
| Python 3.10+ | Vendor MCP servers |
| uv | Python package manager |
| FFmpeg | Audio/video processing (file-processing suite) |
| LibreOffice | Document conversion (docx/xlsx/pptx skills) |
| Poppler | PDF rendering — pdftoppm (pdf skill) |
| Pandoc | Document reading (docx skill) |
| Tesseract | PDF OCR (pdf skill) |
```

- [ ] **Step 2: Add vendor management section**

```markdown
### Vendor Skills

Third-party Claude Code skills are vendored as git submodules in `vendor/`:

```bash
# Initial setup (after clone)
git submodule update --init --recursive

# Update all vendor skills to latest
./scripts/update-vendor.sh
```

| Vendor | Source | Purpose |
|---|---|---|
| anthropic-skills | anthropics/skills | PDF, DOCX, XLSX, PPTX read/create/edit |
| claude-plugin-marketplace | JosiahSiegel/claude-plugin-marketplace | ffmpeg-master media processing |
| smart-extractors | diegocconsolini/ClaudeSkillCollection | Cached document extraction |
| markdownify-mcp | zcaceres/markdownify-mcp | Document-to-markdown MCP server |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add system dependencies and vendor skills to README"
```

---

### Task 12: Final Build and Lint Verification

**Files:** None (verification only)

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 2: Lint and format check**

```bash
npm run check
```

Expected: Pass. Fix any lint errors before proceeding.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Verify suite loading**

Start the server briefly and check that the file-processing suite loads:

```bash
RAVEN_PORT=4002 timeout 10 node packages/core/dist/index.js 2>&1 | head -50
```

Look for log lines showing `file-processing` suite loaded, `file-agent` registered, `markdownify` MCP configured.

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: lint and build fixups for file-processing suite"
```

Only if there were changes to fix.
