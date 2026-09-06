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
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const DEFAULT_SEEDS = fileURLToPath(new URL('./seeds/library/', import.meta.url));
const MAX_FILE_BYTES = 64 * 1024;
const CANONICAL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFINITION_PATHS = [
  'mcps/google-calendar.json',
  'skills/productivity/scheduling/calendar/config.json',
  'skills/productivity/scheduling/calendar/skill.md',
];
const PREVIOUS_SHIPPED_HASHES = new Map([
  ['mcps/google-calendar.json', new Set()],
  [
    'skills/productivity/scheduling/calendar/config.json',
    new Set(['1f86eca17d9abdfd7b275a565c0ed57ada3d13ee4e4c45519f67a1d37fba10c1']),
  ],
  [
    'skills/productivity/scheduling/calendar/skill.md',
    new Set(['143a8fea500abdf76febb0bf83bf3a169d3869a3c66fbbb8d9b18ebcfe2f14b9']),
  ],
]);

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

function inspectParents(root, relativePath, label) {
  let current = root;
  for (const part of dirname(relativePath).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`${label} parent must be a real directory: ${current}`);
    }
  }
}

function createParents(root, relativePath, label) {
  let current = root;
  for (const part of dirname(relativePath).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) mkdirSync(current, { mode: 0o755 });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} parent must be a real directory: ${current}`);
    }
  }
}

function targetState(path, label, defaultMode) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { hash: null, mode: defaultMode };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds 64 KiB: ${path}`);
  return { hash: hashBytes(readFileSync(path)), mode: stat.mode & 0o777 };
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function replaceAtomic(path, bytes, mode) {
  const temp = join(dirname(path), `.${String(process.pid)}.${Date.now()}.google-calendar.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
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
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateMcp(bytes) {
  const mcp = parseJson(bytes, 'Bundled Google Calendar MCP definition');
  assertExactKeys(mcp, ['name', 'displayName', 'command', 'args', 'env'], 'Google Calendar MCP');
  assertExactKeys(mcp.env, ['GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE'], 'Google Calendar MCP env');
  if (
    mcp.name !== 'google-calendar' ||
    mcp.displayName !== 'Google Calendar (read-only)' ||
    mcp.command !== 'node' ||
    !Array.isArray(mcp.args) ||
    mcp.args.length !== 1 ||
    mcp.args[0] !== 'packages/core/dist/integrations/google-calendar/google-calendar-mcp.js' ||
    mcp.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE !== '${GOOGLE_CALENDAR_CREDENTIALS_FILE}'
  ) {
    throw new Error('Bundled Google Calendar MCP does not select the read-only adapter');
  }
}

function validateSkill(bytes) {
  const skill = parseJson(bytes, 'Bundled Google Calendar skill config');
  assertExactKeys(
    skill,
    [
      'name',
      'displayName',
      'description',
      'mcps',
      'vendorSkills',
      'tools',
      'model',
      'maxTurns',
      'actions',
    ],
    'Google Calendar skill config',
  );
  if (
    skill.name !== 'calendar' ||
    skill.displayName !== 'Google Calendar' ||
    typeof skill.description !== 'string' ||
    skill.description.length === 0 ||
    JSON.stringify(skill.mcps) !== '["google-calendar"]' ||
    JSON.stringify(skill.vendorSkills) !== '[]' ||
    JSON.stringify(skill.tools) !== '[]' ||
    skill.model !== 'sonnet' ||
    skill.maxTurns !== 30 ||
    !Array.isArray(skill.actions) ||
    skill.actions.length !== 2
  ) {
    throw new Error('Bundled Google Calendar skill has an invalid read-only binding');
  }
  const expected = new Set(['google-calendar:list-calendars', 'google-calendar:list-events']);
  for (const action of skill.actions) {
    assertExactKeys(
      action,
      ['name', 'description', 'defaultTier', 'reversible'],
      'Google Calendar action',
    );
    if (
      !expected.delete(action.name) ||
      typeof action.description !== 'string' ||
      action.description.length === 0 ||
      action.defaultTier !== 'green' ||
      action.reversible !== true
    ) {
      throw new Error('Bundled Google Calendar actions must remain read-only');
    }
  }
}

function loadAndValidateSeeds(seedDir) {
  const sources = new Map();
  for (const relativePath of DEFINITION_PATHS) {
    sources.set(
      relativePath,
      readBoundedFile(join(seedDir, relativePath), 'Bundled Google Calendar seed'),
    );
  }
  validateMcp(sources.get(DEFINITION_PATHS[0]));
  validateSkill(sources.get(DEFINITION_PATHS[1]));
  const instructions = sources.get(DEFINITION_PATHS[2]).toString('utf8');
  for (const required of [
    'read-only MCP tools',
    'list_calendars',
    'list_events',
    'partial coverage',
    'untrusted data',
  ]) {
    if (!instructions.includes(required)) {
      throw new Error(`Bundled Google Calendar instructions are missing: ${required}`);
    }
  }
  return sources;
}

function planDefinitions(libraryRoot, seedDir) {
  realDirectory(libraryRoot, 'Library root');
  realDirectory(seedDir, 'Google Calendar seed root');
  const sources = loadAndValidateSeeds(seedDir);
  return DEFINITION_PATHS.map((relativePath) => {
    inspectParents(libraryRoot, relativePath, 'Google Calendar target');
    const source = sources.get(relativePath);
    const sourceHash = hashBytes(source);
    const targetPath = join(libraryRoot, relativePath);
    const current = targetState(targetPath, 'Google Calendar target', 0o644);
    if (current.hash === sourceHash) {
      return { relativePath, source, current, operation: 'unchanged' };
    }
    if (current.hash !== null && !PREVIOUS_SHIPPED_HASHES.get(relativePath)?.has(current.hash)) {
      throw new Error(
        `Refusing to overwrite customized Google Calendar definition: library/${relativePath}`,
      );
    }
    return { relativePath, source, current, operation: 'install' };
  });
}

function normalizedCredentials(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    throw new Error('Google Calendar credentials must contain 1-65536 bytes');
  }
  const value = parseJson(bytes, 'Google Calendar credentials');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Google Calendar credentials must be a JSON object');
  }
  if (value.type !== 'authorized_user') {
    throw new Error('Google Calendar credentials must have type authorized_user');
  }
  for (const key of ['client_id', 'client_secret', 'refresh_token']) {
    if (
      typeof value[key] !== 'string' ||
      value[key].trim().length === 0 ||
      value[key].length > 16 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(value[key])
    ) {
      throw new Error(`Google Calendar credentials require a bounded ${key}`);
    }
  }
  for (const key of ['token_uri', 'token_endpoint']) {
    if (value[key] !== undefined && value[key] !== CANONICAL_TOKEN_ENDPOINT) {
      throw new Error('Google Calendar credentials contain a non-canonical token endpoint');
    }
  }
  return Buffer.from(
    `${JSON.stringify(
      {
        client_id: value.client_id,
        client_secret: value.client_secret,
        refresh_token: value.refresh_token,
        type: 'authorized_user',
      },
      null,
      2,
    )}\n`,
  );
}

function planDefaultBinding(projectsRoot) {
  realDirectory(projectsRoot, 'Projects root');
  const relativePath = 'agents/raven/agent.yaml';
  inspectParents(projectsRoot, relativePath, 'Default agent target');
  const targetPath = join(projectsRoot, relativePath);
  const current = targetState(targetPath, 'Default Raven agent', 0o644);
  if (current.hash === null) throw new Error('Default Raven agent is missing');
  const source = readBoundedFile(targetPath, 'Default Raven agent');
  const document = parseDocument(source.toString('utf8'), { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error('Default Raven agent YAML is invalid');
  const agent = document.toJS();
  if (
    !agent ||
    typeof agent !== 'object' ||
    Array.isArray(agent) ||
    agent.name !== 'raven' ||
    agent.isDefault !== true ||
    !Array.isArray(agent.skills)
  ) {
    throw new Error('Default Raven agent must define a skills list');
  }
  if (agent.skills.some((skill) => typeof skill !== 'string')) {
    throw new Error('Default Raven agent skills must be strings');
  }
  if (agent.skills.includes('calendar')) {
    return { relativePath, current, operation: 'unchanged' };
  }
  document.set('skills', [...agent.skills, 'calendar']);
  return {
    relativePath,
    current,
    source: Buffer.from(document.toString()),
    operation: 'bind',
  };
}

function commitInstalledFiles(root, relativePaths) {
  if (relativePaths.length === 0) return;
  execFileSync('git', ['-C', root, 'add', '--', ...relativePaths], { stdio: 'pipe' });
  try {
    execFileSync('git', ['-C', root, 'diff', '--cached', '--quiet', '--', ...relativePaths], {
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
      'Install Google Calendar capability',
      '--',
      ...relativePaths,
    ],
    { stdio: 'pipe' },
  );
}

function assertCleanTrackedTargets(root, relativePaths) {
  if (relativePaths.length === 0) return;
  const dirty = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...relativePaths],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (dirty) {
    throw new Error('Refusing to update dirty Google Calendar definition targets');
  }
}

/** Install the shipped read-only Calendar definitions and normalized gws credentials. */
export function installGoogleCalendar({
  root = '/app',
  libraryRoot = join(root, 'library'),
  projectsRoot = join(root, 'projects'),
  dataRoot = join(root, 'data'),
  seedDir = DEFAULT_SEEDS,
  credentialsInput,
  bindDefault = false,
  checkOnly = false,
  commitFiles,
} = {}) {
  libraryRoot = resolve(libraryRoot);
  projectsRoot = resolve(projectsRoot);
  dataRoot = resolve(dataRoot);
  seedDir = resolve(seedDir);
  const definitions = planDefinitions(libraryRoot, seedDir);
  if (checkOnly)
    return { checked: true, installed: [], credentialsUpdated: false, defaultBound: false };

  const credentialBytes = normalizedCredentials(credentialsInput);
  realDirectory(dataRoot, 'Data root');
  const credentialRelativePath = 'google-calendar/credentials.json';
  inspectParents(dataRoot, credentialRelativePath, 'Google Calendar credentials target');
  const credentialPath = join(dataRoot, credentialRelativePath);
  const credentials = targetState(credentialPath, 'Google Calendar credentials target', 0o600);
  const binding = bindDefault ? planDefaultBinding(projectsRoot) : undefined;
  const plannedTracked = [
    ...definitions
      .filter((entry) => entry.operation === 'install')
      .map((entry) => join('library', entry.relativePath)),
    ...(binding?.operation === 'bind' ? [join('projects', binding.relativePath)] : []),
  ];
  if (commitFiles === undefined) assertCleanTrackedTargets(root, plannedTracked);

  const installed = [];
  for (const entry of definitions) {
    if (entry.operation === 'unchanged') continue;
    createParents(libraryRoot, entry.relativePath, 'Google Calendar target');
    const targetPath = join(libraryRoot, entry.relativePath);
    if (targetState(targetPath, 'Google Calendar target', 0o644).hash !== entry.current.hash) {
      throw new Error(
        `Google Calendar target changed during installation: library/${entry.relativePath}`,
      );
    }
    replaceAtomic(targetPath, entry.source, entry.current.mode);
    installed.push(entry.relativePath);
  }

  const credentialHash = hashBytes(credentialBytes);
  const credentialsUpdated = credentials.hash !== credentialHash || credentials.mode !== 0o600;
  if (credentialsUpdated) {
    createParents(dataRoot, credentialRelativePath, 'Google Calendar credentials target');
    if (
      targetState(credentialPath, 'Google Calendar credentials target', 0o600).hash !==
      credentials.hash
    ) {
      throw new Error('Google Calendar credentials changed during installation');
    }
    replaceAtomic(credentialPath, credentialBytes, 0o600);
  }

  let defaultBound = false;
  if (binding?.operation === 'bind') {
    const targetPath = join(projectsRoot, binding.relativePath);
    if (targetState(targetPath, 'Default Raven agent', 0o644).hash !== binding.current.hash) {
      throw new Error('Default Raven agent changed during installation');
    }
    replaceAtomic(targetPath, binding.source, binding.current.mode);
    defaultBound = true;
  }

  const tracked = [
    ...installed.map((path) => join('library', path)),
    ...(defaultBound ? [join('projects', binding.relativePath)] : []),
  ];
  if (tracked.length > 0) {
    (commitFiles ?? ((paths) => commitInstalledFiles(root, paths)))(tracked);
  }
  return { checked: true, installed, credentialsUpdated, defaultBound };
}

function readStdinBounded() {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(8192, MAX_FILE_BYTES + 1 - total));
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_FILE_BYTES) {
      throw new Error('Google Calendar credentials exceed 64 KiB');
    }
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks);
}

function main() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => arg !== '--check' && arg !== '--bind-default') ||
    new Set(args).size !== args.length ||
    (args.includes('--check') && args.length !== 1)
  ) {
    throw new Error(
      'Usage: node deployment/install-google-calendar.mjs [--check | --bind-default]',
    );
  }
  const checkOnly = args[0] === '--check';
  const result = installGoogleCalendar({
    checkOnly,
    bindDefault: args.includes('--bind-default'),
    ...(checkOnly ? {} : { credentialsInput: readStdinBounded() }),
  });
  console.log(
    checkOnly
      ? 'Google Calendar capability can be installed without overwriting owner definitions.'
      : `Google Calendar setup files installed (${String(result.installed.length)} definition updates).`,
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
