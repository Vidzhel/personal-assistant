import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AgentMemoryFile } from '../lib/api-client';
import { useAgentStore } from '../stores/agent-store';

vi.mock('../lib/api-client', () => ({ api: { getProjectMemory: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('project memory selection', () => {
  beforeEach(() => {
    useAgentStore.getState().closeMemoryPanel();
    useAgentStore.setState({ agents: [] });
    vi.mocked(api.getProjectMemory).mockReset();
  });

  it('requires an explicit project for a global agent', async () => {
    await useAgentStore.getState().showMemoryPanel('raven');
    expect(useAgentStore.getState().memoryProjectId).toBeNull();
    expect(api.getProjectMemory).not.toHaveBeenCalled();
  });

  it('ignores an older response after switching projects', async () => {
    const first = deferred<AgentMemoryFile[]>();
    vi.mocked(api.getProjectMemory)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ file: 'new.md', content: 'Project B' }]);
    const pending = useAgentStore.getState().selectMemoryProject('project-a');
    await useAgentStore.getState().selectMemoryProject('project-b');
    first.resolve([{ file: 'old.md', content: 'Project A' }]);
    await pending;
    expect(useAgentStore.getState()).toMatchObject({
      memoryProjectId: 'project-b',
      memoryLoading: false,
      selectedAgentMemory: [{ file: 'new.md', content: 'Project B' }],
    });
  });

  it('does not repopulate a closed panel from a pending response', async () => {
    const first = deferred<AgentMemoryFile[]>();
    vi.mocked(api.getProjectMemory).mockReturnValueOnce(first.promise);
    const pending = useAgentStore.getState().selectMemoryProject('project-a');
    useAgentStore.getState().closeMemoryPanel();
    first.resolve([{ file: 'old.md', content: 'Project A' }]);
    await pending;
    expect(useAgentStore.getState().selectedAgentMemory).toEqual([]);
  });

  it('surfaces an unavailable project without reporting empty healthy memory', async () => {
    vi.mocked(api.getProjectMemory).mockRejectedValueOnce(new Error('Project unavailable'));
    await useAgentStore.getState().selectMemoryProject('missing');
    expect(useAgentStore.getState()).toMatchObject({
      selectedAgentMemoryError: 'Project unavailable',
      memoryLoading: false,
    });
  });
});
