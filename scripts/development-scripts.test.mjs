import { updatePrivateAccessSettings } from './private-access-settings.mjs';
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
import yaml from 'js-yaml';

const repository = resolve(import.meta.dirname, '..');
const fakePasswordHash = `$2a$14$${'a'.repeat(53)}`;
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
	if (args[0] === 'run' && args.includes('hash-password')) {
	  let password = '';
	  process.stdin.setEncoding('utf8');
	  for await (const chunk of process.stdin) password += chunk;
	  if (process.env.RAVEN_TEST_FAIL === 'hash') process.exit(1);
	  if (!password.endsWith('\\n') || password.trim().length < 12) process.exit(2);
	  console.log(${JSON.stringify(fakePasswordHash)});
	  process.exit(0);
	}
	const envFileIndex = args.indexOf('--env-file');
	const command = envFileIndex >= 0 ? args.slice(envFileIndex + 2) : [];
	if (command[0] === 'ps' && command.includes('--status') && process.env.RAVEN_TEST_RUNNING === '1') console.log('raven-core');
	if (command[0] === 'config' && command[1] === '--quiet' && process.env.RAVEN_TEST_FAIL === 'config') process.exit(1);
	if (command[0] === 'config' && command[1] === '--services') {
	  const services = [];
	  if (process.env.RAVEN_TEST_GRAPH === '1') services.push('neo4j');
	  services.push('raven-core', 'raven-web');
	  if (process.env.RAVEN_TEST_GATEWAY === '1') services.push('raven-gateway');
	  console.log(services.join('\\n'));
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

function run(f, action = 'start', settings = {}, input) {
  const result = spawnSync('bash', [join(repository, 'scripts/raven.sh'), action], {
    cwd: f.root,
    env: { ...f.env, ...settings },
    encoding: 'utf8',
    input,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  const calls = existsSync(f.log)
    ? readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  for (const call of calls) {
    if (call[0] === 'compose') {
      if (call[1] === '--project-directory') {
        assert.equal(call[2], repository);
        assert.equal(call[3], '--env-file');
        assert.notEqual(call[4], f.envFile);
        assert(call[4].startsWith(`${f.root}/.`));
      } else {
        assert.deepEqual(call.slice(0, 3), ['compose', '--env-file', f.envFile]);
      }
    } else {
      assert.equal(call[0], 'run');
    }
  }
  assert.equal(existsSync(f.sentinel), false, 'Launcher must never execute the env file');
  return {
    result,
    commands: calls
      .filter((call) => call[0] === 'compose')
      .map((call) => call.slice(call.indexOf('--env-file') + 2)),
    dockerCommands: calls,
  };
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

test('private gateway is opt-in and starts with core and web', () => {
  const { result, commands } = run(fixture(), 'start', { RAVEN_TEST_GATEWAY: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    commands.filter((command) => command[0] === 'up'),
    [['up', '-d', '--wait', 'raven-core', 'raven-web', 'raven-gateway']],
  );
  assert.match(result.stdout, /configured private HTTPS address/);
  assert.match(result.stdout, /127\.0\.0\.1:4002/);
  assert.doesNotMatch(result.stdout, /localhost:4000/);
});

test('setup-private-access preserves the env file and treats password shell syntax as data', () => {
  const f = fixture();
  const passwordSentinel = join(f.root, 'password-executed');
  const password = `long safe $(touch '${passwordSentinel}') value`;
  writeFileSync(
    f.envFile,
    `UNUSED=$(touch '${f.sentinel}')\nKEEP_SETTING="value with spaces"\nCOMPOSE_FILE=docker-compose.yml:docker-compose.workspace.yml\n`,
  );
  const { result, commands, dockerCommands } = run(
    f,
    'setup-private-access',
    {},
    `https://raven-host.example.ts.net/\nowner.test\n${password}\n${password}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(f.envFile, 'utf8');
  assert(updated.includes(`UNUSED=$(touch '${f.sentinel}')`));
  assert(updated.includes('KEEP_SETTING="value with spaces"'));
  assert(
    updated.includes(
      'COMPOSE_FILE=docker-compose.yml:docker-compose.workspace.yml:docker-compose.private.yml',
    ),
  );
  assert(updated.includes('RAVEN_BASE_URL=https://raven-host.example.ts.net'));
  assert(updated.includes('RAVEN_PRIVATE_USERNAME=owner.test'));
  assert(updated.includes(`RAVEN_PRIVATE_PASSWORD_HASH='${fakePasswordHash}'`));
  assert.equal(updated.includes(password), false);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stderr.includes(password), false);
  assert.equal(JSON.stringify(dockerCommands).includes(password), false);
  assert.equal(existsSync(passwordSentinel), false);
  assert.deepEqual(commands, [['config', '--quiet']]);
  assert(
    dockerCommands.some(
      (command) =>
        command[0] === 'run' &&
        command.includes('none') &&
        command.includes('caddy:2.11.4-alpine') &&
        command.includes('hash-password') &&
        !command.includes('--plaintext'),
    ),
  );
});

test('setup-private-access rejects invalid input or hashing failure without changing the env file', () => {
  const scenarios = [
    {
      input: 'http://public.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
      settings: {},
    },
    {
      input: 'https://private.example.test\nowner\nlong-enough-password\ndifferent-password\n',
      settings: {},
    },
    {
      input: 'https://private.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
      settings: { RAVEN_TEST_FAIL: 'hash' },
    },
    {
      input: 'https://private.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
      settings: { RAVEN_TEST_FAIL: 'config' },
    },
    {
      input:
        ' https://private.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
      settings: {},
    },
    {
      input: 'https://private.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
      settings: { COMPOSE_FILE: 'docker-compose.yml' },
      error: /Unset the exported COMPOSE_FILE/,
    },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    const before = readFileSync(f.envFile, 'utf8');
    const { result } = run(f, 'setup-private-access', scenario.settings, scenario.input);
    assert.notEqual(result.status, 0);
    if (scenario.error) assert.match(result.stderr, scenario.error);
    assert.equal(readFileSync(f.envFile, 'utf8'), before);
  }
});

test('setup-private-access rejects executable COMPOSE_FILE syntax as literal invalid data', () => {
  const f = fixture();
  const composeSentinel = join(f.root, 'compose-executed');
  writeFileSync(
    f.envFile,
    `COMPOSE_FILE=docker-compose.yml:$(touch '${composeSentinel}')\nKEEP_SETTING=unchanged\n`,
  );
  const before = readFileSync(f.envFile, 'utf8');
  const { result } = run(
    f,
    'setup-private-access',
    {},
    'https://private.example.test\nowner\nlong-enough-password\nlong-enough-password\n',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /literal paths without interpolation or shell syntax/);
  assert.equal(readFileSync(f.envFile, 'utf8'), before);
  assert.equal(existsSync(composeSentinel), false);
});

test('setup-ticktick hides the token, preserves env data and installs through the stopped volume', () => {
  const f = fixture();
  const tokenSentinel = join(f.root, 'token-executed');
  const token = `official-$token-$(touch ${tokenSentinel})`;
  writeFileSync(f.envFile, `UNUSED=$(touch '${f.sentinel}')\nKEEP_SETTING=unchanged\n`);
  const { result, commands, dockerCommands } = run(
    f,
    'setup-ticktick',
    {},
    `${token}\n${token}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(f.envFile, 'utf8');
  assert(updated.includes(`UNUSED=$(touch '${f.sentinel}')`));
  assert(updated.includes('KEEP_SETTING=unchanged'));
  assert(updated.includes(`TICKTICK_MCP_TOKEN='${token}'`));
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.equal(JSON.stringify(dockerCommands).includes(token), false);
  assert.equal(existsSync(tokenSentinel), false);
  assert.deepEqual(commands, [
    ['ps', '--status', 'running', '--services'],
    ['build', 'raven-core'],
    ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'raven-core', 'deployment/install-ticktick.mjs', '--check'],
    ['config', '--quiet'],
    ['run', '--rm', '--no-deps', 'raven-core', 'node', 'deployment/install-ticktick.mjs'],
  ]);
});

test('setup-ticktick refuses a running stack before reading or changing the token', () => {
  const f = fixture();
  const before = readFileSync(f.envFile, 'utf8');
  const { result, commands } = run(f, 'setup-ticktick', { RAVEN_TEST_RUNNING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stop Raven before installing/);
  assert.equal(readFileSync(f.envFile, 'utf8'), before);
  assert.deepEqual(commands, [['ps', '--status', 'running', '--services']]);
});

test('setup-ticktick rejects mismatched input or candidate config without changing env', () => {
  for (const scenario of [
    { input: 'first-token\nsecond-token\n', settings: {} },
    { input: 'valid-token\nvalid-token\n', settings: { RAVEN_TEST_FAIL: 'config' } },
    {
      input: 'valid-token\nvalid-token\n',
      settings: { TICKTICK_MCP_TOKEN: 'exported-token' },
    },
    {
      input: 'valid-token\nvalid-token\n',
      settings: { COMPOSE_FILE: 'docker-compose.yml' },
    },
  ]) {
    const f = fixture();
    const before = readFileSync(f.envFile, 'utf8');
    const { result } = run(f, 'setup-ticktick', scenario.settings, scenario.input);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.envFile, 'utf8'), before);
  }
});

test('private Compose and Caddy configuration expose one authenticated loopback gateway', () => {
  const baseCompose = yaml.load(readFileSync(join(repository, 'docker-compose.yml'), 'utf8'));
  assert.equal(
    baseCompose.services['raven-core'].environment.TICKTICK_MCP_TOKEN,
    '${TICKTICK_MCP_TOKEN:-}',
  );
  const compose = yaml.load(readFileSync(join(repository, 'docker-compose.private.yml'), 'utf8'));
  const gateway = compose.services['raven-gateway'];
  assert.equal(gateway.image, 'caddy:2.11.4-alpine');
  assert.deepEqual(gateway.ports, ['127.0.0.1:4002:4002']);
  assert(gateway.environment.RAVEN_PRIVATE_USERNAME.includes('${RAVEN_PRIVATE_USERNAME:'));
  assert(
    gateway.environment.RAVEN_PRIVATE_PASSWORD_HASH.includes('${RAVEN_PRIVATE_PASSWORD_HASH:'),
  );
  assert(compose.services['raven-core'].environment.RAVEN_BASE_URL.includes('${RAVEN_BASE_URL:'));
  assert.deepEqual(compose.services['raven-web'].build.args, {
    NEXT_PUBLIC_CORE_API_URL: '/api',
    NEXT_PUBLIC_CORE_WS_URL: '',
  });
  assert(compose.services['raven-web'].healthcheck.test.join(' ').includes('127.0.0.1:4000'));
  assert.equal(gateway.depends_on['raven-web'].condition, 'service_healthy');
  assert(gateway.healthcheck.test.join(' ').includes("grep -q ' 401 '"));

  const caddy = readFileSync(join(repository, 'deployment/Caddyfile.private'), 'utf8');
  const authentication = caddy.indexOf('basic_auth');
  const coreRoute = caddy.indexOf('@raven_core path /api /api/* /ws');
  const webRoute = caddy.indexOf('reverse_proxy raven-web:4000');
  assert(authentication >= 0 && authentication < coreRoute && coreRoute < webRoute);
  assert.match(caddy, /reverse_proxy @raven_core raven-core:4001/);
  assert.doesNotMatch(caddy, /localhost|127\.0\.0\.1/);
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
  for (const name of ['core', 'shared'])
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


test('private setup preserves a concurrent environment edit during validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-private-env-conflict-'));
  roots.push(root);
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'OWNER_SETTING=original\n');
  assert.throws(() => updatePrivateAccessSettings({
    envFile, origin: 'https://raven.example.test', username: 'owner', passwordHash: fakePasswordHash,
    validateCandidate: () => writeFileSync(envFile, 'OWNER_SETTING=concurrent-edit\n'),
  }), /changed during validation/);
  assert.equal(readFileSync(envFile, 'utf8'), 'OWNER_SETTING=concurrent-edit\n');
});
