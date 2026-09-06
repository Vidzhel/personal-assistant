import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { installTicktick } from './install-ticktick.mjs';

const seedDir = fileURLToPath(new URL('./seeds/library/', import.meta.url));
const roots = [];
const definitions = [
  'mcps/ticktick.json',
  'skills/productivity/task-management/ticktick/config.json',
  'skills/productivity/task-management/ticktick/skill.md',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-install-ticktick-'));
  roots.push(root);
  const libraryRoot = join(root, 'library');
  mkdirSync(libraryRoot);
  return { root, libraryRoot };
}

function write(libraryRoot, relativePath, content) {
  const path = join(libraryRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function seed(relativePath) {
  return readFileSync(new URL(`./seeds/library/${relativePath}`, import.meta.url), 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('installs only the official TickTick files and missing parent indexes', () => {
  const { root, libraryRoot } = fixture();
  write(libraryRoot, 'owner/keep.txt', 'owner data\n');
  const commits = [];
  const result = installTicktick({
    root,
    libraryRoot,
    seedDir,
    commitFiles: (paths) => commits.push(paths),
  });

  assert.deepEqual(result.installed.sort(), [
    ...definitions,
    'skills/productivity/_index.md',
    'skills/productivity/task-management/_index.md',
  ].sort());
  for (const path of definitions) assert.equal(readFileSync(join(libraryRoot, path), 'utf8'), seed(path));
  assert.equal(readFileSync(join(libraryRoot, 'owner/keep.txt'), 'utf8'), 'owner data\n');
  assert.equal(commits.length, 1);
  assert.deepEqual(new Set(commits[0]), new Set([...definitions, 'skills/productivity/_index.md', 'skills/productivity/task-management/_index.md']));
});

test('upgrades exact shipped legacy definitions and preserves owner indexes', () => {
  const { root, libraryRoot } = fixture();
  const legacy = {
    'mcps/ticktick.json': `{
  "name": "ticktick",
  "displayName": "TickTick",
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-ticktick/src/index.ts"],
  "env": {
    "TICKTICK_CLIENT_ID": "\${TICKTICK_CLIENT_ID}",
    "TICKTICK_CLIENT_SECRET": "\${TICKTICK_CLIENT_SECRET}",
    "TICKTICK_ACCESS_TOKEN": "\${TICKTICK_ACCESS_TOKEN}"
  }
}
`,
    'skills/productivity/task-management/ticktick/config.json': `{
  "name": "ticktick",
  "displayName": "TickTick",
  "description": "Manages tasks, projects, and lists in TickTick",
  "mcps": ["ticktick"],
  "vendorSkills": [],
  "tools": ["Read", "Grep"],
  "model": "sonnet",
  "maxTurns": 10,
  "actions": [
    { "name": "ticktick:get-tasks", "description": "Retrieve tasks and lists", "defaultTier": "green", "reversible": true },
    { "name": "ticktick:get-task-details", "description": "Get details of a specific task", "defaultTier": "green", "reversible": true },
    { "name": "ticktick:create-task", "description": "Create a new task", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:update-task", "description": "Update an existing task", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:complete-task", "description": "Mark a task as complete", "defaultTier": "yellow", "reversible": true },
    { "name": "ticktick:delete-task", "description": "Permanently delete a task", "defaultTier": "red", "reversible": false }
  ]
}
`,
    'skills/productivity/task-management/ticktick/skill.md': `You are a TickTick task management agent within Raven.
Use the available TickTick MCP tools to manage tasks, projects, and lists.
Be concise and return structured data.
`,
  };
  for (const [path, content] of Object.entries(legacy)) write(libraryRoot, path, content);
  write(libraryRoot, 'skills/productivity/_index.md', '# Owner productivity index\n');
  write(libraryRoot, 'skills/productivity/task-management/_index.md', '# Owner task index\n');

  const result = installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} });
  assert.deepEqual(result.preserved.sort(), [
    'skills/productivity/_index.md',
    'skills/productivity/task-management/_index.md',
  ]);
  assert.equal(readFileSync(join(libraryRoot, 'skills/productivity/_index.md'), 'utf8'), '# Owner productivity index\n');
  for (const path of definitions) assert.equal(readFileSync(join(libraryRoot, path), 'utf8'), seed(path));
});

test('upgrades the previously shipped official TickTick definitions but preserves custom edits', () => {
  const previousOfficial = {
    'mcps/ticktick.json': seed('mcps/ticktick.json'),
    'skills/productivity/task-management/ticktick/config.json': seed(
      'skills/productivity/task-management/ticktick/config.json',
    ).replace(
      '{ "name": "ticktick:list-project-members", "description": "List project members", "defaultTier": "green", "reversible": true }',
      '{ "name": "ticktick:project-member", "description": "Read project membership", "defaultTier": "green", "reversible": true }',
    ),
    'skills/productivity/task-management/ticktick/skill.md': seed(
      'skills/productivity/task-management/ticktick/skill.md',
    ).replace(' Use `list_project_members` when membership or assignment context matters.', ''),
  };

  const upgrade = fixture();
  for (const [path, content] of Object.entries(previousOfficial)) {
    write(upgrade.libraryRoot, path, content);
  }
  const checked = installTicktick({
    root: upgrade.root,
    libraryRoot: upgrade.libraryRoot,
    seedDir,
    checkOnly: true,
  });
  assert.equal(checked.checked, true);
  assert.equal(
    readFileSync(
      join(upgrade.libraryRoot, 'skills/productivity/task-management/ticktick/config.json'),
      'utf8',
    ),
    previousOfficial['skills/productivity/task-management/ticktick/config.json'],
  );
  const result = installTicktick({
    root: upgrade.root,
    libraryRoot: upgrade.libraryRoot,
    seedDir,
    commitFiles: () => {},
  });
  assert.deepEqual(result.installed.sort(), [
    'skills/productivity/task-management/ticktick/config.json',
    'skills/productivity/task-management/ticktick/skill.md',
    'skills/productivity/_index.md',
    'skills/productivity/task-management/_index.md',
  ].sort());
  for (const path of definitions) {
    assert.equal(readFileSync(join(upgrade.libraryRoot, path), 'utf8'), seed(path));
  }

  const customized = fixture();
  for (const [path, content] of Object.entries(previousOfficial)) {
    write(customized.libraryRoot, path, content);
  }
  write(
    customized.libraryRoot,
    'skills/productivity/task-management/ticktick/skill.md',
    `${previousOfficial['skills/productivity/task-management/ticktick/skill.md']}\nOwner instruction.\n`,
  );
  assert.throws(
    () =>
      installTicktick({
        root: customized.root,
        libraryRoot: customized.libraryRoot,
        seedDir,
        commitFiles: () => {},
      }),
    /Refusing to overwrite customized TickTick definition/,
  );
  assert.match(
    readFileSync(
      join(customized.libraryRoot, 'skills/productivity/task-management/ticktick/skill.md'),
      'utf8',
    ),
    /Owner instruction/,
  );
});

test('a customized TickTick definition prevents every write', () => {
  const { root, libraryRoot } = fixture();
  write(libraryRoot, definitions[0], '{"owner":"custom"}\n');
  write(libraryRoot, 'owner.txt', 'unchanged\n');

  assert.throws(
    () => installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} }),
    /Refusing to overwrite customized TickTick definition/,
  );
  assert.equal(readFileSync(join(libraryRoot, definitions[0]), 'utf8'), '{"owner":"custom"}\n');
  assert.equal(readFileSync(join(libraryRoot, 'owner.txt'), 'utf8'), 'unchanged\n');
  assert.throws(() => readFileSync(join(libraryRoot, definitions[1])), /ENOENT/);
});

