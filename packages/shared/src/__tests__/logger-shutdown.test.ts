import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHILD_TIMEOUT_MS = 10_000;
const WORKER_READY_DELAY_MS = 250;

describe('logging shutdown in a standalone process', () => {
  it.each([0, WORKER_READY_DELAY_MS])('flushes and exits after a %i ms delay', (delayMs) => {
    const logDir = mkdtempSync(join(tmpdir(), 'raven-logger-shutdown-'));
    try {
      const loggerUrl = new URL('../utils/logger.ts', import.meta.url).href;
      const script = `
        import { initFileLogging, createLogger, closeFileLogging } from ${JSON.stringify(loggerUrl)};
        initFileLogging({ logDir: ${JSON.stringify(logDir)} });
        createLogger('shutdown-test').info('Durable final log');
        if (${delayMs}) await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
        await closeFileLogging();
        await closeFileLogging();
        console.log('logging closed');
      `;
      const child = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '--eval', script],
        {
          cwd: logDir,
          env: { PATH: process.env.PATH, NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain('logging closed');
      const logs = readdirSync(logDir)
        .map((name) => readFileSync(join(logDir, name), 'utf8'))
        .join('\n');
      expect(logs).toContain('Durable final log');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
