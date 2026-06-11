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
