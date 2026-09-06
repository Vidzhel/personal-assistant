import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import yaml from 'js-yaml';
import { gitAutoCommit } from '../packages/shared/src/utils/git-commit.ts';
import { initializeRuntime } from './runtime-init.mjs';
import { installGoogleCalendar } from './install-google-calendar.mjs';

// This standalone process deliberately exercises real Git, outside Vitest's
// composition safety mock. Never inherit credentials, hooks or owner Git paths.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const temporaryRoots = [];
const seedRoot = fileURLToPath(new URL('./seeds/', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-runtime-init-'));
  temporaryRoots.push(root);
  return root;
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('fresh capabilities are explicit and match their canonical library files', () => {
  const relative = 'library/skills/system/repository-work';
  for (const filename of ['config.json', 'skill.md']) {
    assert.equal(
      readFileSync(join(seedRoot, relative, filename), 'utf8'),
      readFileSync(new URL(`../${relative}/${filename}`, import.meta.url), 'utf8'),
      `Public deployment seed differs from its canonical workflow: ${filename}`,
    );
  }
  const skill = JSON.parse(readFileSync(join(seedRoot, relative, 'config.json'), 'utf8'));
  assert.deepEqual(skill.mcps, []);
  assert.deepEqual(skill.vendorSkills, []);
  assert.deepEqual([...skill.tools].sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  const agent = yaml.load(readFileSync(join(seedRoot, 'projects/agents/raven/agent.yaml'), 'utf8'));
  assert.deepEqual(agent.skills, ['repository-work', 'ticktick']);

  const ticktickFiles = [
    'mcps/ticktick.json',
    'skills/productivity/task-management/ticktick/config.json',
    'skills/productivity/task-management/ticktick/skill.md',
  ];
  for (const file of ticktickFiles) {
    assert.equal(
      readFileSync(join(seedRoot, 'library', file), 'utf8'),
      readFileSync(new URL(`../library/${file}`, import.meta.url), 'utf8'),
      `Public TickTick seed differs from its canonical file: ${file}`,
    );
  }
  const mcp = JSON.parse(readFileSync(join(seedRoot, 'library/mcps/ticktick.json'), 'utf8'));
  assert.deepEqual(mcp, {
    name: 'ticktick',
    displayName: 'TickTick',
    type: 'http',
    url: 'https://mcp.ticktick.com',
    headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
  });
  const ticktick = JSON.parse(
    readFileSync(
      join(seedRoot, 'library/skills/productivity/task-management/ticktick/config.json'),
      'utf8',
    ),
  );
  const toolsByTier = {
    green: [
      'search_task',
      'get_user_preference',
      'get_task_by_id',
      'list_undone_tasks_by_time_query',
      'list_undone_tasks_by_date',
      'list_completed_tasks_by_date',
      'filter_tasks',
      'list_projects',
      'get_project_by_id',
      'get_project_with_undone_tasks',
      'get_task_in_project',
      'list_columns',
      'list_project_groups',
      'get_comment',
      'list_project_members',
      'list_tags',
      'list_habits',
      'list_habit_sections',
      'get_habit',
      'get_habit_checkins',
      'get_focuses_by_time',
      'get_focus',
      'list_countdowns',
    ],
    yellow: [
      'create_project',
      'update_project',
      'create_column',
      'update_column',
      'create_project_group',
      'update_project_group',
      'create_task',
      'batch_add_tasks',
      'complete_task',
      'complete_tasks_in_project',
      'update_task',
      'move_task',
      'batch_update_tasks',
      'add_comment',
      'assign_task',
      'unassign_task',
      'create_tag',
      'create_habit',
      'update_habit',
      'upsert_habit_checkins',
      'create_focus',
    ],
    red: ['delete_project_group', 'delete_task', 'delete_comment', 'delete_focus'],
  };
  for (const [tier, tools] of Object.entries(toolsByTier)) {
    assert.deepEqual(
      ticktick.actions
        .filter((action) => action.defaultTier === tier)
        .map((action) => action.name)
        .sort(),
      tools.map((tool) => `ticktick:${tool.replaceAll('_', '-')}`).sort(),
    );
  }
  assert.equal(ticktick.actions.length, 48);
  assert.equal(new Set(ticktick.actions.map((action) => action.name)).size, 48);
  const instructions = readFileSync(
    join(seedRoot, 'library/skills/productivity/task-management/ticktick/skill.md'),
    'utf8',
  );
  for (const required of [
    'Inspect the live tool schemas',
    'get_project_with_undone_tasks',
    'tasks without dates',
    '14-day date range',
    'read the affected record',
    'inspect TickTick before retrying',
    'partial result',
    "owner's configured timezone",
  ]) {
    assert(instructions.includes(required), `TickTick workflow is missing: ${required}`);
  }
});

test('fresh image restart reconnects real history and preserves definitions and memory', async () => {
  const root = fixture();
  const initial = initializeRuntime({ root });
  const seededFiles = [
    'config/.gitkeep',
    'library/mcps/.gitkeep',
    'library/mcps/google-calendar.json',
    'library/mcps/ticktick.json',
    'library/skills/_index.md',
    'library/skills/productivity/_index.md',
    'library/skills/productivity/scheduling/calendar/config.json',
    'library/skills/productivity/scheduling/calendar/skill.md',
    'library/skills/productivity/task-management/_index.md',
    'library/skills/productivity/task-management/ticktick/config.json',
    'library/skills/productivity/task-management/ticktick/skill.md',
    'library/skills/system/repository-work/config.json',
    'library/skills/system/repository-work/skill.md',
    'projects/agents/raven/agent.yaml',
    'projects/telegram-default/context.md',
  ];
  assert.deepEqual(initial.seededFiles.sort(), seededFiles);
  for (const file of seededFiles) {
    assert.equal(
      readFileSync(join(root, file), 'utf8'),
      readFileSync(join(seedRoot, file), 'utf8'),
    );
  }
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(root, 'rev-parse', '--absolute-git-dir'), initial.historyDir);

  const definition = 'projects/agents/raven/agent.yaml';
  const updatedDefinition = `${readFileSync(join(root, definition), 'utf8')}# Owner customization\n`;
  writeFileSync(join(root, definition), updatedDefinition);
  const memory = 'projects/system/memory/preference.md';
  mkdirSync(join(root, 'projects/system/memory'), { recursive: true });
  writeFileSync(join(root, memory), 'Prefer brief, concrete updates.\n');
  const unrelated = 'config/unrelated.json';
  writeFileSync(join(root, unrelated), '{"pending":true}\n');
  git(root, 'add', '--', unrelated);

  await gitAutoCommit([definition, memory], 'Record tested definition and memory', root);
  assert.deepEqual(
    git(root, 'show', '--pretty=', '--name-only', 'HEAD').split('\n').sort(),
    [definition, memory].sort(),
  );
  assert.equal(git(root, 'diff', '--cached', '--name-only'), unrelated);
  const head = git(root, 'rev-parse', 'HEAD');
  rmSync(join(root, '.git'));
  const restarted = initializeRuntime({ root });
  assert.deepEqual(restarted.seededFiles, []);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(root, definition), 'utf8'), updatedDefinition);
  assert.equal(readFileSync(join(root, memory), 'utf8'), 'Prefer brief, concrete updates.\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), unrelated);
  writeFileSync(join(root, 'data/credential-sentinel'), 'do not track');
  assert.equal(git(root, 'check-ignore', 'data/credential-sentinel'), 'data/credential-sentinel');
});

test('repopulating an empty definition volume with unchanged seeds does not fail or create a commit', () => {
  const root = fixture();
  initializeRuntime({ root });
  const head = git(root, 'rev-parse', 'HEAD');
  rmSync(join(root, 'projects'), { recursive: true });
  mkdirSync(join(root, 'projects'));
  assert(initializeRuntime({ root }).seededFiles.length > 0);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});

test('nonempty definition roots are not merged with starter files', () => {
  const root = fixture();
  for (const name of ['projects', 'library', 'config']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'owner-sentinel'), `${name}\n`);
  }
  assert.deepEqual(initializeRuntime({ root }).seededFiles, []);
  for (const name of ['projects', 'library', 'config']) {
    assert.deepEqual(readdirSync(join(root, name)), ['owner-sentinel']);
    assert.equal(readFileSync(join(root, name, 'owner-sentinel'), 'utf8'), `${name}\n`);
  }
});

