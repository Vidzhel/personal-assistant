# File Processing Suite Design

## Overview

Add a file processing suite to Raven that handles document reading/creation, media processing (ffmpeg), and transcription (Gemini). Uses vendored Claude Code skills and MCP servers loaded into sub-agents via the Claude Agent SDK, with no hard-coded workflows.

## Architecture Principles

### Orchestrator-Driven Composition

The orchestrator agent is the workflow engine. It dynamically plans multi-step tasks and delegates to domain agents, passing file paths between them. No hard-coded pipelines or constrained workflows exist in application code.

Complex cross-suite example: "Transcribe this lecture, summarize into a Word doc, add action items to TickTick" flows as:

1. Orchestrator spawns `file-agent` → extract audio → returns file path
2. Orchestrator spawns `transcription-agent` → transcribe → returns transcript file path
3. Orchestrator spawns `file-agent` → read transcript, create Word summary, return action items
4. Orchestrator spawns `ticktick-agent` → create tasks from action items

The orchestrator decides this flow at runtime based on the user's request. A simpler request like "convert this to 720p" spawns file-agent once.

### Fewer, More Capable Agents

Agents are grouped by **capability domain**, not by individual operations. One `file-agent` handles all file operations (read, create, convert, media processing) because:

- **Skills load on-demand** via the `Skill` tool. Having many skills available only adds short descriptions to the system reminder; full skill content loads only when invoked.
- **MCPs need isolation** but the file domain only uses one MCP (markdownify), so no isolation concern.
- **Reduces orchestrator relay** — the file-agent can do multi-step file work (e.g., extract audio AND create a document) in a single agent call.

### File Paths as Universal Interface

Agents write output to `data/files/` and return paths. The orchestrator passes paths between agents, never large content blobs. This keeps context windows small even for 2-hour lecture transcripts.

## Agent Hierarchy

```
Orchestrator (Claude, no MCPs, knows all agents)
  |
  |-- file-agent (markdownify MCP + skills: pdf, docx, xlsx, pptx, ffmpeg-master)
  |     -> any file read/create/convert/media operation
  |
  |-- transcription-agent (no MCP, uses Gemini File API directly)
  |     -> audio/video transcription, handles 2hr+ lectures
  |
  |-- ticktick-agent (ticktick MCP)
  |-- gmail-agent (gmail MCP)
  |-- gws-agent (google workspace MCP)
  |-- digest-agent (no MCP, composes from other agents)
  +-- ...future agents
```

## New Suite: `file-processing`

### Directory Structure

```
suites/file-processing/
  suite.ts              # Manifest with capabilities + vendor plugin declarations
  mcp.json              # markdownify MCP server
  actions.json          # Permission tiers for file operations
  agents/
    file-agent.ts       # Single agent: documents + media + conversion
```

No services directory — file processing is on-demand, not event-driven. The existing `media-router` service in the notifications suite already handles Telegram file reception and routes to the orchestrator via `user:chat:message` events.

### Suite Manifest (`suite.ts`)

```typescript
import { defineSuite } from '@raven/shared';

export default defineSuite({
  name: 'file-processing',
  displayName: 'File Processing',
  version: '0.1.0',
  description: 'Document reading/creation, media processing, and format conversion',
  capabilities: ['mcp-server', 'agent-definition'],
  requiresEnv: [],
  services: [],
  vendorPlugins: [
    'anthropic-skills',
    'ffmpeg-master',
  ],
});
```

### MCP Configuration (`mcp.json`)

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

### Agent Definition (`agents/file-agent.ts`)

```typescript
import { defineAgent, buildMcpToolPattern } from '@raven/shared';

export default defineAgent({
  name: 'file-agent',
  description: 'Handles all file operations: read/extract documents (PDF, DOCX, XLSX, PPTX), create/edit documents, convert between formats, and process audio/video with ffmpeg (transcode, trim, split, extract audio, add subtitles, concatenate, etc.).',
  model: 'sonnet',
  tools: [
    buildMcpToolPattern('markdownify'),
    'Skill',
    'Bash',
    'Read',
    'Write',
    'Glob',
    'Grep',
  ],
  mcpServers: ['markdownify'],
  maxTurns: 25,
  prompt: `You are a file processing agent within Raven. You handle document and media operations.

## Capabilities

- **Documents**: Read, extract, create, and edit PDF, DOCX, XLSX, PPTX files using your installed skills.
- **Media**: Process audio/video using ffmpeg via the ffmpeg-master skill and Bash.
- **Conversion**: Convert between file formats using markdownify MCP (for reading/extracting to markdown) and document skills (for creating output formats).

## File Output Convention

- Save all output files to the directory specified in the task prompt (default: data/files/).
- Organize by type: data/files/documents/, data/files/media/, etc.
- Return the output file path in your response so it can be passed to other agents or sent to the user.
- For task artifacts: list all generated file paths clearly at the end of your response.

## Skills Available

Use the Skill tool to load these as needed:
- pdf: Read, create, merge, split, OCR, watermark PDF files
- docx: Read, create, edit Word documents with formatting
- xlsx: Read, create, edit Excel spreadsheets with formulas
- pptx: Read, create, edit PowerPoint presentations
- ffmpeg-master: Comprehensive ffmpeg operations for audio/video

