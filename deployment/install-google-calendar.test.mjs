import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, test } from 'node:test';
import { installGoogleCalendar } from './install-google-calendar.mjs';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const seedDir = fileURLToPath(new URL('./seeds/library/', import.meta.url));
const roots = [];
const definitions = [
  'mcps/google-calendar.json',
  'skills/productivity/scheduling/calendar/config.json',
  'skills/productivity/scheduling/calendar/skill.md',
];
const credentials = {
  client_id: 'fake-client.apps.googleusercontent.com',
  client_secret: 'fake-client-secret',
  refresh_token: 'fake-refresh-token',
  type: 'authorized_user',
};
const defaultAgent = `# Owner comment
name: raven
displayName: Owner Raven
description: Owner fields stay intact
isDefault: true
skills:
  - ticktick
model: sonnet
maxTurns: 20
ownerField:
  enabled: true
`;
const legacyDefinitions = {
  'skills/productivity/scheduling/calendar/config.json': `{
  "name": "calendar",
  "displayName": "Google Calendar",
  "description": "View, create, and manage Google Calendar events via the gws CLI",
  "mcps": [],
  "vendorSkills": [],
  "tools": ["Bash", "Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 15,
  "actions": [
    { "name": "calendar:read-calendar", "description": "View calendar events and agenda", "defaultTier": "green", "reversible": true },
    { "name": "calendar:create-event", "description": "Create a calendar event", "defaultTier": "yellow", "reversible": true },
    { "name": "calendar:modify-event", "description": "Update or delete a calendar event", "defaultTier": "yellow", "reversible": true }
  ]
}
`,
  'skills/productivity/scheduling/calendar/skill.md': `You are a Google Calendar agent within Raven personal assistant.

You have direct access to the \`gws\` CLI (Google Workspace CLI) via Bash.
Run commands with \`--format json\` for structured output.

## Common Patterns

View today's agenda: \`gws calendar +agenda --today --format json\`
View upcoming events: \`gws calendar +agenda --format json\`
Create event: \`gws calendar +insert --summary 'Meeting' --start '2026-03-20T10:00:00-05:00' --end '2026-03-20T11:00:00-05:00' --meet --format json\`
Get event details: \`gws calendar events get --params '{"calendarId":"primary","eventId":"<id>"}' --format json\`
Update event: \`gws calendar events patch --params '{"calendarId":"primary","eventId":"<id>"}' --json '{"summary":"Updated"}' --format json\`
Delete event: \`gws calendar events delete --params '{"calendarId":"primary","eventId":"<id>"}' --format json\`

## Multi-Account Support

**Primary account** (default): No env var needed.
**Secondary account**: Prefix commands with:
  \`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_SECONDARY_CREDENTIALS_FILE gws ...\`

## Important

- Always use \`--format json\` for machine-readable output
- For calendar queries, include timezone when available
- When creating events, confirm details before executing
- Use \`--dry-run\` for destructive operations when unsure
- Parse JSON output and summarize results concisely
- If a command fails, try \`gws calendar <command> --help\` to check correct flags
`,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-install-google-calendar-'));
  roots.push(root);
  const libraryRoot = join(root, 'library');
  const projectsRoot = join(root, 'projects');
  const dataRoot = join(root, 'data');
  mkdirSync(libraryRoot);
  mkdirSync(dataRoot);
  write(projectsRoot, 'agents/raven/agent.yaml', defaultAgent);
  return { root, libraryRoot, projectsRoot, dataRoot };
}

function write(root, relativePath, content, options) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, options);
}

function seed(relativePath) {
  return readFileSync(join(seedDir, relativePath));
}

function credentialInput(overrides = {}) {
  return JSON.stringify({ ...credentials, ...overrides });
}

