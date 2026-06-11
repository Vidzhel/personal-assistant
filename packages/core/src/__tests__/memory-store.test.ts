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

// suppress unused import warning — readFileSync is imported in the original spec
void readFileSync;