test('an existing source checkout is rejected before creating deployment roots', () => {
  const root = fixture();
  git(root, 'init');
  assert.throws(() => initializeRuntime({ root }), /existing checkout/);
  assert.deepEqual(readdirSync(root), ['.git']);
});

test('symlinked persisted roots cannot mutate another directory', () => {
  const root = fixture();
  const outside = fixture();
  writeFileSync(join(outside, 'sentinel'), 'unchanged');
  symlinkSync(outside, join(root, 'projects'), 'dir');
  assert.throws(() => initializeRuntime({ root }), /real directory/);
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'unchanged');
  assert.equal(existsSync(join(root, '.git')), false);
});

test('unrecognized persisted metadata fails before seeding or writing the Git pointer', () => {
  const root = fixture();
  const history = join(root, 'data/definition-history');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'sentinel'), 'not a Git repository');
  assert.throws(() => initializeRuntime({ root }));
  assert.deepEqual(readdirSync(history), ['sentinel']);
  assert.deepEqual(readdirSync(join(root, 'projects')), []);
  assert.equal(existsSync(join(root, '.git')), false);
});

test('a dangling Git pointer symlink is rejected before any initialization', () => {
  const root = fixture();
  const outside = fixture();
  symlinkSync(join(outside, 'missing-history'), join(root, '.git'));
  assert.throws(() => initializeRuntime({ root }), /existing checkout/);
  assert.deepEqual(readdirSync(root), ['.git']);
  assert.deepEqual(readdirSync(outside), []);
});

