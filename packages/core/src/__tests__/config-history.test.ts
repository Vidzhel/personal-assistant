import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus } from '../event-bus/event-bus.ts';

// Mock execFile before importing the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

// Dynamic import after mocks are set up
const { execFile } = await import('node:child_process');
const mockedExecFile = vi.mocked(execFile);

const { getConfigCommits, getCommitDetail, revertConfigFile } =
  await import('../config-history/git-history.ts');

function mockExecResult(stdout: string): { stdout: string; stderr: string } {
  return { stdout, stderr: '' };
}

function createMockEventBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  } as unknown as EventBus;
}

describe('getConfigCommits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed commits from git log', async () => {
    const logOutput = [
      'abc1234|2026-03-20T10:00:00+00:00|Alice|update permissions',
      'def5678|2026-03-19T09:00:00+00:00|Bob|add pipeline config',
    ].join('\n');

    mockedExecFile
      .mockResolvedValueOnce(mockExecResult(logOutput) as any)
      .mockResolvedValueOnce(mockExecResult('config/permissions.json\n') as any)
      .mockResolvedValueOnce(mockExecResult('config/pipelines/daily.yaml\n') as any);

    const commits = await getConfigCommits(20, 0);
    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe('abc1234');
    expect(commits[0].message).toBe('update permissions');
    expect(commits[0].author).toBe('Alice');
    expect(commits[0].files).toEqual(['config/permissions.json']);
    expect(commits[1].hash).toBe('def5678');
    expect(commits[1].files).toEqual(['config/pipelines/daily.yaml']);
  });

  it('returns empty array when no commits found', async () => {
    mockedExecFile.mockResolvedValueOnce(mockExecResult('') as any);
    const commits = await getConfigCommits(20, 0);
    expect(commits).toEqual([]);
  });

  it('returns empty array on git error', async () => {
    mockedExecFile.mockRejectedValueOnce(new Error('git not found'));
    const commits = await getConfigCommits(20, 0);
    expect(commits).toEqual([]);
  });
});

describe('getCommitDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns commit detail with diffs', async () => {
    const logOutput = 'abc1234|2026-03-20T10:00:00+00:00|Alice|update permissions';
    const filesOutput = 'config/permissions.json';
    const diffOutput = [
      'commit abc1234',
      'diff --git a/config/permissions.json b/config/permissions.json',
      '--- a/config/permissions.json',
      '+++ b/config/permissions.json',
      '@@ -1,3 +1,3 @@',
      '-old line',
      '+new line',
    ].join('\n');

    mockedExecFile
      .mockResolvedValueOnce(mockExecResult(logOutput) as any)
      .mockResolvedValueOnce(mockExecResult(filesOutput) as any)
      .mockResolvedValueOnce(mockExecResult(diffOutput) as any);

    const detail = await getCommitDetail('abc1234');
    expect(detail.hash).toBe('abc1234');
    expect(detail.author).toBe('Alice');
    expect(detail.files).toEqual(['config/permissions.json']);
    expect(detail.diffs).toHaveLength(1);
    expect(detail.diffs[0].file).toBe('config/permissions.json');
    expect(detail.diffs[0].diff).toContain('+new line');
  });

  it('rejects invalid SHA', async () => {
    await expect(getCommitDetail('not-a-sha!')).rejects.toThrow('Invalid git SHA');
  });

  it('throws when commit not found', async () => {
    mockedExecFile.mockResolvedValueOnce(mockExecResult('') as any);
    await expect(getCommitDetail('abc1234')).rejects.toThrow('Commit not found');
  });
});

