import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gwsExec } from '../gws-exec.ts';

// vi.mock is hoisted — use vi.hoisted to define the mock fn
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

// Mock node:child_process — we use execFile (NOT exec) for safety
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Sets up mockExecFile to simulate Node's callback signature:
 * callback(error, stdout, stderr)
 * Note: promisify wraps this into a Promise that resolves {stdout, stderr}
 * or rejects with error (which may have .stdout/.stderr attached).
 */
function setupSuccess(stdout: string, stderr = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: (...a: any[]) => void) => {
      callback(null, stdout, stderr);
    },
  );
}

function setupError(errorObj: { message?: string; stderr?: string }): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: (...a: any[]) => void) => {
      const err = new Error(errorObj.message || 'Command failed');
      callback(err, '', errorObj.stderr || '');
    },
  );
}

describe('gwsExec', () => {
  it('calls gws with correct args via execFile (no shell injection)', async () => {
    setupSuccess('{"events": []}');

    const result = await gwsExec(['calendar', '+agenda', '--format', 'json']);

    expect(mockExecFile).toHaveBeenCalledWith(
      'gws',
      ['calendar', '+agenda', '--format', 'json'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
    expect(result.data).toEqual({ events: [] });
  });

  it('passes credentials file via env', async () => {
    setupSuccess('{}');

    await gwsExec(['calendar', '+agenda'], { credentialsFile: '/path/to/creds.json' });

    const opts = mockExecFile.mock.calls[0][2];
    expect(opts.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe('/path/to/creds.json');
  });

  it('uses custom timeout', async () => {
    setupSuccess('{}');

    await gwsExec(['calendar', '+agenda'], { timeout: 60_000 });

    const opts = mockExecFile.mock.calls[0][2];
    expect(opts.timeout).toBe(60_000);
  });

  it('returns null data for empty stdout', async () => {
    setupSuccess('  \n  ');

    const result = await gwsExec(['calendar', '+agenda']);

    expect(result.data).toBeNull();
  });

  it('parses JSON from stdout', async () => {
    const data = { items: [{ id: '1', title: 'Test' }] };
    setupSuccess(JSON.stringify(data));

    const result = await gwsExec(['tasks', 'tasklists', 'list']);

    expect(result.data).toEqual(data);
  });

  it('captures stderr on success', async () => {
    setupSuccess('{}', 'some warning');

    const result = await gwsExec(['calendar', '+agenda']);

    expect(result.stderr).toBe('some warning');
  });

  it('throws on error with stderr message', async () => {
    setupError({ stderr: 'authentication failed' });

    await expect(gwsExec(['calendar', '+agenda'])).rejects.toThrow(
      'gws command failed: authentication failed',
    );
  });

  it('throws on error with fallback message', async () => {
    setupError({ message: 'spawn gws ENOENT' });

    await expect(gwsExec(['calendar', '+agenda'])).rejects.toThrow(
      'gws command failed: spawn gws ENOENT',
    );
  });

  it('throws on invalid JSON output', async () => {
    setupSuccess('not json');

    await expect(gwsExec(['calendar', '+agenda'])).rejects.toThrow();
  });
});
