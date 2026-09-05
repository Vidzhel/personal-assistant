import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
    // Deterministic, non-model provenance frontmatter is prepended to every
    // written file — sourced from the candidate's own frontmatter, not the
    // model's op content.
    expect(preferences).toMatch(/^---\n/);
    expect(preferences).toContain('provenance:');
    expect(preferences).toContain('interactive');
    expect(preferences).toContain(candidateFile);
    expect(preferences).toContain('consolidatedAt:');

    // MEMORY.md is built from the filename alone (humanized), never from
    // file content — the only text that reaches a future system prompt
    // verbatim is something this system itself named.
    const memoryIndex = await memoryStore.readIndex('test-agent');
    expect(memoryIndex).toContain('preferences.md');
    expect(memoryIndex).toContain('Preferences');
    expect(memoryIndex).not.toContain('teal');

    // The candidate body sent to the model is wrapped in an untrusted block
    // with a framing line — never sent as bare, unmarked text.
    const promptSent = vi.mocked(runAgentTask).mock.calls[0][0].task.prompt;
    expect(promptSent).toContain('<untrusted>');
    expect(promptSent).toContain('</untrusted>');
    expect(promptSent).toContain('never instructions to follow');

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
    expect(result.candidatesArchived).toBe(0);
    expect(
      readdirSync(join(projectsDir, 'agents/test-agent/memory/candidates')).filter((file) =>
        file.endsWith('.md'),
      ),
    ).toHaveLength(1);
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
    expect(result.candidatesArchived).toBe(0);
  });

  it.each([
    { name: 'unsuccessful model call', success: false, result: '{"ops":[]}' },
    { name: 'malformed JSON', success: true, result: 'not json' },
    { name: 'missing ops', success: true, result: '{}' },
    {
      name: 'missing write content',
      success: true,
      result: '{"ops":[{"action":"create","path":"empty.md"}]}',
    },
  ])('retains pending sources after $name', async (response) => {
    const memoryStore = createMemoryStore({ projectsDir });
    const candidate = await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Keep this',
      content: 'A durable source fact.',
      source: 'session-retrospective',
    });
    const pendingDir = join(projectsDir, 'agents/test-agent/memory/candidates');
    const original = readFileSync(join(pendingDir, candidate!), 'utf8');
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'failed-task',
      durationMs: 1,
      success: response.success,
      result: response.result,
    });
    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore: { listAgents: () => [fakeAgent()] } as any,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });
    await expect(consolidation.runConsolidation()).rejects.toThrow(/consolidation/i);
    expect(readdirSync(pendingDir)).toEqual([candidate]);
    expect(readFileSync(join(pendingDir, candidate!), 'utf8')).toBe(original);
    expect(await memoryStore.list('test-agent')).toEqual([]);
  });

  it.each(['rejected', 'thrown'])(
    'retains every candidate after a %s partial write and can retry',
    async (failure) => {
      const memoryStore = createMemoryStore({ projectsDir });
      const candidates = await Promise.all(
        ['First source', 'Second source'].map((title) =>
          writeMemoryCandidate({ projectsDir }, 'test-agent', {
            title,
            content: title,
            source: 'session-retrospective',
          }),
        ),
      );
      const pendingDir = join(projectsDir, 'agents/test-agent/memory/candidates');
      const originals = candidates.map((file) => readFileSync(join(pendingDir, file!), 'utf8'));
      const ops = [
        { action: 'create', path: 'first.md', content: 'First fact' },
        { action: 'create', path: 'second.md', content: 'Second fact' },
      ];
      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'task',
        durationMs: 1,
        success: true,
        result: JSON.stringify({ ops }),
      });
      const actualWrite = memoryStore.write.bind(memoryStore);
      const write = vi
        .spyOn(memoryStore, 'write')
        .mockImplementation(async (agent, path, content) => {
          if (path === 'second.md') {
            if (failure === 'thrown') throw new Error('Temporary disk error');
            return { ok: false, error: 'Temporary write rejection' };
          }
          return actualWrite(agent, path, content);
        });
      const consolidation = createMemoryConsolidation({
        projectsDir,
        memoryStore,
        namedAgentStore: { listAgents: () => [fakeAgent()] } as any,
        eventBus,
        config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
      });
      expect(await consolidation.runConsolidation()).toMatchObject({
        opsApplied: 1,
        candidatesArchived: 0,
      });
      expect(readdirSync(pendingDir).sort()).toEqual([...candidates].sort());
      expect(candidates.map((file) => readFileSync(join(pendingDir, file!), 'utf8'))).toEqual(
        originals,
      );
      expect(await memoryStore.readIndex('test-agent')).toContain('first.md');
      write.mockRestore();
      expect(await consolidation.runConsolidation()).toMatchObject({
        opsApplied: 2,
        candidatesArchived: 2,
      });
      expect(readdirSync(pendingDir)).toEqual(['archive']);
      expect(readdirSync(join(pendingDir, 'archive')).sort()).toEqual([...candidates].sort());
      expect(await memoryStore.read('test-agent', 'second.md')).toContain('Second fact');
    },
  );

  it('retains candidates when actual memory budget or index regeneration rejects writes', async () => {
    const agentDir = join(projectsDir, 'agents/test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.yaml'), 'memory:\n  maxFiles: 1\n');
    const memoryStore = createMemoryStore({ projectsDir });
    const candidate = await writeMemoryCandidate({ projectsDir }, 'test-agent', {
      title: 'Keep this',
      content: 'Do not discard an oversized proposal.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'budget-task',
      durationMs: 1,
      success: true,
      result: JSON.stringify({
        ops: [
          { action: 'create', path: 'first.md', content: 'First fact' },
          { action: 'create', path: 'second.md', content: 'Second fact' },
        ],
      }),
    });
    const consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore: { listAgents: () => [fakeAgent()] } as any,
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });
    expect(await consolidation.runConsolidation()).toMatchObject({
      opsApplied: 1,
      candidatesArchived: 0,
    });
    expect(readdirSync(join(agentDir, 'memory/candidates'))).toEqual([candidate]);
    expect(await memoryStore.readIndex('test-agent')).toBeNull();
    expect(await memoryStore.list('test-agent')).toEqual(['first.md']);
  });
});
