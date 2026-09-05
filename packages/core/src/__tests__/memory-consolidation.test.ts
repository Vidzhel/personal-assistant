import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus/event-bus.ts';
import { createMemoryStore } from '../agent-memory/memory-store.ts';
import { writeMemoryCandidate, listPendingCandidates } from '../agent-memory/memory-candidates.ts';
import type { NamedAgent } from '@raven/shared';

vi.mock('../agent-manager/agent-session.ts', () => ({ runAgentTask: vi.fn() }));
const { runAgentTask } = await import('../agent-manager/agent-session.ts');
const { createMemoryConsolidation } = await import('../agent-memory/memory-consolidation.ts');

function fakeAgent(overrides: Partial<NamedAgent> = {}): NamedAgent {
  return {
    id: 'default',
    name: 'default',
    description: null,
    instructions: null,
    skills: [],
    model: null,
    maxTurns: null,
    isDefault: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('project-owned memory consolidation', () => {
  let root: string;
  let projectsDir: string;
  let homes: Record<string, string>;
  let workspaceStore: any;
  let eventBus: EventBus;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-consolidation-'));
    projectsDir = join(root, 'projects');
    homes = {
      'project-a': join(projectsDir, 'project-a'),
      'project-b': join(projectsDir, 'project-b'),
    };
    workspaceStore = {
      listProjectIds: () => Object.keys(homes),
      getProjectHome: (id: string) => homes[id],
      getWorkspace: () => ({}),
    };
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function store() {
    return createMemoryStore({ projectsDir, workspaceStore });
  }

  function makeConsolidation(memoryStore = store()) {
    return createMemoryConsolidation({
      memoryStore,
      workspaceStore,
      namedAgentStore: {
        getDefaultAgent: (projectId?: string) => fakeAgent({ id: projectId ?? 'default' }),
      },
      eventBus,
      config: { CLAUDE_MODEL: 'claude-sonnet-4-6' } as any,
    });
  }

  it('processes each project independently and archives only successful candidates', async () => {
    const memoryStore = store();
    const first = await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Same title',
      content: 'A private preference.',
      source: 'session-retrospective',
      sessionId: 'a',
    });
    const second = await writeMemoryCandidate({ memoryStore }, 'project-b', {
      title: 'Same title',
      content: 'A different preference.',
      source: 'session-retrospective',
      sessionId: 'b',
    });
    expect(first).not.toBe(second);

    vi.mocked(runAgentTask)
      .mockResolvedValueOnce({
        taskId: 'a',
        result: JSON.stringify({ ops: [{ action: 'create', path: 'facts/a.md', content: 'A' }] }),
        success: true,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        taskId: 'b',
        result: JSON.stringify({ ops: [{ action: 'create', path: 'facts/b.md', content: 'B' }] }),
        success: true,
        durationMs: 1,
      });

    const result = await makeConsolidation(memoryStore).runConsolidation();
    expect(result).toEqual({ projectsProcessed: 2, opsApplied: 2, candidatesArchived: 2 });
    expect(runAgentTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ task: expect.objectContaining({ projectId: 'project-a' }) }),
    );
    expect(runAgentTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ task: expect.objectContaining({ projectId: 'project-b' }) }),
    );
    expect(await listPendingCandidates(memoryStore, 'project-a')).toEqual([]);
    expect(await listPendingCandidates(memoryStore, 'project-b')).toEqual([]);
    expect(readFileSync(join(homes['project-a'], 'memory/facts/a.md'), 'utf8')).toContain('A');
    expect(readFileSync(join(homes['project-b'], 'memory/facts/b.md'), 'utf8')).toContain('B');
    expect(readdirSync(join(homes['project-a'], 'memory/candidates/archive'))).toContain(first);
  });

  it('keeps candidates pending when the model response is invalid', async () => {
    const memoryStore = store();
    const filename = await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Retry me',
      content: 'Durable fact.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'bad',
      result: 'not json',
      success: true,
      durationMs: 1,
    });
    await expect(makeConsolidation(memoryStore).runConsolidation()).rejects.toThrow(
      'Invalid memory consolidation',
    );
    expect((await listPendingCandidates(memoryStore, 'project-a')).map((c) => c.filename)).toEqual([
      filename,
    ]);
  });

  it('keeps candidates pending after a partial operation failure', async () => {
    const memoryStore = store();
    await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Partial',
      content: 'Keep source.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'partial',
      result: JSON.stringify({
        ops: [
          { action: 'create', path: 'first.md', content: 'first' },
          { action: 'create', path: '../unsafe.md', content: 'must reject' },
        ],
      }),
      success: true,
      durationMs: 1,
    });
    await expect(makeConsolidation(memoryStore).runConsolidation()).rejects.toThrow(
      'Memory consolidation incomplete',
    );
    expect(await listPendingCandidates(memoryStore, 'project-a')).toHaveLength(1);
  });

  it('does not apply model operations when a candidate changes during the model call', async () => {
    const memoryStore = store();
    const filename = await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Changed while waiting',
      content: 'Original source.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockImplementationOnce(async () => {
      const candidatePath = join(homes['project-a'], 'memory/candidates', filename!);
      const current = readFileSync(candidatePath, 'utf8');
      writeFileSync(candidatePath, `${current}\nExternal edit\n`);
      return {
        taskId: 'changed',
        result: JSON.stringify({ ops: [{ action: 'create', path: 'stale.md', content: 'stale' }] }),
        success: true,
        durationMs: 1,
      };
    });
    await expect(makeConsolidation(memoryStore).runConsolidation()).rejects.toThrow(
      'Memory consolidation incomplete',
    );
    expect(
      readFileSync(join(homes['project-a'], 'memory/candidates', filename!), 'utf8'),
    ).toContain('External edit');
    expect(
      readFileSync(join(homes['project-a'], 'memory/candidates', filename!), 'utf8'),
    ).not.toContain('stale.md');
  });

  it('rejects a stale update when a memory note changes during the model call', async () => {
    const memoryStore = store();
    await memoryStore.write('project-a', 'facts/current.md', 'Original');
    await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Update note',
      content: 'New fact.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockImplementationOnce(async () => {
      writeFileSync(join(homes['project-a'], 'memory/facts/current.md'), 'External edit');
      return {
        taskId: 'stale-note',
        result: JSON.stringify({
          ops: [{ action: 'update', path: 'facts/current.md', content: 'Model edit' }],
        }),
        success: true,
        durationMs: 1,
      };
    });
    await expect(makeConsolidation(memoryStore).runConsolidation()).rejects.toThrow(
      'Memory consolidation',
    );
    expect(readFileSync(join(homes['project-a'], 'memory/facts/current.md'), 'utf8')).toBe(
      'External edit',
    );
    expect(await listPendingCandidates(memoryStore, 'project-a')).toHaveLength(1);
  });

  it('passes the project agent model tier and max turns to dispatch', async () => {
    const memoryStore = store();
    await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Scoped model',
      content: 'Local setting.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'scoped',
      result: JSON.stringify({ ops: [] }),
      success: true,
      durationMs: 1,
    });
    const consolidation = createMemoryConsolidation({
      memoryStore,
      workspaceStore,
      namedAgentStore: {
        getDefaultAgent: () => fakeAgent({ model: 'sonnet', maxTurns: 7 }),
      },
      eventBus,
      config: { CLAUDE_MODEL: 'global-model', RAVEN_AGENT_MAX_TURNS: 25 } as any,
    });
    await consolidation.runConsolidation();
    expect(runAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5', maxTurns: 7 }),
    );
  });

  it('preserves an index edited while the model was running', async () => {
    const memoryStore = store();
    await memoryStore.write('project-a', 'MEMORY.md', '# Original index\n');
    await writeMemoryCandidate({ memoryStore }, 'project-a', {
      title: 'Index race',
      content: 'Keep candidate.',
      source: 'session-retrospective',
    });
    vi.mocked(runAgentTask).mockImplementationOnce(async () => {
      writeFileSync(join(homes['project-a'], 'memory/MEMORY.md'), '# External index edit\n');
      return {
        taskId: 'index-race',
        result: JSON.stringify({ ops: [] }),
        success: true,
        durationMs: 1,
      };
    });
    await expect(makeConsolidation(memoryStore).runConsolidation()).rejects.toThrow(
      'Memory file changed during update',
    );
    expect(readFileSync(join(homes['project-a'], 'memory/MEMORY.md'), 'utf8')).toBe(
      '# External index edit\n',
    );
    expect(await listPendingCandidates(memoryStore, 'project-a')).toHaveLength(1);
  });
});
