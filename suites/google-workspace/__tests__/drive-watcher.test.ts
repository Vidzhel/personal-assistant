import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted for mock setup before vi.mock hoisting
const { mockSpawn, mockGenerateId, mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockGenerateId: vi.fn(() => 'test-drive-id-123'),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

vi.mock('@raven/shared', () => ({
  generateId: mockGenerateId,
  SOURCE_GWS_DRIVE: 'gws-drive',
}));

/**
 * Creates a mock spawn result that auto-completes via microtask.
 * Must be called inside mockSpawn.mockImplementation so emission
 * is scheduled AFTER spawn() returns and listeners are attached.
 */
function createAutoProc(exitCode: number, stdout: string, stderr: string): any {
  let exitCb: ((code: number) => void) | null = null;
  const stdoutCbs: Array<(chunk: Buffer) => void> = [];
  const stderrCbs: Array<(chunk: Buffer) => void> = [];

  const proc: any = {
    stdout: { on: vi.fn((_e: string, cb: any) => { stdoutCbs.push(cb); }) },
    stderr: { on: vi.fn((_e: string, cb: any) => { stderrCbs.push(cb); }) },
    on: vi.fn((event: string, cb: any) => {
      if (event === 'exit') exitCb = cb;
    }),
    kill: vi.fn(),
  };

  // Schedule emission via microtask — fires after sync listener setup
  queueMicrotask(() => {
    if (stdout) stdoutCbs.forEach(cb => cb(Buffer.from(stdout)));
    if (stderr) stderrCbs.forEach(cb => cb(Buffer.from(stderr)));
    exitCb?.(exitCode);
  });

  return proc;
}

/** Helper: queue spawn responses in order */
function queueSpawnResponses(...responses: Array<{ code: number; stdout: string; stderr: string }>): void {
  for (const r of responses) {
    mockSpawn.mockImplementationOnce(() => createAutoProc(r.code, r.stdout, r.stderr));
  }
}

describe('GWS Drive Watcher Service', () => {
  let mockEventBus: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  let mockLogger: Record<string, ReturnType<typeof vi.fn>>;
  let service: any;

  const CHANGES_RESPONSE = JSON.stringify({
    changes: [
      {
        kind: 'drive#change',
        type: 'file',
        fileId: 'file-abc',
        time: '2026-03-21T10:00:00Z',
        removed: false,
        file: {
          id: 'file-abc',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          parents: ['monitored-folder-1'],
          modifiedTime: '2026-03-21T10:00:00Z',
          size: '2048',
          webViewLink: 'https://drive.google.com/file/d/file-abc/view',
        },
      },
    ],
    newStartPageToken: '67890',
  });

  const CHANGES_NON_MONITORED = JSON.stringify({
    changes: [
      {
        kind: 'drive#change',
        type: 'file',
        fileId: 'file-xyz',
        removed: false,
        file: {
          id: 'file-xyz',
          name: 'other.docx',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['some-other-folder'],
          modifiedTime: '2026-03-21T11:00:00Z',
          size: '512',
        },
      },
    ],
    newStartPageToken: '67891',
  });

  const START_TOKEN_RESPONSE = JSON.stringify({ startPageToken: '12345' });

  const defaultContext = {
    eventBus: null as any,
    logger: null as any,
    config: { driveFolders: ['monitored-folder-1'], drivePollingIntervalMs: 60_000 },
    db: {} as any,
    projectRoot: '/tmp',
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    defaultContext.eventBus = mockEventBus;
    defaultContext.logger = mockLogger;

    process.env.GWS_PRIMARY_CREDENTIALS_FILE = '/path/to/creds.json';
    mockReadFile.mockRejectedValue(new Error('ENOENT')); // No persisted token by default
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);

    vi.resetModules();
    const mod = await import('../services/drive-watcher.ts');
    service = mod.default;
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    delete process.env.GWS_PRIMARY_CREDENTIALS_FILE;
  });

  it('fetches getStartPageToken then polls with changes list', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      'gws',
      expect.arrayContaining(['drive', 'changes', 'getStartPageToken']),
      expect.any(Object),
    );

    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      'gws',
      expect.arrayContaining(['drive', 'changes', 'list']),
      expect.any(Object),
    );
  });

  it('emits gdrive:new-file event for files in monitored folder', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-drive-id-123',
        source: 'gws-drive',
        type: 'gdrive:new-file',
        payload: expect.objectContaining({
          fileId: 'file-abc',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          folderId: 'monitored-folder-1',
          modifiedTime: '2026-03-21T10:00:00Z',
          size: 2048,
        }),
      }),
    );
  });

  it('ignores files in non-monitored folders', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_NON_MONITORED + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('logs warning and continues on CLI error', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 1, stdout: '', stderr: 'API unavailable' },
    );

    await service.start({ ...defaultContext });

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Drive poll failed'));
    expect(mockEventBus.emit).not.toHaveBeenCalled();

    // Next poll should still fire — service keeps running
    queueSpawnResponses(
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    // Allow microtasks to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSpawn).toHaveBeenCalledTimes(3); // token + error + retry
  });

  it('handles config:reloaded to update monitored folders from disk', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_NON_MONITORED + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    // File was in 'some-other-folder', not monitored → no event
    expect(mockEventBus.emit).not.toHaveBeenCalled();

    // Simulate config:reloaded — find the registered handler
    const configHandler = mockEventBus.on.mock.calls.find(
      (call: any) => call[0] === 'config:reloaded',
    )?.[1];
    expect(configHandler).toBeDefined();

    // Mock suites.json on disk with updated driveFolders
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      'google-workspace': {
        enabled: true,
        config: { driveFolders: ['some-other-folder'], drivePollingIntervalMs: 60_000 },
      },
    }));

    // Fire config:reloaded event (single arg, like the real event bus)
    configHandler({
      type: 'config:reloaded',
      payload: { configType: 'suites', timestamp: new Date().toISOString() },
    });

    // Next poll with file in now-monitored folder
    queueSpawnResponses(
      { code: 0, stdout: CHANGES_NON_MONITORED + '\n', stderr: '' },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gdrive:new-file',
        payload: expect.objectContaining({
          fileId: 'file-xyz',
          folderId: 'some-other-folder',
        }),
      }),
    );
  });

  it('stop() clears poll timer and running state', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    const callCount = mockSpawn.mock.calls.length;
    await service.stop();

    // Advance past several poll intervals — no new spawns should occur
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockSpawn.mock.calls.length).toBe(callCount);
  });

  it('reads persisted pageToken on start', async () => {
    mockReadFile.mockResolvedValueOnce('persisted-token-99');

    // Should skip getStartPageToken and go straight to changes list
    queueSpawnResponses(
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    // Should NOT have called getStartPageToken
    const startTokenCalls = mockSpawn.mock.calls.filter(
      (call: any) => call[1].includes('getStartPageToken'),
    );
    expect(startTokenCalls).toHaveLength(0);

    // Should have used the persisted token in params
    expect(mockSpawn).toHaveBeenCalledWith(
      'gws',
      expect.arrayContaining([
        'drive', 'changes', 'list',
        '--params', expect.stringContaining('persisted-token-99'),
      ]),
      expect.any(Object),
    );
  });

  it('persists pageToken after successful poll', async () => {
    queueSpawnResponses(
      { code: 0, stdout: START_TOKEN_RESPONSE + '\n', stderr: '' },
      { code: 0, stdout: CHANGES_RESPONSE + '\n', stderr: '' },
    );

    await service.start({ ...defaultContext });

    // Should have written the newStartPageToken from the response
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('gdrive-page-token.txt'),
      '67890',
      'utf-8',
    );
  });
});
