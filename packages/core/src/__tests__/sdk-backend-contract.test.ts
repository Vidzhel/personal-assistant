import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';

/**
 * Contract test over the REAL @anthropic-ai/claude-agent-sdk `query()` — no
 * `vi.mock` on the SDK module (see sdk-backend-plugins.test.ts for that
 * approach elsewhere). This spawns an actual Node subprocess: our fake
 * executable at fixtures/fake-claude-executable.mjs, pointed to via
 * `executablePathOverride` -> SDK's `pathToClaudeCodeExecutable`.
 *
 * Chosen over pure `vi.mock(query)` because the two riskiest claims in this
 * task are about the SDK's *subprocess boundary* — that `resume` actually
 * becomes `--resume <id>` on argv, and that the CLAUDECODE env var actually
 * gets stripped before the child sees it — neither of which a mocked
 * `query()` could ever demonstrate (it would only prove sdk-backend.ts
 * *called* query with the right options object, not that those options
 * reach a real child process the way we assume). Verified by inspecting the
 * SDK's bundled sdk.mjs directly: the executable-resolution helper takes the
 * "spawn `node <path> ...args`" branch whenever `pathToClaudeCodeExecutable`
 * ends in .js/.mjs/.tsx/.ts/.jsx (any other extension is spawned as a native
 * binary directly, which would need a shebang + exec bit) — hence the fake
 * executable's .mjs extension.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_EXECUTABLE = join(__dirname, 'fixtures', 'fake-claude-executable.mjs');

interface ArgvLogEntry {
  argv: string[];
  cwd: string;
  env: {
    CLAUDECODE: string | null;
    CLAUDE_CODE_ENTRYPOINT: string | null;
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: string | null;
  };
}

function readLogEntries(logPath: string): ArgvLogEntry[] {
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArgvLogEntry);
}

function baseOpts(overrides: Partial<BackendOptions> = {}): BackendOptions {
  return {
    prompt: 'test prompt',
    systemPrompt: 'You are a test agent',
    allowedTools: ['Read'],
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
    mcpServers: {},
    agents: {},
    onAssistantMessage: () => {},
    onStderr: () => {},
    executablePathOverride: FAKE_EXECUTABLE,
    ...overrides,
  };
}

describe('SDK backend contract (real subprocess spawn via fake executable)', () => {
  let tmpDir: string;
  let argvLogPath: string;
  let hadOwnClaudecode: boolean;
  let previousClaudecode: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-sdk-contract-'));
    argvLogPath = join(tmpDir, 'argv.log');
    process.env.FAKE_CLAUDE_ARGV_LOG = argvLogPath;
    hadOwnClaudecode = 'CLAUDECODE' in process.env;
    previousClaudecode = process.env.CLAUDECODE;
  });

  afterEach(() => {
    delete process.env.FAKE_CLAUDE_ARGV_LOG;
    if (hadOwnClaudecode) {
      process.env.CLAUDECODE = previousClaudecode;
    } else {
      delete process.env.CLAUDECODE;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a real subprocess and parses session id + result from stream-json', async () => {
    const backend = createSdkBackend();
    const result = await backend(baseOpts());

    expect(result).toMatchObject({ sessionId: 'fake-123', success: true, result: 'ok' });
  });

  it('does not pass --resume on a cold turn (no resume option set)', async () => {
    const backend = createSdkBackend();
    await backend(baseOpts());

    const [entry] = readLogEntries(argvLogPath);
    expect(entry.argv).not.toContain('--resume');
  });

  it('passes --resume=<id> through to the subprocess when resuming', async () => {
    // As of SDK 0.3.212, --resume is emitted in equals-form (`--resume=<id>`)
    // rather than as two separate argv entries (`--resume`, `<id>`).
    const backend = createSdkBackend();
    await backend(baseOpts({ resume: 'fake-123' }));

    const [entry] = readLogEntries(argvLogPath);
    expect(entry.argv).toContain('--resume=fake-123');
  });

  it('passes maxBudgetUsd through to the subprocess', async () => {
    const backend = createSdkBackend();
    await backend(baseOpts({ maxBudgetUsd: 0.23 }));

    const [entry] = readLogEntries(argvLogPath);
    const budgetIndex = entry.argv.indexOf('--max-budget-usd');
    expect(budgetIndex).toBeGreaterThanOrEqual(0);
    expect(entry.argv[budgetIndex + 1]).toBe('0.23');
  });

  it('strips CLAUDECODE from the subprocess env (nesting guard)', async () => {
    // Simulate running inside an outer Claude Code session, which is where
    // the nesting-guard problem actually shows up in production.
    process.env.CLAUDECODE = '1';

    const backend = createSdkBackend();
    await backend(baseOpts());

    const [entry] = readLogEntries(argvLogPath);
    expect(entry.env.CLAUDECODE).toBeNull();
  });

  it('passes isolated defaults and the requested working directory', async () => {
    const backend = createSdkBackend();
    await backend(baseOpts({ cwd: tmpDir }));

    const [entry] = readLogEntries(argvLogPath);
    expect(entry.cwd).toBe(tmpDir);
    expect(entry.argv).toContain('--setting-sources=');
    expect(entry.argv).toContain('--strict-mcp-config');
    expect(entry.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it.each([
    ['auto', false],
    ['bypassPermissions', true],
  ] as const)('passes %s permission mode and bypass guard', async (mode, bypass) => {
    const backend = createSdkBackend();
    await backend(baseOpts({ permissionMode: mode }));

    const [entry] = readLogEntries(argvLogPath);
    const modeIndex = entry.argv.indexOf('--permission-mode');
    expect(entry.argv[modeIndex + 1]).toBe(mode);
    expect(entry.argv.includes('--allow-dangerously-skip-permissions')).toBe(bypass);
  });

  it('passes additional directories and explicit project/local settings', async () => {
    const backend = createSdkBackend();
    await backend(
      baseOpts({
        cwd: tmpDir,
        additionalDirectories: [tmpDir],
        settingSources: ['project', 'local'],
      }),
    );

    const [entry] = readLogEntries(argvLogPath);
    const addDirIndex = entry.argv.indexOf('--add-dir');
    expect(entry.argv[addDirIndex + 1]).toBe(tmpDir);
    expect(entry.argv).toContain('--setting-sources=project,local');
    expect(entry.argv).toContain('--strict-mcp-config');
  });
});