function install(f, options = {}) {
  return installGoogleCalendar({
    ...f,
    seedDir,
    credentialsInput: credentialInput(),
    commitFiles: () => {},
    ...options,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('installs only canonical definitions, normalized credentials, and an explicit default binding', () => {
  const f = fixture();
  write(f.libraryRoot, 'owner/keep.txt', 'owner data\n');
  const commits = [];
  const result = install(f, {
    bindDefault: true,
    credentialsInput: credentialInput({
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_uri: 'https://attacker.invalid/authorize',
      private_key: 'discard-me',
    }),
    commitFiles: (paths) => commits.push(paths),
  });

  assert.deepEqual(result, {
    checked: true,
    installed: definitions,
    credentialsUpdated: true,
    defaultBound: true,
  });
  for (const path of definitions) {
    assert.deepEqual(readFileSync(join(f.libraryRoot, path)), seed(path));
  }
  assert.equal(readFileSync(join(f.libraryRoot, 'owner/keep.txt'), 'utf8'), 'owner data\n');
  const stored = JSON.parse(
    readFileSync(join(f.dataRoot, 'google-calendar/credentials.json'), 'utf8'),
  );
  assert.deepEqual(stored, credentials);
  assert.equal(
    lstatSync(join(f.dataRoot, 'google-calendar/credentials.json')).mode & 0o777,
    0o600,
  );
  const agent = parse(readFileSync(join(f.projectsRoot, 'agents/raven/agent.yaml'), 'utf8'));
  assert.deepEqual(agent.skills, ['ticktick', 'calendar']);
  assert.deepEqual(agent.ownerField, { enabled: true });
  assert.match(
    readFileSync(join(f.projectsRoot, 'agents/raven/agent.yaml'), 'utf8'),
    /Owner comment/,
  );
  assert.deepEqual(commits, [
    [...definitions.map((path) => join('library', path)), 'projects/agents/raven/agent.yaml'],
  ]);
  assert(commits[0].every((path) => !path.startsWith('config/')));
});

test('upgrades only the exact previously shipped checkout definitions', () => {
  const f = fixture();
  for (const [path, content] of Object.entries(legacyDefinitions))
    write(f.libraryRoot, path, content);
  assert.equal(
    createHash('sha256')
      .update(legacyDefinitions['skills/productivity/scheduling/calendar/config.json'])
      .digest('hex'),
    '1f86eca17d9abdfd7b275a565c0ed57ada3d13ee4e4c45519f67a1d37fba10c1',
  );
  assert.equal(
    createHash('sha256')
      .update(legacyDefinitions['skills/productivity/scheduling/calendar/skill.md'])
      .digest('hex'),
    '143a8fea500abdf76febb0bf83bf3a169d3869a3c66fbbb8d9b18ebcfe2f14b9',
  );

  const result = install(f);
  assert.deepEqual(result.installed, definitions);
  for (const path of definitions) {
    assert.deepEqual(readFileSync(join(f.libraryRoot, path)), seed(path));
  }
});

test('a customized definition prevents all writes and remains untouched', () => {
  const f = fixture();
  write(f.libraryRoot, definitions[0], '{"owner":"custom"}\n');

  assert.throws(() => install(f), /Refusing to overwrite customized Google Calendar definition/);
  assert.equal(readFileSync(join(f.libraryRoot, definitions[0]), 'utf8'), '{"owner":"custom"}\n');
  assert.throws(
    () => readFileSync(join(f.dataRoot, 'google-calendar/credentials.json')),
    /ENOENT/,
  );
  assert.throws(() => readFileSync(join(f.libraryRoot, definitions[1])), /ENOENT/);
});

test('credentials are validated before writes and unsafe endpoint fields never persist', () => {
  const invalid = [
    '{',
    credentialInput({ type: 'service_account' }),
    JSON.stringify({ ...credentials, refresh_token: '' }),
    JSON.stringify({ ...credentials, refresh_token: '   ' }),
    JSON.stringify({ ...credentials, client_secret: 'secret\nvalue' }),
    credentialInput({ token_uri: 'https://attacker.invalid/token' }),
    credentialInput({ token_endpoint: 'http://oauth2.googleapis.com/token' }),
    Buffer.alloc(64 * 1024 + 1, 'x'),
  ];
  for (const input of invalid) {
    const f = fixture();
    assert.throws(() => install(f, { credentialsInput: input }));
    assert.throws(
      () => readFileSync(join(f.dataRoot, 'google-calendar/credentials.json')),
      /ENOENT/,
    );
    assert.throws(() => readFileSync(join(f.libraryRoot, definitions[0])), /ENOENT/);
  }
});

test('retries are idempotent and binding remains opt-in', () => {
  const f = fixture();
  const originalAgent = readFileSync(join(f.projectsRoot, 'agents/raven/agent.yaml'), 'utf8');
  const firstCommits = [];
  const first = install(f, { commitFiles: (paths) => firstCommits.push(paths) });
  assert.equal(first.defaultBound, false);
  assert.equal(
    readFileSync(join(f.projectsRoot, 'agents/raven/agent.yaml'), 'utf8'),
    originalAgent,
  );
  assert.deepEqual(firstCommits, [definitions.map((path) => join('library', path))]);

  const retryCommits = [];
  const retry = install(f, { commitFiles: (paths) => retryCommits.push(paths) });
  assert.deepEqual(retry, {
    checked: true,
    installed: [],
    credentialsUpdated: false,
    defaultBound: false,
  });
  assert.deepEqual(retryCommits, []);
});

test('symlinked and oversized paths are rejected without touching referents', () => {
  const targetFixture = fixture();
  const outside = join(targetFixture.root, 'outside.json');
  writeFileSync(outside, '{"outside":true}\n');
  mkdirSync(join(targetFixture.libraryRoot, 'mcps'));
  symlinkSync(outside, join(targetFixture.libraryRoot, definitions[0]));
  assert.throws(() => install(targetFixture), /regular file/);
  assert.equal(readFileSync(outside, 'utf8'), '{"outside":true}\n');

  const credentialFixture = fixture();
  mkdirSync(join(credentialFixture.dataRoot, 'google-calendar'));
  symlinkSync(outside, join(credentialFixture.dataRoot, 'google-calendar/credentials.json'));
  assert.throws(() => install(credentialFixture), /regular file/);
  assert.equal(readFileSync(outside, 'utf8'), '{"outside":true}\n');

  const oversizedFixture = fixture();
  write(oversizedFixture.libraryRoot, definitions[0], 'x'.repeat(64 * 1024 + 1));
  assert.throws(() => install(oversizedFixture), /exceeds 64 KiB/);
});

test('check-only validates copied seeds without credentials or mutations', () => {
  const f = fixture();
  assert.deepEqual(
    installGoogleCalendar({
      ...f,
      seedDir,
      checkOnly: true,
    }),
    { checked: true, installed: [], credentialsUpdated: false, defaultBound: false },
  );
  assert.throws(() => readFileSync(join(f.libraryRoot, definitions[0])), /ENOENT/);

  const copiedSeeds = join(f.root, 'seeds');
  cpSync(seedDir, copiedSeeds, { recursive: true });
  const mcpPath = join(copiedSeeds, definitions[0]);
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  mcp.args = ['unsafe.js'];
  writeFileSync(mcpPath, JSON.stringify(mcp));
  assert.throws(
    () => installGoogleCalendar({ ...f, seedDir: copiedSeeds, checkOnly: true }),
    /read-only adapter/,
  );
});

test('real Git commit preserves unrelated staged work and refuses a dirty agent target', (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('restricted runner does not allow child Git processes');
      return;
    }
    throw error;
  }

  const savedGitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')),
  );
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const initializeGit = (f) => {
      const git = (...args) =>
        execFileSync('git', ['-C', f.root, ...args], {
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();
      git('init');
      git('config', 'user.name', 'Raven test');
      git('config', 'user.email', 'raven-test@example.invalid');
      writeFileSync(join(f.root, 'owner.txt'), 'initial owner content');
      git('add', '.');
      git('commit', '-m', 'Initial fixture');
      return git;
    };

    const clean = fixture();
    let git;
    try {
      git = initializeGit(clean);
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('restricted runner does not allow Git fixture writes');
        return;
      }
      throw error;
    }
    writeFileSync(join(clean.root, 'owner.txt'), 'staged owner work');
    git('add', 'owner.txt');
    installGoogleCalendar({
      ...clean,
      seedDir,
      credentialsInput: credentialInput(),
      bindDefault: true,
    });
    assert.deepEqual(
      new Set(git('show', '--format=', '--name-only', 'HEAD').split('\n')),
      new Set([
        ...definitions.map((path) => join('library', path)),
        'projects/agents/raven/agent.yaml',
      ]),
    );
    assert.equal(git('diff', '--cached', '--name-only'), 'owner.txt');
    assert.equal(git('show', 'HEAD:owner.txt'), 'initial owner content');
    assert.throws(() => git('show', 'HEAD:config/google-calendar/credentials.json'));

    const dirty = fixture();
    const dirtyGit = initializeGit(dirty);
    const agentPath = join(dirty.projectsRoot, 'agents/raven/agent.yaml');
    writeFileSync(agentPath, `${readFileSync(agentPath, 'utf8')}# owner edit\n`);
    assert.throws(
      () =>
        installGoogleCalendar({
          ...dirty,
          seedDir,
          credentialsInput: credentialInput(),
          bindDefault: true,
        }),
      /dirty Google Calendar definition targets/,
    );
    assert.match(dirtyGit('status', '--short'), /projects\/agents\/raven\/agent.yaml/);
    assert.throws(
      () => readFileSync(join(dirty.dataRoot, 'google-calendar/credentials.json')),
      /ENOENT/,
    );
    assert.throws(() => readFileSync(join(dirty.libraryRoot, definitions[0])), /ENOENT/);

    const untracked = fixture();
    const untrackedGit = (...args) =>
      execFileSync('git', ['-C', untracked.root, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    untrackedGit('init');
    untrackedGit('config', 'user.name', 'Raven test');
    untrackedGit('config', 'user.email', 'raven-test@example.invalid');
    writeFileSync(join(untracked.root, 'owner.txt'), 'initial owner content');
    untrackedGit('add', 'owner.txt');
    untrackedGit('commit', '-m', 'Initial fixture');
    assert.throws(
      () =>
        installGoogleCalendar({
          ...untracked,
          seedDir,
          credentialsInput: credentialInput(),
          bindDefault: true,
        }),
      /dirty Google Calendar definition targets/,
    );
    assert.match(
      untrackedGit('status', '--short', '--untracked-files=all'),
      /projects\/agents\/raven\/agent.yaml/,
    );
    assert.throws(
      () => readFileSync(join(untracked.dataRoot, 'google-calendar/credentials.json')),
      /ENOENT/,
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    Object.assign(process.env, savedGitEnv);
  }
});

function fakeCommand(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

test('standalone setup reuses .env credentials and never places secrets in command arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-calendar-setup-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  const log = join(root, 'commands.log');
  const captured = join(root, 'captured.json');
  const sourceCredentials = join(root, 'exported.json');
  writeFileSync(sourceCredentials, credentialInput());
  const envFile = join(root, '.env');
  writeFileSync(envFile, `GWS_PRIMARY_CREDENTIALS_FILE=${sourceCredentials}\n`);
  fakeCommand(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_COMMAND_LOG"
if [[ " $* " == *" run "* ]]; then cat > "$RAVEN_TEST_CAPTURE"; fi
`,
  );

  const result = spawnSync('bash', [join(repository, 'scripts/setup-google-calendar.sh')], {
    cwd: repository,
    input: '\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RAVEN_ENV_FILE: envFile,
      RAVEN_TEST_COMMAND_LOG: log,
      RAVEN_TEST_CAPTURE: captured,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(captured, 'utf8'), credentialInput());
  const commands = readFileSync(log, 'utf8');
  assert.match(commands, /compose --env-file .* build raven-core/);
  assert.match(commands, /compose --env-file .* ps --status running --services/);
  assert.match(
    commands,
    /run --rm --no-deps -T raven-core node deployment\/install-google-calendar\.mjs --bind-default/,
  );
  assert(!commands.includes(credentials.client_secret));
  assert(!`${result.stdout}${result.stderr}`.includes(credentials.client_secret));
});

test('standalone setup obtains only Calendar read-only scope and removes its temporary export', () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-calendar-gws-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  const tempRoot = join(root, 'tmp');
  mkdirSync(fakeBin);
  mkdirSync(tempRoot);
  const dockerLog = join(root, 'docker.log');
  const gwsLog = join(root, 'gws.log');
  const captured = join(root, 'captured.json');
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'RAVEN_TIMEZONE=UTC\n');
  fakeCommand(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_COMMAND_LOG"
if [[ " $* " == *" run "* ]]; then cat > "$RAVEN_TEST_CAPTURE"; fi
`,
  );
  fakeCommand(
    join(fakeBin, 'gws'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_GWS_LOG"
if [[ "$1 $2" == "auth export" ]]; then printf '%s' "$RAVEN_TEST_CREDENTIALS"; fi
`,
  );

  const result = spawnSync('bash', [join(repository, 'scripts/setup-google-calendar.sh')], {
    cwd: repository,
    input: '\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TMPDIR: tempRoot,
      RAVEN_ENV_FILE: envFile,
      RAVEN_TEST_COMMAND_LOG: dockerLog,
      RAVEN_TEST_GWS_LOG: gwsLog,
      RAVEN_TEST_CAPTURE: captured,
      RAVEN_TEST_CREDENTIALS: credentialInput(),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(captured, 'utf8'), credentialInput());
  assert.match(
    readFileSync(gwsLog, 'utf8'),
    /^auth login --scopes https:\/\/www\.googleapis\.com\/auth\/calendar\.calendarlist\.readonly,https:\/\/www\.googleapis\.com\/auth\/calendar\.events\.readonly\nauth export --unmasked\n$/,
  );
  assert.deepEqual(readdirSync(tempRoot), []);
  assert(!`${result.stdout}${result.stderr}`.includes(credentials.refresh_token));
});

test('standalone setup login choice reconnects instead of reusing configured credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-calendar-reconnect-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  const tempRoot = join(root, 'tmp');
  mkdirSync(fakeBin);
  mkdirSync(tempRoot);
  const dockerLog = join(root, 'docker.log');
  const gwsLog = join(root, 'gws.log');
  const captured = join(root, 'captured.json');
  const configuredCredentials = join(root, 'configured.json');
  writeFileSync(configuredCredentials, credentialInput({ refresh_token: 'stale-token' }));
  const envFile = join(root, '.env');
  writeFileSync(envFile, `GWS_PRIMARY_CREDENTIALS_FILE=${configuredCredentials}\n`);
  fakeCommand(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_COMMAND_LOG"
if [[ " $* " == *" run "* ]]; then cat > "$RAVEN_TEST_CAPTURE"; fi
`,
  );
  fakeCommand(
    join(fakeBin, 'gws'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_GWS_LOG"
if [[ "$1 $2" == "auth export" ]]; then printf '%s' "$RAVEN_TEST_CREDENTIALS"; fi
`,
  );

  const result = spawnSync('bash', [join(repository, 'scripts/setup-google-calendar.sh')], {
    cwd: repository,
    input: 'login\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TMPDIR: tempRoot,
      RAVEN_ENV_FILE: envFile,
      RAVEN_TEST_COMMAND_LOG: dockerLog,
      RAVEN_TEST_GWS_LOG: gwsLog,
      RAVEN_TEST_CAPTURE: captured,
      RAVEN_TEST_CREDENTIALS: credentialInput({ refresh_token: 'fresh-token' }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(captured, 'utf8')).refresh_token, 'fresh-token');
  assert.match(
    readFileSync(gwsLog, 'utf8'),
    /^auth login --scopes https:\/\/www\.googleapis\.com\/auth\/calendar\.calendarlist\.readonly,https:\/\/www\.googleapis\.com\/auth\/calendar\.events\.readonly\nauth export --unmasked\n$/,
  );
  assert.deepEqual(readdirSync(tempRoot), []);
  assert(!readFileSync(captured, 'utf8').includes('stale-token'));
});

test('standalone setup refuses a running stack before prompting, auth, export, or build', () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-calendar-running-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  const dockerLog = join(root, 'docker.log');
  const gwsLog = join(root, 'gws.log');
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'RAVEN_TIMEZONE=UTC\n');
  fakeCommand(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_COMMAND_LOG"
if [[ " $* " == *" ps --status running --services "* ]]; then echo raven-core; fi
`,
  );
  fakeCommand(
    join(fakeBin, 'gws'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RAVEN_TEST_GWS_LOG"
`,
  );

  const result = spawnSync('bash', [join(repository, 'scripts/setup-google-calendar.sh')], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RAVEN_ENV_FILE: envFile,
      RAVEN_TEST_COMMAND_LOG: dockerLog,
      RAVEN_TEST_GWS_LOG: gwsLog,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stop Raven before configuring Google Calendar/);
  const commands = readFileSync(dockerLog, 'utf8');
  assert.match(commands, /config --quiet/);
  assert.match(commands, /ps --status running --services/);
  assert(!commands.includes('build raven-core'));
  assert(!commands.includes(' run '));
  assert.throws(() => readFileSync(gwsLog), /ENOENT/);
});