describe('revertConfigFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts entire commit and emits events', async () => {
    const eventBus = createMockEventBus();

    // git revert
    mockedExecFile.mockResolvedValueOnce(mockExecResult('') as any);
    // git diff-tree for files
    mockedExecFile.mockResolvedValueOnce(mockExecResult('config/permissions.json\n') as any);
    // git rev-parse HEAD
    mockedExecFile.mockResolvedValueOnce(mockExecResult('newreverthash123\n') as any);

    const result = await revertConfigFile('abc1234abcdef1234567', eventBus);
    expect(result.success).toBe(true);
    expect(result.revertHash).toBe('newreverthash123');
    expect(result.reloadedConfigs).toContain('config/permissions.json');

    // Should emit config:reloaded and config:version:reverted events
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(eventBus.emit).mock.calls;
    expect(calls[0][0]).toMatchObject({ type: 'config:reloaded' });
    expect(calls[1][0]).toMatchObject({ type: 'config:version:reverted' });
  });

  it('rejects invalid SHA', async () => {
    const eventBus = createMockEventBus();
    const result = await revertConfigFile('not-valid!', eventBus);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid git SHA');
  });

  it('rejects path traversal in filePath', async () => {
    const eventBus = createMockEventBus();
    const result = await revertConfigFile('abc1234', eventBus, '../etc/passwd');
    expect(result.success).toBe(false);
    expect(result.message).toContain('File path must start with config/');
  });

  it('rejects filePath not in config/', async () => {
    const eventBus = createMockEventBus();
    const result = await revertConfigFile('abc1234', eventBus, 'src/index.ts');
    expect(result.success).toBe(false);
    expect(result.message).toContain('File path must start with config/');
  });

  it('returns failure on git error', async () => {
    const eventBus = createMockEventBus();
    mockedExecFile.mockRejectedValueOnce(new Error('merge conflict'));

    const result = await revertConfigFile('abc1234', eventBus);
    expect(result.success).toBe(false);
    expect(result.message).toContain('merge conflict');
  });
});

// --- API route integration tests (Task 6.3) ---

const { default: Fastify } = await import('fastify');
const { registerConfigHistoryRoutes } = await import('../api/routes/config-history.ts');

describe('Config History API routes', () => {
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    app = Fastify({ logger: false });
    registerConfigHistoryRoutes(app, { eventBus });
    await app.ready();
  });

  it('GET /api/config-history returns paginated commits', async () => {
    const logOutput = 'abc1234|2026-03-20T10:00:00+00:00|Alice|update permissions';
    mockedExecFile
      .mockResolvedValueOnce(mockExecResult(logOutput) as any)
      .mockResolvedValueOnce(mockExecResult('config/permissions.json\n') as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/config-history?limit=10&offset=0',
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.commits).toHaveLength(1);
    expect(data.commits[0].hash).toBe('abc1234');
    expect(data.limit).toBe(10);
    expect(data.offset).toBe(0);
  });

  it('GET /api/config-history/:hash returns commit detail', async () => {
    const logOutput = 'abc1234|2026-03-20T10:00:00+00:00|Alice|update permissions';
    const diffOutput = 'diff --git a/config/permissions.json b/config/permissions.json\n-old\n+new';

    mockedExecFile
      .mockResolvedValueOnce(mockExecResult(logOutput) as any)
      .mockResolvedValueOnce(mockExecResult('config/permissions.json') as any)
      .mockResolvedValueOnce(mockExecResult(diffOutput) as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/config-history/abc1234',
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.hash).toBe('abc1234');
    expect(data.diffs).toBeDefined();
  });

  it('GET /api/config-history/:hash returns 400 for invalid SHA', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config-history/not-valid!',
    });

    expect(res.statusCode).toBe(400);
    const data = res.json();
    expect(data.error).toContain('Invalid git SHA');
  });

  it('POST /api/config-history/:hash/revert executes revert', async () => {
    // git revert --no-edit
    mockedExecFile.mockResolvedValueOnce(mockExecResult('') as any);
    // git diff-tree for files
    mockedExecFile.mockResolvedValueOnce(mockExecResult('config/permissions.json\n') as any);
    // git rev-parse HEAD
    mockedExecFile.mockResolvedValueOnce(mockExecResult('newreverthash\n') as any);

    const res = await app.inject({
      method: 'POST',
      url: '/api/config-history/abc1234abcdef1234567/revert',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.success).toBe(true);
    expect(data.revertHash).toBe('newreverthash');
  });

  it('POST /api/config-history/:hash/revert returns 500 on failure', async () => {
    mockedExecFile.mockRejectedValueOnce(new Error('merge conflict'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/config-history/abc1234/revert',
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    const data = res.json();
    expect(data.success).toBe(false);
  });
});
