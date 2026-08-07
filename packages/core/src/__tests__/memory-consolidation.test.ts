import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus/event-bus.ts';
import { createMemoryStore } from '../agent-memory/memory-store.ts';
import { writeMemoryCandidate } from '../agent-memory/memory-candidates.ts';
import type { NamedAgent } from '@raven/shared';

// Mock runAgentTask — the scripted "fake agent backend" the plan calls for.
// The consolidation module imports it directly (not via an injected
// backend), so it's mocked at the module level like session-retrospective's
// own test suite does for the same function.
vi.mock('../agent-manager/agent-session.ts', () => ({
  runAgentTask: vi.fn(),
}));

const { runAgentTask } = await import('../agent-manager/agent-session.ts');
const { createMemoryConsolidation } = await import('../agent-memory/memory-consolidation.ts');

function fakeAgent(overrides: Partial<NamedAgent> = {}): NamedAgent {
  return {
    id: 'test-agent',
    name: 'test-agent',
    description: null,
    instructions: null,
    skills: [],
    model: null,
    maxTurns: null,
    isDefault: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('createMemoryConsolidation', () => {
  let tmpDir: string;
  let projectsDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-consolidation-'));
    projectsDir = join(tmpDir, 'projects');
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips agents with no pending candidates (no model call, no ops)', async () => {
    const memoryStore = createMemoryStore({ projectsDir });
    const namedAgentStore = { listAgents: () => [fakeAgent()] } as any;

    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });

    const result = await consolidation.runConsolidation();

    expect(result).toEqual({ agentsProcessed: 0, opsApplied: 0, candidatesArchived: 0 });
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('applies scripted ops, regenerates MEMORY.md, and archives the candidate', async () => {
    const memoryStore = createMemoryStore({ projectsDir });
    const namedAgentStore = { listAgents: () => [fakeAgent()] } as any;

    const candidateFile = await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Favorite color',
      content: "The owner's favorite color is teal.",
      source: 'session-retrospective',
      sessionId: 'sess-1',
    });

    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: JSON.stringify({
        ops: [
          {
            action: 'create',
            path: 'preferences.md',
            content: "# Preferences\n\nThe owner's favorite color is teal.",
          },
        ],
      }),
      durationMs: 10,
      success: true,
    });

    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });

    const result = await consolidation.runConsolidation();

    expect(result).toEqual({ agentsProcessed: 1, opsApplied: 1, candidatesArchived: 1 });
    expect(runAgentTask).toHaveBeenCalledTimes(1);
    // Named agent's model is unset ('sonnet' tier) -> falls through to the
    // global config default, not a hardcoded second sonnet id.
    expect(vi.mocked(runAgentTask).mock.calls[0][0].model).toBe('claude-sonnet-4-6');

    const preferences = readFileSync(
      join(projectsDir, 'agents', 'test-agent', 'memory', 'preferences.md'),
      'utf-8',
    );
    expect(preferences).toContain('teal');

    const memoryIndex = await memoryStore.readIndex('test-agent');
    expect(memoryIndex).toContain('preferences.md');

    // Candidate consumed — moved out of the pending dir.
    const pendingDir = join(projectsDir, 'agents', 'test-agent', 'memory', 'candidates');
    const pendingFiles = readdirSync(pendingDir).filter((f) => f.endsWith('.md'));
    expect(pendingFiles).toEqual([]);
    const archived = readdirSync(join(pendingDir, 'archive'));
    expect(archived).toContain(candidateFile);
  });

  it('resolves a haiku-tier agent model to a concrete model id', async () => {
    const memoryStore = createMemoryStore({ projectsDir });
    const namedAgentStore = { listAgents: () => [fakeAgent({ model: 'haiku' })] } as any;

    await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Something',
      content: 'Some durable fact.',
      source: 'session-retrospective',
    });

    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: JSON.stringify({ ops: [] }),
      durationMs: 5,
      success: true,
    });

    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });

    await consolidation.runConsolidation();

    expect(vi.mocked(runAgentTask).mock.calls[0][0].model).toBe('claude-haiku-4-5');
  });

  it('caps applied ops at the deterministic guard even if the model proposes more', async () => {
    const memoryStore = createMemoryStore({ projectsDir });
    const namedAgentStore = { listAgents: () => [fakeAgent()] } as any;

    await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Bulk',
      content: 'Bulk candidate.',
      source: 'session-retrospective',
    });

    const EXCESSIVE_OP_COUNT = 15;
    const ops = Array.from({ length: EXCESSIVE_OP_COUNT }, (_, i) => ({
      action: 'create' as const,
      path: `file-${i}.md`,
      content: `content ${i}`,
    }));

    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: JSON.stringify({ ops }),
      durationMs: 5,
      success: true,
    });

    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });

    const result = await consolidation.runConsolidation();

    // MAX_CONSOLIDATION_OPS in memory-consolidation.ts is 10 — asserted by
    // value here rather than importing the internal constant.
    expect(result.opsApplied).toBe(10);
  });

  it('skips an op that targets MEMORY.md directly (regenerated separately)', async () => {
    const memoryStore = createMemoryStore({ projectsDir });
    const namedAgentStore = { listAgents: () => [fakeAgent()] } as any;

    await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Sneaky',
      content: 'Tries to overwrite the index.',
      source: 'session-retrospective',
    });

    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'mock-task',
      result: JSON.stringify({
        ops: [{ action: 'update', path: 'MEMORY.md', content: 'hijacked' }],
      }),
      durationMs: 5,
      success: true,
    });

    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });

    const result = await consolidation.runConsolidation();

    expect(result.opsApplied).toBe(0);
    const memoryIndex = await memoryStore.readIndex('test-agent');
    expect(memoryIndex).not.toContain('hijacked');
  });
});
