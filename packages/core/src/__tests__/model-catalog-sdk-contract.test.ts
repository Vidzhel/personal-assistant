import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverSdkModels } from '../agent-registry/model-catalog.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-model-discovery-executable.mjs',
);

describe('SDK model catalog zero-prompt contract', () => {
  let root: string;
  let logPath: string;
  let lifecycleLogPath: string;
  let priorEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raven-model-catalog-contract-'));
    logPath = join(root, 'protocol.log');
    lifecycleLogPath = join(root, 'lifecycle.log');
    priorEnvironment = {
      FAKE_MODEL_DISCOVERY_LOG: process.env.FAKE_MODEL_DISCOVERY_LOG,
      FAKE_MODEL_DISCOVERY_LIFECYCLE_LOG: process.env.FAKE_MODEL_DISCOVERY_LIFECYCLE_LOG,
      FAKE_MODEL_DISCOVERY_MODE: process.env.FAKE_MODEL_DISCOVERY_MODE,
    };
    process.env.FAKE_MODEL_DISCOVERY_LOG = logPath;
    process.env.FAKE_MODEL_DISCOVERY_LIFECYCLE_LOG = lifecycleLogPath;
  });

  afterEach(() => {
    restoreEnvironment(priorEnvironment);
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers supported models through initialize without a user/model prompt', async () => {
    const models = await discoverSdkModels({
      executablePathOverride: FIXTURE,
      signal: AbortSignal.timeout(5_000),
    });
    const protocol = readProtocol(logPath);

    expect(models).toEqual([
      expect.objectContaining({
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        supportedEffortLevels: ['low', 'high'],
      }),
    ]);
    expect(protocol).toEqual([{ type: 'control_request', subtype: 'initialize' }]);
    expect(protocol.some((message) => message.type === 'user')).toBe(false);
    await expectLifecycleClose(lifecycleLogPath);
  });

  it('aborts and closes a discovery subprocess that never initializes', async () => {
    process.env.FAKE_MODEL_DISCOVERY_MODE = 'hang';
    await expect(
      discoverSdkModels({
        executablePathOverride: FIXTURE,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
    await expectLifecycleClose(lifecycleLogPath);
  });
});

function readProtocol(path: string): Array<{ type: string; subtype?: string }> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; subtype?: string });
}

async function expectLifecycleClose(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const lifecycle = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (lifecycle.includes('"type":"stdin:eof"')) {
      expect(lifecycle).toMatch(/"type":"started","pid":\d+/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fake model discovery process did not observe a clean stdin close');
}

function restoreEnvironment(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
