import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { gitAutoCommit } from '../utils/git-commit.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFile = execFile as any;

function simulateSuccess(): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  );
}

function simulateError(message: string, code?: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err: NodeJS.ErrnoException = new Error(message);
      if (code) err.code = code;
      cb(err, '', '');
    },
  );
}

describe('gitAutoCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs git add then git commit on success', async () => {
    simulateSuccess();

    await gitAutoCommit(['/tmp/test.yaml'], 'chore: update pipeline');

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '/tmp/test.yaml'],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'chore: update pipeline'],
      expect.any(Function),
    );
  });

  it('handles multiple file paths in git add', async () => {
    simulateSuccess();

    await gitAutoCommit(['/tmp/a.yaml', '/tmp/b.yaml'], 'chore: update');

    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '/tmp/a.yaml', '/tmp/b.yaml'],
      expect.any(Function),
    );
  });

  it('does not throw when git is not available (ENOENT)', async () => {
    simulateError('spawn git ENOENT', 'ENOENT');

    await expect(gitAutoCommit(['/tmp/test.yaml'], 'msg')).resolves.toBeUndefined();
  });

  it('does not throw when nothing to commit', async () => {
    // git add succeeds, git commit fails with "nothing to commit"
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          cb(null, '', '');
        } else {
          const err = new Error('nothing to commit, working tree clean');
          cb(err, '', '');
        }
      },
    );

    await expect(gitAutoCommit(['/tmp/test.yaml'], 'msg')).resolves.toBeUndefined();
  });

  it('does not throw on other git errors', async () => {
    simulateError('fatal: not a git repository');

    await expect(gitAutoCommit(['/tmp/test.yaml'], 'msg')).resolves.toBeUndefined();
  });
});