Only load the skills you actually need for the current task.`,
});
```

### Actions (`actions.json`)

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
    "description": "Process audio/video with ffmpeg",
    "defaultTier": "yellow",
    "reversible": true
  },
  {
    "name": "file-processing:delete",
    "description": "Delete processed files",
    "defaultTier": "red",
    "reversible": false
  }
]
```

## Vendor Directory & Git Submodules

### Structure

```
vendor/
  anthropic-skills/          # git submodule -> github.com/anthropics/skills
  ffmpeg-master/             # git submodule -> extracted from JosiahSiegel/claude-plugin-marketplace
  smart-extractors/          # git submodule -> github.com/diegocconsolini/ClaudeSkillCollection
  markdownify-mcp/           # git submodule -> github.com/zcaceres/markdownify-mcp
```

### Submodule Setup

```bash
git submodule add https://github.com/anthropics/skills.git vendor/anthropic-skills
git submodule add https://github.com/diegocconsolini/ClaudeSkillCollection.git vendor/smart-extractors
git submodule add https://github.com/zcaceres/markdownify-mcp.git vendor/markdownify-mcp
# ffmpeg-master needs extraction from the marketplace repo or direct clone
git submodule add https://github.com/JosiahSiegel/claude-plugin-marketplace.git vendor/claude-plugin-marketplace
```

### Update Script (`scripts/update-vendor.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Updating vendor submodules..."

cd "$PROJECT_ROOT"

# Update all submodules to latest remote HEAD
git submodule update --remote --merge

# Rebuild markdownify-mcp if it was updated
MARKDOWNIFY_DIR="$PROJECT_ROOT/vendor/markdownify-mcp"
if [ -d "$MARKDOWNIFY_DIR" ]; then
  echo "Building markdownify-mcp..."
  cd "$MARKDOWNIFY_DIR"
  pnpm install --frozen-lockfile 2>/dev/null || npm install
  pnpm build 2>/dev/null || npm run build
  cd "$PROJECT_ROOT"
fi

echo "Vendor update complete."
echo ""
echo "Updated submodules:"
git submodule status
```

## SDK Backend: Plugin Loading

### Changes to `sdk-backend.ts`

Extend `queryOptions` to support `plugins` for loading vendor skills into sub-agents:

```typescript
// In sdk-backend.ts, after existing queryOptions setup:
if (opts.plugins && opts.plugins.length > 0) {
  queryOptions.plugins = opts.plugins;
}
```

### Changes to agent session types

Extend `RunOptions` and the agent task types to carry plugin paths:

```typescript
// In shared types
interface AgentDefinition {
  // ... existing fields
  vendorPlugins?: string[];  // Names from suite manifest's vendorPlugins
}

// In suite-loader.ts, resolve vendor plugin names to absolute paths
function resolveVendorPlugins(
  vendorPlugins: string[],
  vendorDir: string,
): Array<{ type: 'local'; path: string }> {
  return vendorPlugins.map(name => ({
    type: 'local' as const,
    path: resolve(vendorDir, name),
  }));
}
```

### Plugin Resolution Flow

1. Suite manifest declares `vendorPlugins: ['anthropic-skills', 'ffmpeg-master']`
2. SuiteRegistry resolves these to absolute paths in `vendor/`
3. When an agent task is created, the resolved plugin paths are included
4. `sdk-backend.ts` passes them as `queryOptions.plugins` to `query()`
5. The sub-agent gets those skills loaded into its environment

## Gemini Transcription Upgrade

### Changes to existing `gemini-transcription` suite

#### 1. Model upgrade

In `voice-transcriber.ts`:
```typescript
// Before:
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// After:
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
```

#### 2. File API for long audio/video

For files over ~20MB (or longer than a few minutes), switch from inline base64 to the Gemini File API:

```typescript
import { GoogleAIFileManager } from '@google/generative-ai/server';

