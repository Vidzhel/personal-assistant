# Agent File Memory (Layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every named agent a private, git-tracked `memory/` directory it can read at spawn and write to via tools, with a hard, programmatically-enforced budget.

**Architecture:** A new `MemoryStore` (filesystem module, no MCP) owns all reads/writes to `projects/agents/<name>/memory/`, enforcing path-confinement and a per-agent budget read from `agent.yaml`. A dedicated in-process **`memory` MCP server** (separate from the Raven MCP, which is currently never wired into the agent path) exposes `memory_read`/`memory_write`/`memory_update` bound to the running agent's own directory. At spawn, the agent's `MEMORY.md` index is appended to its system prompt so it knows what it remembers. Identity comes from `task.namedAgentId`, which equals the agent's YAML `name` post-consolidation (id === name).

**Tech Stack:** TypeScript ESM, Zod, js-yaml, `@anthropic-ai/claude-agent-sdk` (`tool`, `createSdkMcpServer`), Vitest (temp dirs via `mkdtempSync`).

**Spec:** `docs/superpowers/specs/2026-06-11-consolidated-orchestration-design.md` §4 (Layer 1 — file memory, hard budget). Layer 2 (knowledge-researcher delegation) and Dreaming are **separate follow-up plans** — out of scope here.

**Key decisions (locked):**
- Identity: memory is keyed by `task.namedAgentId` (=== agent `name`). When `namedAgentId` is absent (generic/legacy tasks), no memory is attached — fail-quiet, not error.
- Memory lives at `<projectsDir>/agents/<agentName>/memory/` (global agents). Per-project agents are not memory-enabled in Layer 1.
- Budget is enforced in `MemoryStore.write`/`update` (the tool layer never decides) — an over-budget op is rejected with current usage in the error.
- A **dedicated `memory` MCP server** is attached, NOT the Raven MCP. `index.ts` does not wire `ravenMcpDeps` into `AgentManager` (verified), so reusing it would silently enable unrelated chat/task tools. The memory server avoids that.
- `MEMORY.md` is the index injected into the prompt; one fact per `*.md` file is a convention the agent follows, not enforced.

**Conventions reminders:** `.ts` extensions in imports; `explicit-function-return-type` and `max-params: 3` are errors in src (tests relaxed); `consistent-type-imports`; `no-console` (use `createLogger`); no chained shell commands — run one at a time; `npm run check` gate at the end. Pre-existing test failures exist in unrelated suites (knowledge-*, config-history, template-integration, template-scheduler) — compare against that same set, do not try to fix them.

---

### Task 1: AgentYaml memory budget field

**Files:**
- Modify: `packages/shared/src/project/schemas.ts` (add `MemoryBudgetSchema`, add `memory` field to `AgentYamlSchema`)
- Test: `packages/shared/src/__tests__/agent-yaml-memory.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/agent-yaml-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AgentYamlSchema } from '../project/schemas.ts';

describe('AgentYamlSchema memory budget', () => {
  it('defaults memory budget when omitted', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
    });
    expect(parsed.memory).toEqual({ maxFiles: 30, maxTotalKb: 64 });
  });

  it('accepts an explicit memory budget', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
      memory: { maxFiles: 10, maxTotalKb: 16 },
    });
    expect(parsed.memory).toEqual({ maxFiles: 10, maxTotalKb: 16 });
  });

  it('fills partial memory budget with defaults', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
      memory: { maxFiles: 5 },
    });
    expect(parsed.memory).toEqual({ maxFiles: 5, maxTotalKb: 64 });
  });

  it('rejects a non-positive maxFiles', () => {
    expect(() =>
      AgentYamlSchema.parse({
        name: 'mem-agent',
        displayName: 'Mem Agent',
        description: 'x',
        memory: { maxFiles: 0 },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/agent-yaml-memory.test.ts`
Expected: FAIL — `parsed.memory` is `undefined` (field does not exist yet).

- [ ] **Step 3: Add the schema**

In `packages/shared/src/project/schemas.ts`, add these constants near the other defaults at the top (after `const DEFAULT_MAX_TURNS = 15;`):

```ts
const DEFAULT_MEMORY_MAX_FILES = 30;
const DEFAULT_MEMORY_MAX_TOTAL_KB = 64;
```

Add the budget schema immediately above `AgentYamlSchema` (after the `BashAccessSchema` / `ValidationConfigSchema` block):

