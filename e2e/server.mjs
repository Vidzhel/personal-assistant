import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
assert(existsSync(join(repo, 'packages/core/dist/raven.js')), 'Run npm run build:core first');
// Never attach a test browser to an existing Raven instance on any fixture port.
for (const port of [4420, 4421, 4422]) {
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolvePort);
  });
  await new Promise((resolvePort) => probe.close(resolvePort));
}
const root = mkdtempSync(join(tmpdir(), 'raven-browser-e2e-'));
const web = join(root, 'web');
mkdirSync(web);
for (const file of [
  'src',
  'next.config.ts',
  'postcss.config.mjs',
  'package.json',
  'tsconfig.json',
]) {
  cpSync(join(repo, 'packages/web', file), join(web, file), { recursive: true });
}
symlinkSync(join(repo, 'node_modules'), join(web, 'node_modules'), 'dir');
// Fresh allowlist prevents repo dotenv, live account services, SDK credentials,
// custom Node loaders and user Git hooks/config from entering the test runtime.
const env = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  NODE_ENV: 'test',
  NEO4J_ENABLED: 'false',
  NEO4J_URI: 'bolt://graph.invalid:7687',
  NEO4J_USER: 'browser-fake',
  NEO4J_PASSWORD: 'browser-fake',
  RAVEN_PORT: '4421',
  RAVEN_TIMEZONE: 'UTC',
  RAVEN_AUTO_RETROSPECTIVE_ENABLED: 'false',
  RAVEN_SESSION_IDLE_TIMEOUT_MS: '86400000',
  LOG_LEVEL: 'warn',
  NEXT_TELEMETRY_DISABLED: '1',
  GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'),
  GIT_CONFIG_NOSYSTEM: '1',
  CLAUDE_CONFIG_DIR: join(root, 'fake-claude'),
  XDG_CONFIG_HOME: join(root, 'isolated-config'),
};
mkdirSync(env.CLAUDE_CONFIG_DIR);
const children = [];
let stopping;
function launch(args, cwd, childEnv) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit' });
  children.push(child);
  child.once('error', (error) => {
    console.error(error);
    void stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) void stop(code || 1);
  });
  return child;
}
function stop(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise((resolveChild) => child.once('close', resolveChild));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await closed;
        clearTimeout(timer);
      }),
    );
    rmSync(root, { recursive: true, force: true });
    process.exitCode = code;
  })();
  return stopping;
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
launch([join(import.meta.dirname, 'server-core.mjs'), root], root, env);
launch(
  [
    join(repo, 'node_modules/next/dist/bin/next'),
    'dev',
    '--webpack',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4420',
  ],
  web,
  {
    ...env,
    NODE_ENV: 'development',
    NEXT_PUBLIC_CORE_API_URL: 'http://127.0.0.1:4421/api',
    NEXT_PUBLIC_CORE_WS_URL: 'ws://127.0.0.1:4421/ws',
  },
);