async function transcribeLargeFile(filePath: string, mimeType: string): Promise<string> {
  const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY!);

  // Upload file to Gemini
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: basename(filePath),
  });

  // Wait for processing
  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 5000));
    file = await fileManager.getFile(file.name);
  }

  // Transcribe
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: 'Transcribe this audio/video accurately. Return only the transcribed text with paragraph breaks.' },
  ]);

  // Cleanup remote file
  await fileManager.deleteFile(file.name);

  return result.response.text();
}
```

Gemini supports up to 9.5 hours of audio and 2GB file uploads, so 2-hour lectures are well within range.

#### 3. New transcription-agent

Add `agents/transcription-agent.ts` to the gemini-transcription suite so the orchestrator can call it on-demand (separate from the automatic voice-transcriber service):

```typescript
import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'transcription-agent',
  description: 'Transcribes audio and video files using Google Gemini. Handles files up to 9.5 hours. Saves transcript to data/files/transcripts/ and returns the file path.',
  model: 'sonnet',
  tools: ['Bash', 'Read', 'Write'],
  maxTurns: 10,
  prompt: `You are a transcription agent. You transcribe audio and video files using the Gemini API.

## Process

1. Receive a file path to an audio or video file.
2. Use the Gemini File API to upload and transcribe.
3. Save the transcript to data/files/transcripts/ with a descriptive filename.
4. Return the transcript file path.

## Implementation

The voice-transcriber service handles the actual Gemini API calls. Emit a transcription:request event with the file path, or call the Gemini File API directly using the @google/generative-ai package. The GOOGLE_API_KEY environment variable is available.

## Output Convention

- Save transcripts as .txt files in data/files/transcripts/
- Use descriptive filenames: YYYY-MM-DD-<source-description>.txt
- Return the full file path in your response.`,
});
```

#### 4. Existing voice-transcriber service

Stays as-is (with model upgrade) for automatic Telegram voice note processing. No architectural change — it listens on `voice:received` events and processes immediately via the Gemini API without spawning an agent.

#### 5. New `transcription:request` event

For programmatic transcription requests (from orchestrator or other services):

```typescript
// In shared/src/types/events.ts
interface TranscriptionRequestEvent extends RavenEvent {
  type: 'transcription:request';
  payload: {
    filePath: string;
    mimeType: string;
    projectId?: string;
    createKnowledgeBubble?: boolean;  // default true
    topicId?: string;
    topicName?: string;
  };
}
```

The voice-transcriber service will also listen on `transcription:request` for file-based transcription.

## File Download API

### New Fastify Route

Add `GET /api/files/*` to serve files from `data/`:

```typescript
// In packages/core/src/api/routes/files.ts
import { resolve, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

export function registerFileRoutes(app: FastifyInstance, dataDir: string): void {
  app.get('/api/files/*', async (request, reply) => {
    const requestedPath = (request.params as Record<string, string>)['*'];
    const resolvedPath = resolve(dataDir, 'files', normalize(requestedPath));

    // Path traversal protection
    if (!resolvedPath.startsWith(resolve(dataDir, 'files'))) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    if (!existsSync(resolvedPath)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return reply.sendFile(resolvedPath);
  });
}
```

### Telegram File Sending

Extend the notification event payload to support file attachments:

```typescript
// In notification handling within telegram-bot.ts
if (notification.filePath) {
  const stats = statSync(notification.filePath);
  if (stats.size <= 50 * 1024 * 1024) {  // 50MB Telegram limit
    await bot.api.sendDocument(chatId, new InputFile(notification.filePath), {
      caption: notification.body,
      message_thread_id: topicId,
    });
  } else {
    // Send download link for large files
    const downloadUrl = `${baseUrl}/api/files/${relative(dataDir, notification.filePath)}`;
    await bot.api.sendMessage(chatId, `${notification.body}\n\nDownload: ${downloadUrl}`, {
      message_thread_id: topicId,
    });
  }
}
```

### Task Artifact Convention

Agents producing files must:
1. Save output to `data/files/<category>/` (documents, media, transcripts)
2. Return file paths clearly in their response
3. The orchestrator or calling code adds paths to `task.artifacts[]`

## System Dependencies

Add to README and Dockerfile:

### Required

| Dependency | Install (Ubuntu/WSL2) | Purpose |
|---|---|---|
| Node.js 22+ | `nvm install 22` | Runtime |
| Python 3.10+ | `apt install python3` | vendor MCP servers |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | Python package manager |
| FFmpeg | `apt install ffmpeg` | Audio/video processing |
| LibreOffice | `apt install libreoffice` | Document conversion (docx/xlsx/pptx skills) |
| Poppler | `apt install poppler-utils` | PDF rendering (pdftoppm) |
| Pandoc | `apt install pandoc` | Document reading |
| Tesseract | `apt install tesseract-ocr` | PDF OCR |

### Optional

| Dependency | Install | Purpose |
|---|---|---|
| Docker | docker.com | Containerized deployment |

## Configuration

### `config/suites.json` addition

```json
{
  "file-processing": {
    "enabled": true
  }
}
```

### Shared Constants

Add to `packages/shared/src/suites/constants.ts`:

```typescript
export const SUITE_FILE_PROCESSING = 'file-processing';
export const AGENT_FILE = 'file-agent';
export const MCP_MARKDOWNIFY = 'markdownify';
```

## What Is NOT Changing

- **No content-extractor.ts changes** — the orchestrator handles routing dynamically. The existing content extractor continues serving the knowledge ingestion pipeline for text and PDF files.
- **No hard-coded file type routing** — the orchestrator decides which agent to call based on the user's request and file context.
- **No new services** — file processing is on-demand. The existing media-router handles Telegram file reception.
- **Existing knowledge ingestion pipeline** — continues working as-is for text, PDF, URLs, and voice memos.

## Future Extensions

- **Watch folder service**: Add a service to `file-processing` suite that monitors a directory for new files and emits events.
- **Email attachment processing**: Gmail suite already detects attachments; orchestrator can route to file-agent.
- **Additional vendor skills**: Clone new skill repos into `vendor/`, add to suite manifest.
- **Additional MCP servers**: Add to `mcp.json` as needed (e.g., OCR-specific MCP for complex document scanning).