```ts
// --- Agent Memory Budget ---

export const MemoryBudgetSchema = z.object({
  maxFiles: z.number().int().positive().default(DEFAULT_MEMORY_MAX_FILES),
  maxTotalKb: z.number().int().positive().default(DEFAULT_MEMORY_MAX_TOTAL_KB),
});
```

Then add the field to `AgentYamlSchema` (after the `bash` line, before `validation`):

```ts
  memory: MemoryBudgetSchema.default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/__tests__/agent-yaml-memory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rebuild shared so core sees the new type**

Run: `npm run build -w packages/shared`
Expected: clean compile.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/project/schemas.ts packages/shared/src/__tests__/agent-yaml-memory.test.ts
```
```bash
git commit -m "feat(agents): add memory budget field to AgentYaml schema"
```

---

### Task 2: MemoryStore module (filesystem, budget, path-safety)

**Files:**
- Create: `packages/core/src/agent-memory/memory-store.ts`
- Test: `packages/core/src/__tests__/memory-store.test.ts` (new)

The store is pure filesystem logic — no MCP, no spawn. It resolves an agent's memory dir, enforces path-confinement and the per-agent budget (read from `agent.yaml`), and exposes a `formatMemoryBlock` helper for prompt injection.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/memory-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore, formatMemoryBlock } from '../agent-memory/memory-store.ts';

const AGENT = 'mem-agent';

function writeAgentYaml(projectsDir: string, body: string): void {
  mkdirSync(join(projectsDir, 'agents', AGENT), { recursive: true });
  writeFileSync(join(projectsDir, 'agents', AGENT, 'agent.yaml'), body);
}

