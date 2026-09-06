import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleCalendarClient,
  runGws,
  type GwsRunRequest,
} from '../integrations/google-calendar/google-calendar-client.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeRequest(mode: string, overrides: Partial<GwsRunRequest> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raven-calendar-runner-'));
  roots.push(root);
  const executable = join(root, 'gws');
  const pidFile = join(root, 'pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
process.stderr.write('secret-stderr-value\\n');
if (process.env.FAKE_MODE === 'split') {
  process.stdout.write('{"items":');
  setTimeout(() => process.stdout.end('[]}'), 20);
} else if (process.env.FAKE_MODE === 'overflow') {
  process.stdout.write('x'.repeat(4096));
  setInterval(() => {}, 1000);
} else {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`,
  );
  await chmod(executable, 0o755);
  const request: GwsRunRequest = {
    command: executable as 'gws',
    args: ['calendar', 'calendarList', 'list', '--params', '{}', '--format', 'json'],
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, FAKE_MODE: mode, FAKE_PID_FILE: pidFile },
    timeoutMs: 2_000,
    maxOutputBytes: 1024,
    ...overrides,
  };
  return { request, pidFile };
}

async function expectStopped(pidFile: string): Promise<void> {
  const pid = Number(await readFile(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('runGws', () => {
  it('returns only a fixed reconnect reason for invalid_grant output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-calendar-auth-'));
    roots.push(root);
    const executable = join(root, 'gws');
    await writeFile(
      executable,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ error: 'invalid_grant', error_description: 'secret-refresh-token' }));
process.stderr.write('secret-stderr-value');
process.exitCode = 1;
`,
    );
    await chmod(executable, 0o755);
    const client = new GoogleCalendarClient({
      env: {
        PATH: `${root}:${process.env.PATH ?? ''}`,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: join(root, 'credentials.json'),
      },
    });
    const result = await client.listCalendars();
    expect(result).toEqual({
      items: [],
      complete: false,
      reason:
        'Google Calendar authentication expired or was revoked; reconnect Google Calendar (page 1)',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('invalid_grant');
  });

  it('waits for close and assembles split stdout without exposing stderr', async () => {
    const { request } = await fakeRequest('split');
    await expect(runGws(request)).resolves.toBe('{"items":[]}');
  });

  it('terminates and drains the child on output overflow', async () => {
    const { request, pidFile } = await fakeRequest('overflow');
    await expect(runGws(request)).rejects.toThrow('output budget');
    await expectStopped(pidFile);
  });

  it('terminates and drains the child on timeout without leaking stderr', async () => {
    const { request, pidFile } = await fakeRequest('hang', { timeoutMs: 150 });
    await expect(runGws(request)).rejects.toThrow('timed out');
    await expectStopped(pidFile);
  });

  it('terminates and drains the child when the caller aborts', async () => {
    const controller = new AbortController();
    const { request, pidFile } = await fakeRequest('hang', { signal: controller.signal });
    const pending = runGws(request);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    await expectStopped(pidFile);
  });

  it('does not spawn for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const { request, pidFile } = await fakeRequest('split', { signal: controller.signal });
    await expect(runGws(request)).rejects.toThrow('aborted');
    await expect(readFile(pidFile, 'utf8')).rejects.toThrow();
  });

  it('rejects a synchronous spawn failure without retaining an abort listener', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    await expect(
      runGws({
        command: '\0' as 'gws',
        args: [],
        env: {},
        signal: controller.signal,
        timeoutMs: 10,
        maxOutputBytes: 10,
      }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
