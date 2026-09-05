import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeProcess, RunCodeProcessError } from '../task-execution/run-code-process.ts';

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

describe('runCodeProcess', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('returns stdout and stderr after a successful child closes', async () => {
    const result = await runCodeProcess(process.execPath, [
      '-e',
      "require('node:fs').writeSync(1, 'output'); require('node:fs').writeSync(2, 'diagnostic');",
    ]);

    expect(result).toEqual({ stdout: 'output', stderr: 'diagnostic' });
  });

  it('preserves output on a normal nonzero exit', async () => {
    const outcome = runCodeProcess(process.execPath, [
      '-e',
      "require('node:fs').writeSync(1, 'partial'); require('node:fs').writeSync(2, 'failed'); process.exit(7);",
    ]);

    await expect(outcome).rejects.toBeInstanceOf(RunCodeProcessError);
    await expect(outcome).rejects.toMatchObject({
      code: 7,
      signal: null,
      stdout: 'partial',
      stderr: 'failed',
    });
  });

  it('decodes UTF-8 sequences split across output chunks', async () => {
    const result = await runCodeProcess(process.execPath, [
      '-e',
      "const fs = require('node:fs'); fs.writeSync(1, Buffer.from([240])); setTimeout(() => fs.writeSync(1, Buffer.from([159, 146, 169])), 20);",
    ]);

    expect(result.stdout).toBe('💩');
  });

  it('terminates a process that exceeds the output limit', async () => {
    const outcome = runCodeProcess(
      process.execPath,
      [
        '-e',
        "require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 'x')); setInterval(() => {}, 1000);",
      ],
      { killGraceMs: 60 },
    );

    await expect(outcome).rejects.toMatchObject({ name: 'RunCodeOutputLimitError' });
  });

  it('rejects a nonexistent executable without waiting for stream end', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-run-code-process-'));
    const outcome = runCodeProcess(join(root, 'missing-executable'));

    await expect(outcome).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a SIGTERM handler to close before rejecting cancellation', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-run-code-process-'));
    const readyPath = join(root, 'ready');
    const controller = new AbortController();
    const reason = new Error('cancel code task');
    const outcome = runCodeProcess(
      process.execPath,
      [
        '-e',
        [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      { signal: controller.signal, killGraceMs: 500 },
    );
    try {
      await waitForFile(readyPath);
      const started = Date.now();
      controller.abort(reason);

      await expect(outcome).rejects.toBe(reason);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await outcome.catch(() => undefined);
    }
  });

  it('bounds cancellation when a child ignores SIGTERM', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-run-code-process-'));
    const readyPath = join(root, 'ready');
    const controller = new AbortController();
    const reason = new Error('force stop code task');
    const outcome = runCodeProcess(
      process.execPath,
      [
        '-e',
        [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      { signal: controller.signal, killGraceMs: 60 },
    );
    try {
      await waitForFile(readyPath);
      const started = Date.now();
      controller.abort(reason);

      await expect(outcome).rejects.toBe(reason);
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await outcome.catch(() => undefined);
    }
  });

  it('kills an owned POSIX descendant process group', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-run-code-process-'));
    const readyPath = join(root, 'ready');
    const latePath = join(root, 'late-output');
    const descendantCode = [
      "const fs = require('node:fs');",
      `const marker = ${JSON.stringify(latePath)};`,
      "process.on('SIGTERM', () => {});",
      `fs.writeFileSync(${JSON.stringify(join(root, 'descendant-ready'))}, 'ready');`,
      "setTimeout(() => fs.writeFileSync(marker, 'late'), 350);",
      'setTimeout(() => process.exit(0), 700);',
    ].join('');
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => process.exit(0));",
      `const waitForDescendant = () => fs.existsSync(${JSON.stringify(join(root, 'descendant-ready'))}) ? fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready') : setTimeout(waitForDescendant, 5);`,
      'waitForDescendant();',
      'setInterval(() => {}, 1000);',
    ].join('');
    const controller = new AbortController();
    const reason = new Error('cancel process group');
    const outcome = runCodeProcess(process.execPath, ['-e', parentCode], {
      signal: controller.signal,
      killGraceMs: 60,
    });

    try {
      await waitForFile(readyPath);
      expect(readFileSync(readyPath, 'utf8')).toBe('ready');
      controller.abort(reason);
      await expect(outcome).rejects.toMatchObject({ message: 'cancel process group' });
      await delay(450);
      expect(existsSync(latePath)).toBe(false);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await outcome.catch(() => undefined);
    }
  });
});
