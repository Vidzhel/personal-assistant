import { describe, expect, it, vi } from 'vitest';
import type * as Shared from '@raven/shared';
import { gitAutoCommit } from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import { createConfigCommitter } from '../agent-registry/config-committer.ts';

vi.mock('@raven/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  gitAutoCommit: vi.fn(),
}));

describe('agent definition Git commits', () => {
  it('owns rename paths and drains an admitted commit before stop', async () => {
    let release!: () => void;
    vi.mocked(gitAutoCommit)
      .mockReset()
      .mockImplementation(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
    const eventBus = new EventBus();
    const committer = createConfigCommitter({ eventBus, cwd: '/tmp/config-commit-fixture' });
    committer.start();
    committer.start();
    const event = {
      id: 'rename',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:config:updated' as const,
      payload: {
        agentId: 'alpha::new',
        name: 'new',
        changes: ['name'],
        filePaths: ['alpha/agents/old/agent.yaml', 'alpha/agents/new/agent.yaml'],
      },
    };
    eventBus.emit(event);
    expect(gitAutoCommit).toHaveBeenCalledExactlyOnceWith(
      event.payload.filePaths,
      'chore: update agent config — new',
      '/tmp/config-commit-fixture',
    );
    let stopped = false;
    const pending = committer.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    eventBus.emit(event);
    expect(gitAutoCommit).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(stopped).toBe(true);
    committer.start();
    vi.mocked(gitAutoCommit).mockResolvedValue(undefined);
    eventBus.emit(event);
    await committer.stop();
    expect(gitAutoCommit).toHaveBeenCalledTimes(2);
  });
});
