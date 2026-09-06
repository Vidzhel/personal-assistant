import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const repository = resolve(import.meta.dirname, '..');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-launcher-'));
  roots.push(root);
  const envFile = join(root, 'test settings.env');
  const sentinel = join(root, 'executed-env');
  writeFileSync(envFile, `UNUSED=$(touch '${sentinel}')\n`);
  const docker = join(root, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.RAVEN_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
const command = args.slice(3);
if (command[0] === 'config' && command[1] === '--services') {
  console.log(process.env.RAVEN_TEST_GRAPH === '1' ? 'neo4j\\nraven-core\\nraven-web' : 'raven-core\\nraven-web');
}
if (command[0] === 'run' && command.includes('status') && process.env.RAVEN_TEST_AUTH === 'missing') process.exit(1);
if (command[0] === 'run' && command.includes('login') && process.env.RAVEN_TEST_FAIL === 'login') process.exit(1);
if (command[0] === 'build' && process.env.RAVEN_TEST_FAIL === 'build') process.exit(1);
if (command[0] === 'up' && command.at(-1) === 'neo4j' && process.env.RAVEN_TEST_FAIL === 'graph') process.exit(1);
`,
  );
  chmodSync(docker, 0o755);
  const log = join(root, 'docker.jsonl');
  const env = {
    PATH: `${root}:${process.env.PATH}`,
    HOME: root,
    RAVEN_ENV_FILE: envFile,
    RAVEN_TEST_DOCKER_LOG: log,
  };
  return { root, envFile, sentinel, log, env };
}

function run(f, action = 'start', settings = {}) {
  const result = spawnSync('bash', [join(repository, 'scripts/raven.sh'), action], {
    cwd: f.root,
    env: { ...f.env, ...settings },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  const calls = existsSync(f.log)
    ? readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  for (const call of calls)
    assert.deepEqual(call.slice(0, 3), ['compose', '--env-file', f.envFile]);
  assert.equal(existsSync(f.sentinel), false, 'Launcher must never execute the env file');
  return { result, commands: calls.map((call) => call.slice(3)) };
}

test('start uses the selected env file from another cwd and reuses valid auth without a graph', () => {
  const f = fixture();
  const { result, commands } = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    commands.filter((c) => c[0] === 'up'),
    [['up', '-d', '--wait', 'raven-core', 'raven-web']],
  );
  assert.equal(
    commands.some((c) => c[0] === 'run' && c.includes('login')),
    false,
  );
  assert(commands.some((c) => c[0] === 'run' && c.includes('-T') && c.includes('status')));
});

test('first start logs in and waits for the configured graph before starting Raven', () => {
  const { result, commands } = run(fixture(), 'start', {
    RAVEN_TEST_AUTH: 'missing',
    RAVEN_TEST_GRAPH: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const login = commands.findIndex((c) => c[0] === 'run' && c.includes('login'));
  const graph = commands.findIndex((c) => c[0] === 'up' && c.at(-1) === 'neo4j');
  const core = commands.findIndex((c) => c[0] === 'up' && c.includes('raven-core'));
  assert(login >= 0 && graph > login && core > graph);
});

for (const failure of ['build', 'login', 'graph']) {
  test(`${failure} failure prevents Raven startup`, () => {
    const { result, commands } = run(fixture(), 'start', {
      RAVEN_TEST_AUTH: 'missing',
      RAVEN_TEST_GRAPH: '1',
      RAVEN_TEST_FAIL: failure,
    });
    assert.notEqual(result.status, 0);
    assert.equal(
      commands.some((c) => c[0] === 'up' && c.includes('raven-core')),
      false,
    );
  });
}

test('stop preserves volumes and does not build or authenticate', () => {
  const { result, commands } = run(fixture(), 'stop');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands, [['config', '--quiet'], ['stop']]);
});

test('unknown actions and missing env files never invoke Docker', () => {
  const f = fixture();
  assert.equal(run(f, 'erase').result.status, 2);
  rmSync(f.envFile);
  const { result, commands } = run(f);
  assert.equal(result.status, 1);
  assert.deepEqual(commands, []);
});

function syntaxFixture(source) {
  const root = fixture().root;
  mkdirSync(join(root, 'scripts'));
  copyFileSync(
    join(repository, 'scripts/check-strip-types.sh'),
    join(root, 'scripts/check-strip-types.sh'),
  );
  for (const name of ['core', 'shared', 'mcp-ticktick'])
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
  writeFileSync(join(root, 'packages/core/src/index.ts'), source);
  const result = spawnSync('bash', [join(root, 'scripts/check-strip-types.sh')], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, HOME: root },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { root, result };
}

test('strip-types validation never executes an entry point', () => {
  const { result } = syntaxFixture(
    'throw new Error("ENTRY_POINT_EXECUTED");\nconst value: number = 1;\n',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 production files; no code executed/);
});

test('strip-types validation rejects syntax requiring TypeScript transformation', () => {
  const { result } = syntaxFixture('class Unsupported { constructor(public value: number) {} }\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
});