test('check-only and a retry with partially installed official files are safe', () => {
  const { root, libraryRoot } = fixture();
  write(libraryRoot, definitions[0], seed(definitions[0]));
  const checked = installTicktick({ root, libraryRoot, seedDir, checkOnly: true });
  assert.equal(checked.checked, true);
  assert.throws(() => readFileSync(join(libraryRoot, definitions[1])), /ENOENT/);

  installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} });
  installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} });
  for (const path of definitions) assert.equal(readFileSync(join(libraryRoot, path), 'utf8'), seed(path));
});

test('symlinked TickTick targets are rejected without touching their referent', () => {
  const { root, libraryRoot } = fixture();
  const outside = join(root, 'outside');
  writeFileSync(outside, 'outside\n');
  mkdirSync(join(libraryRoot, 'mcps'));
  symlinkSync(outside, join(libraryRoot, definitions[0]));
  assert.throws(
    () => installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} }),
    /regular file/,
  );
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
});

test('invalid or oversized bundled seeds fail before any target write', () => {
  for (const mutate of [
    (copiedSeeds) => {
      const path = join(
        copiedSeeds,
        'skills/productivity/task-management/ticktick/config.json',
      );
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.actions.pop();
      writeFileSync(path, JSON.stringify(config));
    },
    (copiedSeeds) =>
      writeFileSync(join(copiedSeeds, 'mcps/ticktick.json'), 'x'.repeat(64 * 1024 + 1)),
  ]) {
    const { root, libraryRoot } = fixture();
    const copiedSeeds = join(root, 'seeds');
    cpSync(seedDir, copiedSeeds, { recursive: true });
    mutate(copiedSeeds);
    assert.throws(() =>
      installTicktick({ root, libraryRoot, seedDir: copiedSeeds, commitFiles: () => {} }),
    );
    assert.throws(() => readFileSync(join(libraryRoot, definitions[0])), /ENOENT/);
  }
});

test('oversized existing definitions are never read or overwritten', () => {
  const { root, libraryRoot } = fixture();
  write(libraryRoot, definitions[0], 'x'.repeat(64 * 1024 + 1));
  assert.throws(
    () => installTicktick({ root, libraryRoot, seedDir, commitFiles: () => {} }),
    /exceeds 64 KiB/,
  );
  assert.equal(readFileSync(join(libraryRoot, definitions[0]), 'utf8').length, 64 * 1024 + 1);
});


test('real Git commit includes only installed definitions and retry preserves staged owner work', () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const { root, libraryRoot } = fixture();
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Raven test');
  git('config', 'user.email', 'raven-test@example.invalid');
  writeFileSync(join(root, 'owner.txt'), 'initial owner content');
  git('add', 'owner.txt');
  git('commit', '-m', 'Initial fixture');
  writeFileSync(join(root, 'owner.txt'), 'staged owner work');
  git('add', 'owner.txt');
  installTicktick({ root, libraryRoot, seedDir });
  const committed = git('show', '--format=', '--name-only', 'HEAD').split('\n');
  assert.equal(committed.length, 5);
  assert(committed.every((path) => path.startsWith('library/')));
  assert.equal(git('diff', '--cached', '--name-only'), 'owner.txt');
  assert.equal(git('show', 'HEAD:owner.txt'), 'initial owner content');
  const first = git('rev-parse', 'HEAD');
  installTicktick({ root, libraryRoot, seedDir });
  assert.equal(git('rev-parse', 'HEAD'), first);
  assert.equal(git('diff', '--cached', '--name-only'), 'owner.txt');
});
