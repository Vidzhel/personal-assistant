import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SEEDS = fileURLToPath(new URL('./seeds/library/', import.meta.url));
const MAX_FILE_BYTES = 64 * 1024;
const LEGACY_HASHES = new Map([
  ['mcps/ticktick.json', 'dae6d5ebade3ab00731bfbf69ff1d9d1432941910e694b27b55aaa3579952dbf'],
  [
    'skills/productivity/task-management/ticktick/config.json',
    '1511f6e1aefa5f16f940779c5a27fc99787a56d2d2894e788024199e83e643fc',
  ],
  [
    'skills/productivity/task-management/ticktick/skill.md',
    '89274aae1261613f2f71354dac24bf72707597b71c8710e762573efc5d3df0ee',
  ],
]);
const DEFINITION_PATHS = [...LEGACY_HASHES.keys()];
const INDEX_PATHS = [
  'skills/productivity/_index.md',
  'skills/productivity/task-management/_index.md',
];
const TOOLS_BY_TIER = {
  green: [
    'search_task', 'get_task_by_id', 'list_undone_tasks_by_time_query',
    'list_undone_tasks_by_date', 'list_completed_tasks_by_date', 'filter_tasks',
    'list_projects', 'get_project_by_id', 'get_project_with_undone_tasks',
    'get_task_in_project', 'list_columns', 'list_project_groups', 'get_comment',
    'project_member', 'list_tags', 'list_habits', 'list_habit_sections', 'get_habit',
    'get_habit_checkins', 'get_focuses_by_time', 'get_focus', 'list_countdowns',
  ],
  yellow: [
    'create_project', 'update_project', 'create_column', 'update_column',
    'create_project_group', 'update_project_group', 'create_task', 'batch_add_tasks',
    'complete_task', 'complete_tasks_in_project', 'update_task', 'move_task',
    'batch_update_tasks', 'add_comment', 'assign_task', 'unassign_task', 'create_tag',
    'create_habit', 'update_habit', 'upsert_habit_checkins', 'create_focus',
  ],
  red: ['delete_project_group', 'delete_task', 'delete_comment', 'delete_focus'],
};

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFile(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds 64 KiB: ${path}`);
  return stat;
}

function readBoundedFile(path, label) {
  regularFile(path, label);
  return readFileSync(path);
}

function realDirectory(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

function inspectParents(libraryRoot, relativePath) {
  const parts = dirname(relativePath).split(sep);
  let current = libraryRoot;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`TickTick target parent must be a real directory: ${current}`);
    }
  }
}

function targetState(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { hash: null, mode: 0o644 };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`TickTick target must be a regular file: ${path}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`TickTick target exceeds 64 KiB: ${path}`);
  }
  return { hash: hashBytes(readFileSync(path)), mode: stat.mode & 0o777 };
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bundled ${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Bundled ${label} has unexpected fields`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Bundled ${label} is not valid JSON`);
  }
}

function validateMcp(bytes) {
  const mcp = parseJson(bytes, 'TickTick MCP definition');
  assertExactKeys(mcp, ['name', 'displayName', 'type', 'url', 'headers'], 'TickTick MCP definition');
  assertExactKeys(mcp.headers, ['Authorization'], 'TickTick MCP headers');
  if (
    mcp.name !== 'ticktick' ||
    mcp.displayName !== 'TickTick' ||
    mcp.type !== 'http' ||
    mcp.url !== 'https://mcp.ticktick.com' ||
    mcp.headers.Authorization !== 'Bearer ${TICKTICK_MCP_TOKEN}'
  ) {
    throw new Error('Bundled TickTick MCP definition does not select the official authenticated endpoint');
  }
}

function validateSkill(bytes) {
  const skill = parseJson(bytes, 'TickTick skill config');
  assertExactKeys(
    skill,
    ['name', 'displayName', 'description', 'mcps', 'vendorSkills', 'tools', 'model', 'maxTurns', 'actions'],
    'TickTick skill config',
  );
  if (
    skill?.name !== 'ticktick' ||
    skill.displayName !== 'TickTick' ||
    typeof skill.description !== 'string' ||
    skill.description.length === 0 ||
    !Array.isArray(skill.mcps) ||
    skill.mcps.length !== 1 ||
    skill.mcps[0] !== 'ticktick' ||
    !Array.isArray(skill.vendorSkills) ||
    skill.vendorSkills.length !== 0 ||
    !Array.isArray(skill.tools) ||
    skill.tools.join(',') !== 'Read,Grep' ||
    skill.model !== 'sonnet' ||
    skill.maxTurns !== 10 ||
    !Array.isArray(skill.actions) ||
    skill.actions.length !== 47
  ) {
    throw new Error('Bundled TickTick skill config has an invalid identity, MCP binding, or action count');
  }
  const expected = new Map(
    Object.entries(TOOLS_BY_TIER).flatMap(([tier, tools]) =>
      tools.map((tool) => [`ticktick:${tool.replaceAll('_', '-')}`, tier]),
    ),
  );
  for (const action of skill.actions) {
    assertExactKeys(
      action,
      ['name', 'description', 'defaultTier', 'reversible'],
      'TickTick action mapping',
    );
    if (
      !action ||
      typeof action.name !== 'string' ||
      typeof action.description !== 'string' ||
      action.description.length === 0 ||
      typeof action.reversible !== 'boolean' ||
      action.reversible !== (action.defaultTier !== 'red') ||
      expected.get(action.name) !== action.defaultTier
    ) {
      throw new Error('Bundled TickTick skill config does not match the official action catalog');
    }
    expected.delete(action.name);
  }
  if (expected.size > 0) {
    throw new Error('Bundled TickTick skill config is missing official action mappings');
  }
}

