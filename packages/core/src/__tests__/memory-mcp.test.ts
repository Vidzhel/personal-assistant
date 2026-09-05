import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectMemoryFixture } from './fixtures/project-memory.ts';
import { buildMemoryTools } from '../mcp-server/memory-mcp.ts';

const PROJECT = 'memory-project';

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

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-memmcp-'));
    const { memoryStore, workspaceStore } = await createProjectMemoryFixture(projectsDir, [
      PROJECT,
    ]);
    await workspaceStore.updateWorkspace(PROJECT, { memory: { maxFiles: 2, maxTotalKb: 1 } });
    tools = buildMemoryTools({ memoryStore, projectId: PROJECT });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('exposes exactly the three memory tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory_read',
      'memory_update',
      'memory_write',
    ]);
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

  it('memory_update surfaces a budget rejection as an error result', async () => {
    const write = findTool(tools, 'memory_write');
    // Fill up most of the 1 KB budget with a different file
    await write.handler({ path: 'other.md', content: 'x'.repeat(900) }, {});
    // Write a small existing file
    await write.handler({ path: 'existing.md', content: 'tiny' }, {});
    // Update existing.md with large content that would exceed total budget
    const update = findTool(tools, 'memory_update');
    const res = (await update.handler(
      { path: 'existing.md', content: 'y'.repeat(900) },
      {},
    )) as ToolResult;
    // projected: 900 (other.md) + 900 (new content) = 1800 > 1024 limit
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/budget/i);
  });

  it('memory_update on a missing file returns an error result', async () => {
    const update = findTool(tools, 'memory_update');
    const res = (await update.handler({ path: 'ghost.md', content: 'x' }, {})) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/does not exist/);
  });
});