function interruptFirstCommit(root) {
  const hooks = join(root, 'test-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  // An explicitly temporary hook models a failed commit after seed copying.
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_0 = hooks;
  try {
    assert.throws(() => initializeRuntime({ root }));
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  }
}

test('unfinished bootstrap resumes original files and commits them before startup succeeds', () => {
  const root = fixture();
  interruptFirstCommit(root);
  const journalPath = join(root, 'data/definition-history/raven-bootstrap.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert(journal.files.length > 0);
  const missingFile = journal.files[0].path;
  rmSync(join(root, missingFile)); // Also exercise an interrupted copy, with one missing seed.
  const recovered = initializeRuntime({ root });
  assert.equal(recovered.seededFiles.length, journal.files.length);
  assert.equal(existsSync(journalPath), false);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
  for (const entry of journal.files) {
    assert.equal(
      git(root, 'show', `HEAD:${entry.path}`),
      readFileSync(join(root, entry.path), 'utf8').trim(),
    );
  }
});

test('unfinished bootstrap never overwrites a customized seed on retry', () => {
  const root = fixture();
  interruptFirstCommit(root);
  const agentPath = join(root, 'projects/agents/raven/agent.yaml');
  writeFileSync(agentPath, '# Customized during recovery\n');
  assert.throws(() => initializeRuntime({ root }), /differs from the original seed/);
  assert.equal(readFileSync(agentPath, 'utf8'), '# Customized during recovery\n');
  assert.equal(existsSync(join(root, 'data/definition-history/raven-bootstrap.json')), true);
});

test('Calendar setup keeps refresh credentials outside runtime Git history', () => {
  const root = fixture();
  initializeRuntime({ root });
  installGoogleCalendar({
    root,
    credentialsInput: JSON.stringify({
      type: 'authorized_user',
      client_id: 'fake-client',
      client_secret: 'fake-secret',
      refresh_token: 'fake-refresh',
    }),
    bindDefault: true,
  });
  const credentialPath = 'data/google-calendar/credentials.json';
  assert(existsSync(join(root, credentialPath)));
  assert.equal(git(root, 'check-ignore', credentialPath), credentialPath);
  assert.equal(git(root, 'ls-files', credentialPath), '');
  const agent = yaml.load(readFileSync(join(root, 'projects/agents/raven/agent.yaml'), 'utf8'));
  assert(agent.skills.includes('calendar'));
});