describe('MemoryStore', () => {
  let projectsDir: string;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-mem-'));
    writeAgentYaml(
      projectsDir,
      `name: ${AGENT}\ndisplayName: Mem\ndescription: x\nmemory:\n  maxFiles: 3\n  maxTotalKb: 1\n`,
    );
    store = createMemoryStore({ projectsDir });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('writes and reads a memory file', async () => {
    await store.write(AGENT, 'fact-1.md', 'remember this');
    expect(await store.read(AGENT, 'fact-1.md')).toBe('remember this');
    expect(existsSync(join(projectsDir, 'agents', AGENT, 'memory', 'fact-1.md'))).toBe(true);
  });

  it('readIndex returns MEMORY.md contents, null when absent', async () => {
    expect(await store.readIndex(AGENT)).toBeNull();
    await store.write(AGENT, 'MEMORY.md', '# Index\n- fact-1\n');
    expect(await store.readIndex(AGENT)).toContain('# Index');
  });

  it('update requires an existing file', async () => {
    await expect(store.update(AGENT, 'ghost.md', 'x')).rejects.toThrow(/does not exist/);
    await store.write(AGENT, 'real.md', 'v1');
    const res = await store.update(AGENT, 'real.md', 'v2');
    expect(res.ok).toBe(true);
    expect(await store.read(AGENT, 'real.md')).toBe('v2');
  });

  it('rejects path escaping the memory dir', async () => {
    await expect(store.write(AGENT, '../../escape.md', 'nope')).rejects.toThrow(/invalid path/i);
    await expect(store.read(AGENT, '/etc/passwd')).rejects.toThrow(/invalid path/i);
  });

  it('enforces the maxFiles budget', async () => {
    await store.write(AGENT, 'a.md', 'a');
    await store.write(AGENT, 'b.md', 'b');
    await store.write(AGENT, 'c.md', 'c');
    const res = await store.write(AGENT, 'd.md', 'd');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/budget/i);
    expect(res.usage?.files).toBe(3);
    // overwriting an existing file is allowed even at the file cap
    const overwrite = await store.write(AGENT, 'a.md', 'a2');
    expect(overwrite.ok).toBe(true);
  });

  it('enforces the maxTotalKb budget', async () => {
    const big = 'x'.repeat(900);
    await store.write(AGENT, 'big.md', big);
    const res = await store.write(AGENT, 'big2.md', 'y'.repeat(900));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/budget/i);
    expect(res.usage?.totalBytes).toBeGreaterThan(0);
  });

  it('reports usage', async () => {
    await store.write(AGENT, 'a.md', 'hello');
    const usage = await store.usage(AGENT);
    expect(usage.files).toBe(1);
    expect(usage.totalBytes).toBe(5);
    expect(usage.maxFiles).toBe(3);
    expect(usage.maxTotalBytes).toBe(1024);
  });

  it('falls back to default budget when agent.yaml lacks one', async () => {
    writeFileSync(
      join(projectsDir, 'agents', AGENT, 'agent.yaml'),
      `name: ${AGENT}\ndisplayName: Mem\ndescription: x\n`,
    );
    const usage = await store.usage(AGENT);
    expect(usage.maxFiles).toBe(30);
    expect(usage.maxTotalBytes).toBe(64 * 1024);
  });

  it('formatMemoryBlock wraps the index with guidance', () => {
    const block = formatMemoryBlock('# Index\n- fact-1\n');
    expect(block).toContain('## Your Memory');
    expect(block).toContain('# Index');
    expect(block).toContain('memory_read');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/memory-store.test.ts`
Expected: FAIL — module `../agent-memory/memory-store.ts` does not exist.

- [ ] **Step 3: Implement the store**

Create `packages/core/src/agent-memory/memory-store.ts`:

```ts
import { readFile, writeFile, readdir, stat, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import yaml from 'js-yaml';
const { load: yamlLoad } = yaml;
import { createLogger } from '@raven/shared';

const log = createLogger('memory-store');

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_TOTAL_KB = 64;
const BYTES_PER_KB = 1024;

export interface MemoryUsage {
  files: number;
  totalBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
  usage?: MemoryUsage;
}

export interface MemoryStore {
  read(agentName: string, relPath: string): Promise<string>;
  readIndex(agentName: string): Promise<string | null>;
  write(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  update(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  usage(agentName: string): Promise<MemoryUsage>;
}

interface Budget {
  maxFiles: number;
  maxTotalBytes: number;
}

const INDEX_FILE = 'MEMORY.md';

/** Wrap a MEMORY.md index for injection into an agent's system prompt. */
export function formatMemoryBlock(index: string): string {
  return [
    '## Your Memory',
    'This is the index of what you remember from past work. Use the `memory_read` tool to',
    'read a specific file, `memory_write` to save a new note, and `memory_update` to revise',
    'an existing one. Keep entries concise — your memory has a hard budget.',
    '',
    index.trim(),
  ].join('\n');
}

export function createMemoryStore(deps: { projectsDir: string }): MemoryStore {
  const { projectsDir } = deps;

  function memoryDir(agentName: string): string {
    return join(projectsDir, 'agents', agentName, 'memory');
  }

  function resolveAgentYaml(agentName: string): string {
    const dirLayout = join(projectsDir, 'agents', agentName, 'agent.yaml');
    if (existsSync(dirLayout)) return dirLayout;
    return join(projectsDir, 'agents', `${agentName}.yaml`);
  }

  async function readBudget(agentName: string): Promise<Budget> {
    try {
      const raw = yamlLoad(await readFile(resolveAgentYaml(agentName), 'utf-8')) as {
        memory?: { maxFiles?: number; maxTotalKb?: number };
      };
      return {
        maxFiles: raw?.memory?.maxFiles ?? DEFAULT_MAX_FILES,
        maxTotalBytes: (raw?.memory?.maxTotalKb ?? DEFAULT_MAX_TOTAL_KB) * BYTES_PER_KB,
      };
    } catch {
      return { maxFiles: DEFAULT_MAX_FILES, maxTotalBytes: DEFAULT_MAX_TOTAL_KB * BYTES_PER_KB };
    }
  }

  /** Resolve a relative path strictly inside the agent's memory dir, or throw. */
  function safePath(agentName: string, relPath: string): string {
    const dir = memoryDir(agentName);
    const resolved = resolve(dir, relPath);
    const rel = relative(dir, resolved);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`invalid path: ${relPath}`);
    }
    return resolved;
  }

  async function listMemoryFiles(agentName: string): Promise<Array<{ name: string; size: number }>> {
    const dir = memoryDir(agentName);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: Array<{ name: string; size: number }> = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const s = await stat(join(dir, entry.name));
        files.push({ name: entry.name, size: s.size });
      }
    }
    return files;
  }

  async function computeUsage(agentName: string, budget: Budget): Promise<MemoryUsage> {
    const files = await listMemoryFiles(agentName);
    return {
      files: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      maxFiles: budget.maxFiles,
      maxTotalBytes: budget.maxTotalBytes,
    };
  }

  async function atomicWrite(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, absPath);
  }

  async function checkAndWrite(
    agentName: string,
    relPath: string,
    content: string,
    mustExist: boolean,
  ): Promise<MemoryWriteResult> {
    const absPath = safePath(agentName, relPath);
    const fileExists = existsSync(absPath);
    if (mustExist && !fileExists) {
      throw new Error(`memory file does not exist: ${relPath}`);
    }

    const budget = await readBudget(agentName);
    const files = await listMemoryFiles(agentName);
    const existingSize = files.find((f) => join(memoryDir(agentName), f.name) === absPath)?.size ?? 0;
    const newBytes = Buffer.byteLength(content, 'utf-8');

    const projectedFiles = fileExists ? files.length : files.length + 1;
    const projectedBytes = files.reduce((s, f) => s + f.size, 0) - existingSize + newBytes;

    const usage = await computeUsage(agentName, budget);

    if (projectedFiles > budget.maxFiles) {
      return {
        ok: false,
        error: `memory budget exceeded: ${projectedFiles} files > ${budget.maxFiles} max. Consolidate or prune first.`,
        usage,
      };
    }
    if (projectedBytes > budget.maxTotalBytes) {
      return {
        ok: false,
        error: `memory budget exceeded: ${projectedBytes} bytes > ${budget.maxTotalBytes} max. Consolidate or prune first.`,
        usage,
      };
    }

    await atomicWrite(absPath, content);
    log.info(`memory ${mustExist ? 'updated' : 'written'}: ${agentName}/${relPath}`);
    return { ok: true, usage: await computeUsage(agentName, budget) };
  }

  return {
    async read(agentName: string, relPath: string): Promise<string> {
      const absPath = safePath(agentName, relPath);
      return readFile(absPath, 'utf-8');
    },

    async readIndex(agentName: string): Promise<string | null> {
      try {
        return await readFile(join(memoryDir(agentName), INDEX_FILE), 'utf-8');
      } catch {
        return null;
      }
    },

    write(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult> {
      return checkAndWrite(agentName, relPath, content, false);
    },

    update(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult> {
      return checkAndWrite(agentName, relPath, content, true);
    },

    async usage(agentName: string): Promise<MemoryUsage> {
      return computeUsage(agentName, await readBudget(agentName));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/memory-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-memory/memory-store.ts packages/core/src/__tests__/memory-store.test.ts
```
```bash
git commit -m "feat(agents): add MemoryStore with path-safety and hard budget"
```

---

### Task 3: The `memory` in-process MCP server

**Files:**
- Create: `packages/core/src/mcp-server/memory-mcp.ts`
- Test: `packages/core/src/__tests__/memory-mcp.test.ts` (new)

A standalone SDK MCP server exposing three tools bound to one agent's directory. Mirror the import style of `packages/core/src/mcp-server/index.ts` for `tool` / `createSdkMcpServer` (both come from `@anthropic-ai/claude-agent-sdk`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/memory-mcp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore } from '../agent-memory/memory-store.ts';
import { buildMemoryTools } from '../mcp-server/memory-mcp.ts';

const AGENT = 'mem-agent';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function findTool(tools: ReturnType<typeof buildMemoryTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('memory MCP tools', () => {
  let projectsDir: string;
  let tools: ReturnType<typeof buildMemoryTools>;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-memmcp-'));
    mkdirSync(join(projectsDir, 'agents', AGENT), { recursive: true });
    writeFileSync(
      join(projectsDir, 'agents', AGENT, 'agent.yaml'),
      `name: ${AGENT}\ndisplayName: Mem\ndescription: x\nmemory:\n  maxFiles: 2\n  maxTotalKb: 1\n`,
    );
    const store = createMemoryStore({ projectsDir });
    tools = buildMemoryTools({ memoryStore: store, agentName: AGENT });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('exposes exactly the three memory tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(['memory_read', 'memory_update', 'memory_write']);
  });

  it('memory_write then memory_read round-trips', async () => {
    const write = findTool(tools, 'memory_write');
    const wrote = (await write.handler({ path: 'note.md', content: 'hi' }, {})) as ToolResult;
    expect(wrote.isError).toBeFalsy();

    const read = findTool(tools, 'memory_read');
    const got = (await read.handler({ path: 'note.md' }, {})) as ToolResult;
    expect(got.content[0].text).toContain('hi');
  });

  it('memory_write surfaces a budget rejection as an error result', async () => {
    const write = findTool(tools, 'memory_write');
    await write.handler({ path: 'a.md', content: 'a' }, {});
    await write.handler({ path: 'b.md', content: 'b' }, {});
    const third = (await write.handler({ path: 'c.md', content: 'c' }, {})) as ToolResult;
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toMatch(/budget/i);
  });

  it('memory_read rejects a path escape as an error result', async () => {
    const read = findTool(tools, 'memory_read');
    const res = (await read.handler({ path: '../../etc/passwd' }, {})) as ToolResult;
    expect(res.isError).toBe(true);
  });

  it('memory_update on a missing file returns an error result', async () => {
    const update = findTool(tools, 'memory_update');
    const res = (await update.handler({ path: 'ghost.md', content: 'x' }, {})) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/does not exist/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/memory-mcp.test.ts`
Expected: FAIL — module `../mcp-server/memory-mcp.ts` does not exist.

- [ ] **Step 3: Implement the memory MCP**

First confirm the exact import names used by the existing server:

Run: `grep -n "createSdkMcpServer\|McpSdkServerConfigWithInstance\|import { tool" packages/core/src/mcp-server/index.ts`

Then create `packages/core/src/mcp-server/memory-mcp.ts` (match whatever import path that grep shows — it is `@anthropic-ai/claude-agent-sdk`):

```ts
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { MemoryStore } from '../agent-memory/memory-store.ts';

interface OkResult {
  content: [{ type: 'text'; text: string }];
}
interface ErrResult {
  content: [{ type: 'text'; text: string }];
  isError: true;
}

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

interface MemoryToolDeps {
  memoryStore: MemoryStore;
  agentName: string;
}

/** Build the three memory tools bound to one agent's directory. */
// Return type mirrors buildSystemTools in mcp-server/tools/system.ts (same lint allowance for `any`).
export function buildMemoryTools(deps: MemoryToolDeps): Array<SdkMcpToolDefinition<any>> {
  const { memoryStore, agentName } = deps;

  const memoryRead = tool(
    'memory_read',
    'Read one of your own memory files. Omit "path" to read your MEMORY.md index.',
    {
      path: z.string().optional().describe('Memory file path relative to your memory dir'),
    },
    async (args) => {
      try {
        const content = args.path
          ? await memoryStore.read(agentName, args.path)
          : ((await memoryStore.readIndex(agentName)) ?? '');
        return okResult({ path: args.path ?? 'MEMORY.md', content });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } },
  );

  const memoryWrite = tool(
    'memory_write',
    'Save a new memory file (or overwrite an existing one). Rejected if it would exceed your memory budget.',
    {
      path: z.string().describe('Memory file path relative to your memory dir, e.g. "fact-x.md"'),
      content: z.string().describe('Full file contents'),
    },
    async (args) => {
      try {
        const res = await memoryStore.write(agentName, args.path, args.content);
        return res.ok ? okResult(res) : errorResult(`${res.error} (usage: ${JSON.stringify(res.usage)})`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  const memoryUpdate = tool(
    'memory_update',
    'Revise an existing memory file. Rejected if the file does not exist or would exceed your budget.',
    {
      path: z.string().describe('Existing memory file path relative to your memory dir'),
      content: z.string().describe('New full file contents'),
    },
    async (args) => {
      try {
        const res = await memoryStore.update(agentName, args.path, args.content);
        return res.ok ? okResult(res) : errorResult(`${res.error} (usage: ${JSON.stringify(res.usage)})`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    { annotations: { idempotentHint: true } },
  );

  return [memoryRead, memoryWrite, memoryUpdate];
}

/** Build an in-process MCP server exposing the memory tools for one agent. */
export function createMemoryMcp(deps: MemoryToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: buildMemoryTools(deps),
  });
}
```

If the grep in Step 3 shows `createRavenMcp` returns a different exported type name than `McpSdkServerConfigWithInstance`, use that exact type name instead (the function still returns the result of `createSdkMcpServer`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/memory-mcp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp-server/memory-mcp.ts packages/core/src/__tests__/memory-mcp.test.ts
```
```bash
git commit -m "feat(agents): add in-process memory MCP server (read/write/update)"
```

---

### Task 4: Wire memory into the spawn path + inject the index

**Files:**
- Modify: `packages/core/src/agent-manager/agent-session.ts` (RunOptions, attach memory MCP, inject index)
- Modify: `packages/core/src/agent-manager/agent-manager.ts` (deps + field + pass to runAgentTask)
- Modify: `packages/core/src/index.ts` (create MemoryStore, pass to AgentManager)
- Test: `packages/core/src/__tests__/memory-injection.test.ts` (new)

- [ ] **Step 1: Write the failing test (prompt injection seam)**

The full `runAgentTask` is heavy to drive in a unit test, so we test the injection seam directly: `formatMemoryBlock` is already covered in Task 2; here we assert the agent-session composes the system prompt + memory block in the documented order. Create `packages/core/src/__tests__/memory-injection.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore, formatMemoryBlock } from '../agent-memory/memory-store.ts';

const AGENT = 'mem-agent';

// Mirrors the composition agent-session performs: base prompt + memory block.
async function composePrompt(
  store: ReturnType<typeof createMemoryStore>,
  agentName: string | undefined,
  basePrompt: string,
): Promise<string> {
  if (!agentName) return basePrompt;
  const index = await store.readIndex(agentName);
  return index ? `${basePrompt}\n\n${formatMemoryBlock(index)}` : basePrompt;
}

describe('memory prompt injection', () => {
  let projectsDir: string;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-meminj-'));
    mkdirSync(join(projectsDir, 'agents', AGENT, 'memory'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'agents', AGENT, 'agent.yaml'),
      `name: ${AGENT}\ndisplayName: Mem\ndescription: x\n`,
    );
    store = createMemoryStore({ projectsDir });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('appends the memory block when an index exists', async () => {
    writeFileSync(join(projectsDir, 'agents', AGENT, 'memory', 'MEMORY.md'), '# Index\n- fact-1\n');
    const prompt = await composePrompt(store, AGENT, 'BASE');
    expect(prompt.startsWith('BASE')).toBe(true);
    expect(prompt).toContain('## Your Memory');
    expect(prompt).toContain('fact-1');
  });

  it('leaves the prompt unchanged when no index exists', async () => {
    expect(await composePrompt(store, AGENT, 'BASE')).toBe('BASE');
  });

  it('leaves the prompt unchanged when there is no agent identity', async () => {
    expect(await composePrompt(store, undefined, 'BASE')).toBe('BASE');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (it documents intended behavior)**

Run: `npx vitest run packages/core/src/__tests__/memory-injection.test.ts`
Expected: PASS (3 tests). This pins the composition contract that Step 4 implements in `agent-session.ts`.

- [ ] **Step 3: Add `memoryStore` to RunOptions and wire the spawn**

In `packages/core/src/agent-manager/agent-session.ts`:

(a) Add the import near the other type imports at the top of the file:

```ts
import type { MemoryStore } from '../agent-memory/memory-store.ts';
import { createMemoryMcp } from '../mcp-server/memory-mcp.ts';
import { formatMemoryBlock } from '../agent-memory/memory-store.ts';
```

(b) Add the field to the `RunOptions` interface (after `ravenMcpDeps?: RavenMcpDeps;`):

```ts
  memoryStore?: MemoryStore;
```

(c) In the `try` block, attach the memory MCP. Insert this immediately AFTER the existing Raven-MCP block (after the closing `}` of `if (opts.ravenMcpDeps) { ... }` at the `sdkMcpServers['raven'] = ravenMcp;` block, around line 242):

```ts
    // Add per-agent memory MCP (in-process, scoped to this agent's own dir).
    // Identity is the named agent id, which equals the agent's YAML name.
    const memoryAgentName = task.namedAgentId;
    if (opts.memoryStore && memoryAgentName) {
      sdkMcpServers['memory'] = createMemoryMcp({
        memoryStore: opts.memoryStore,
        agentName: memoryAgentName,
      });
    }
```

(The existing loop at `for (const name of Object.keys(sdkMcpServers))` then auto-adds the `mcp__memory__*` wildcard to `allowedTools` — no extra push needed.)

(d) Replace the single line `const systemPrompt = buildSystemPrompt(task);` (around line 244) with:

```ts
    let systemPrompt = buildSystemPrompt(task);
    if (opts.memoryStore && memoryAgentName) {
      const memoryIndex = await opts.memoryStore.readIndex(memoryAgentName);
      if (memoryIndex) {
        systemPrompt = `${systemPrompt}\n\n${formatMemoryBlock(memoryIndex)}`;
      }
    }
```

- [ ] **Step 4: Thread `memoryStore` through AgentManager**

In `packages/core/src/agent-manager/agent-manager.ts`:

(a) Add the import after the `RavenMcpDeps` import (line 14):

```ts
import type { MemoryStore } from '../agent-memory/memory-store.ts';
```

(b) Add to `AgentManagerDeps` (after `ravenMcpDeps?: RavenMcpDeps;`):

```ts
  memoryStore?: MemoryStore;
```

(c) Add the private field (after `private ravenMcpDeps?: RavenMcpDeps;`):

```ts
  private memoryStore?: MemoryStore;
```

(d) Assign it in the constructor (after `this.ravenMcpDeps = deps.ravenMcpDeps;`):

```ts
    this.memoryStore = deps.memoryStore;
```

(e) Pass it into `runAgentTask` (in the options object around line 200, after `ravenMcpDeps: this.ravenMcpDeps,`):

```ts
      memoryStore: this.memoryStore,
```

- [ ] **Step 5: Construct the MemoryStore in boot and inject it**

In `packages/core/src/index.ts`:

(a) Add the import near the other agent-registry / project-registry imports (e.g., after `import { createAgentYamlStore } from './project-registry/agent-yaml-store.ts';`):

```ts
import { createMemoryStore } from './agent-memory/memory-store.ts';
```

(b) Immediately before `const agentManager = new AgentManager({` (line 347), create the store:

```ts
  const memoryStore = createMemoryStore({ projectsDir });
```

(c) Add `memoryStore` to the `new AgentManager({ ... })` deps object (after `sessionManager,`):

```ts
    memoryStore,
```

- [ ] **Step 6: Build to verify the wiring type-checks**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean compile.

- [ ] **Step 7: Run the new + adjacent tests**

Run: `npx vitest run packages/core/src/__tests__/memory-injection.test.ts packages/core/src/__tests__/memory-store.test.ts packages/core/src/__tests__/memory-mcp.test.ts`
Expected: all PASS.

Run: `npx vitest run packages/core/src/__tests__/agent-manager.test.ts`
Expected: PASS (no regression from the new optional dep).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/agent-manager/agent-session.ts packages/core/src/agent-manager/agent-manager.ts packages/core/src/index.ts packages/core/src/__tests__/memory-injection.test.ts
```
```bash
git commit -m "feat(agents): attach per-agent memory MCP and inject memory index at spawn"
```

---

### Task 5: Full verification

- [ ] **Step 1: Seed a memory index for the default agent (manual smoke fixture)**

Create `projects/agents/raven/memory/MEMORY.md` so the default agent has something to inject:

```bash
mkdir -p projects/agents/raven/memory
```

Write `projects/agents/raven/memory/MEMORY.md`:

```markdown
# Raven Memory Index

- (no memories yet)
```

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: same pre-existing failure set as before this plan (knowledge-*, config-history, template-integration, template-scheduler) — zero NEW failures. All memory tests green.

- [ ] **Step 3: Lint/format gate**

Run: `npm run check`
If Prettier flags new files: `npm run format`, then re-run `npm run check`. Compare ESLint errors to the master baseline — the changed/new files must contribute zero new errors (the pre-existing `packages/web` errors are not ours).

- [ ] **Step 4: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 5: Boot smoke test**

Run: `RAVEN_PORT=4001 timeout 20 node packages/core/dist/index.js 2>&1 | head -40`
Expected: boots cleanly, "Named agent registry initialized" appears, no crash. (TickTick/Telegram MCP warnings without env are normal.)

- [ ] **Step 6: Commit the smoke fixture and push**

```bash
git add projects/agents/raven/memory/MEMORY.md
```
```bash
git commit -m "chore(agents): seed empty memory index for default agent"
```
```bash
git push
```

---

## Follow-up plans (NOT in this plan)

- **Layer 2 — knowledge-researcher delegation (§4):** create `projects/agents/knowledge-researcher/agent.yaml` as the sole carrier of the knowledge MCP; auto-append it to every agent's roster (`agentDefinitions`) in `agent-resolver.ts`; add prompt guidance to delegate recall/promotion. Independent of Layer 1.
- **Dreaming — idle-time consolidation (§4):** needs a new building block (an "activity since timestamp" query over sessions/messages/tasks, which does not exist yet), a `agent_dream_state` table, a `dream-scheduler` service (single nightly croner tick iterating agents, skip when active or no new activity), an `origin: 'dream'` marker on `AgentTask`/`AgentTaskRequestEvent`, and a dream prompt that runs the agent with only its memory tools. Depends on Layer 1.
```
