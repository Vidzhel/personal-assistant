import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const coreEntry = join(repoRoot, 'packages/core/dist/raven.js');
assert(existsSync(coreEntry), 'Build core first: npm run build:core');
const root = mkdtempSync(join(tmpdir(), 'raven-compiled-smoke-'));
const rel = relative(realpathSync(repoRoot), realpathSync(root));
assert(
  rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
  'Smoke runtime must be outside the checkout',
);
const worker = join(import.meta.dirname, 'smoke-compiled-core-worker.mjs');
const WORKER_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 32_000;

// An allowlist, not a credential blacklist: no inherited account tokens,
// NODE_OPTIONS loaders, SDK settings, service switches, or dotenv are accepted.
const childEnv = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: 'test',
  NEO4J_ENABLED: 'false',
  NEO4J_URI: 'bolt://graph.invalid:7687',
  NEO4J_USER: 'smoke-fake',
  NEO4J_PASSWORD: 'smoke-fake',
  RAVEN_PORT: '0',
  RAVEN_TIMEZONE: 'UTC',
  RAVEN_AUTO_RETROSPECTIVE_ENABLED: 'false',
  RAVEN_SESSION_IDLE_TIMEOUT_MS: '86400000',
  LOG_LEVEL: 'warn',
  GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'),
  GIT_CONFIG_NOSYSTEM: '1',
  CLAUDE_CONFIG_DIR: join(root, 'fake-claude-config'),
  XDG_CONFIG_HOME: join(root, 'isolated-config'),
};
mkdirSync(childEnv.CLAUDE_CONFIG_DIR);

function runWorker(phase) {
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [worker, phase, root], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    let result;
    let timedOut = false;
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-MAX_CAPTURE_BYTES);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('message', (message) => {
      result = message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, WORKER_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || !result?.ok || timedOut) {
        reject(
          new Error(
            `Compiled smoke ${phase} failed (code=${code}, signal=${signal}, timeout=${timedOut}).\n${output}`,
          ),
        );
      } else resolveWorker(result);
    });
  });
}

try {
  const first = await runWorker('create');
  // Simulate a disposable image worktree: the persisted Git metadata stays in data/.
  rmSync(join(root, '.git'));
  const second = await runWorker('restart');
  assert.equal(second.migrations, first.migrations);
  console.log(
    `Compiled core smoke passed: ${second.migrations} migrations, ${second.services} services, HTTP/chat, persisted definitions/memory/history, two clean process exits.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