function loadAndValidateSeeds(seedDir) {
  const sources = new Map();
  for (const relativePath of [...INDEX_PATHS, ...DEFINITION_PATHS]) {
    sources.set(
      relativePath,
      readBoundedFile(join(seedDir, relativePath), 'Bundled TickTick seed'),
    );
  }
  validateMcp(sources.get('mcps/ticktick.json'));
  validateSkill(sources.get('skills/productivity/task-management/ticktick/config.json'));
  const instructions = sources
    .get('skills/productivity/task-management/ticktick/skill.md')
    .toString('utf8');
  for (const required of ['Inspect the live tool schemas', '14-day date range', 'inspect TickTick before retrying']) {
    if (!instructions.includes(required)) {
      throw new Error(`Bundled TickTick instructions are missing required workflow: ${required}`);
    }
  }
  return sources;
}

function planInstall(libraryRoot, seedDir) {
  realDirectory(libraryRoot, 'Library root');
  realDirectory(seedDir, 'TickTick seed root');
  const sources = loadAndValidateSeeds(seedDir);
  const plan = [];
  for (const relativePath of [...INDEX_PATHS, ...DEFINITION_PATHS]) {
    inspectParents(libraryRoot, relativePath);
    const source = sources.get(relativePath);
    const sourceHash = hashBytes(source);
    const targetPath = join(libraryRoot, relativePath);
    const current = targetState(targetPath);

    if (INDEX_PATHS.includes(relativePath) && current.hash !== null) {
      plan.push({ relativePath, source, sourceHash, current, operation: 'preserve' });
      continue;
    }
    if (current.hash === sourceHash) {
      plan.push({ relativePath, source, sourceHash, current, operation: 'unchanged' });
      continue;
    }
    const legacyHash = LEGACY_HASHES.get(relativePath);
    if (current.hash !== null && current.hash !== legacyHash) {
      throw new Error(
        `Refusing to overwrite customized TickTick definition: library/${relativePath}`,
      );
    }
    plan.push({ relativePath, source, sourceHash, current, operation: 'install' });
  }
  return plan;
}

function createParents(libraryRoot, relativePath) {
  const parts = dirname(relativePath).split(sep);
  let current = libraryRoot;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) mkdirSync(current, { mode: 0o755 });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`TickTick target parent must be a real directory: ${current}`);
    }
  }
}

function replaceAtomic(path, bytes, mode) {
  const temp = join(dirname(path), `.${String(process.pid)}.${Date.now()}.ticktick.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function commitInstalledFiles(root, relativePaths) {
  if (relativePaths.length === 0) return;
  const paths = relativePaths.map((path) => join('library', path));
  execFileSync('git', ['-C', root, 'add', '--', ...paths], { stdio: 'pipe' });
  try {
    execFileSync('git', ['-C', root, 'diff', '--cached', '--quiet', '--', ...paths], {
      stdio: 'pipe',
    });
    return;
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Install official TickTick capability',
      '--',
      ...paths,
    ],
    { stdio: 'pipe' },
  );
}

/** Install only the shipped TickTick definitions into a durable library volume. */
export function installTicktick({
  root = '/app',
  libraryRoot = join(root, 'library'),
  seedDir = DEFAULT_SEEDS,
  checkOnly = false,
  commitFiles = (paths) => commitInstalledFiles(root, paths),
} = {}) {
  libraryRoot = resolve(libraryRoot);
  seedDir = resolve(seedDir);
  const plan = planInstall(libraryRoot, seedDir);
  if (checkOnly) return { checked: true, installed: [], preserved: [] };

  const installed = [];
  const preserved = [];
  for (const entry of plan) {
    if (entry.operation === 'preserve') {
      preserved.push(entry.relativePath);
      continue;
    }
    if (entry.operation === 'unchanged') continue;
    createParents(libraryRoot, entry.relativePath);
    const targetPath = join(libraryRoot, entry.relativePath);
    if (targetState(targetPath).hash !== entry.current.hash) {
      throw new Error(`TickTick target changed during installation: library/${entry.relativePath}`);
    }
    replaceAtomic(targetPath, entry.source, entry.current.mode);
    installed.push(entry.relativePath);
  }

  const tracked = [
    ...DEFINITION_PATHS,
    ...INDEX_PATHS.filter((path) => !preserved.includes(path)),
  ];
  commitFiles(tracked);
  return { checked: true, installed, preserved };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check') || args.length > 1) {
    throw new Error('Usage: node deployment/install-ticktick.mjs [--check]');
  }
  const result = installTicktick({ checkOnly: args[0] === '--check' });
  console.log(
    args[0] === '--check'
      ? 'TickTick capability can be installed without overwriting owner definitions.'
      : `Official TickTick capability installed (${String(result.installed.length)} file updates).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
