import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SEEDS = fileURLToPath(new URL('./seeds/', import.meta.url));
const ROOT_NAMES = ['data', 'projects', 'library', 'config'];
const DEFINITION_NAMES = ['projects', 'library', 'config'];
const HISTORY_EXCLUDES = [
  '/*',
  '!/projects/',
  '!/library/',
  '!/config/',
  '/library/vendor/',
  '**/.env*',
  '**/*.db*',
  '**/*.sqlite*',
  '**/*.log',
  '',
].join('\n');

function directory(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Runtime directory must be a real directory: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true });
  }
}

function seedFiles(seedRoot, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(seedRoot, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Seed symlink is not supported: ${name}`);
    if (entry.isDirectory()) files.push(...seedFiles(seedRoot, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported seed entry: ${name}`);
  }
  return files;
}

function planSeeds(root, seedDir) {
  return DEFINITION_NAMES.filter((name) => readdirSync(join(root, name)).length === 0).flatMap(
    (name) => seedFiles(join(seedDir, name)).map((file) => join(name, file)),
  );
}

function hashFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Seed must be a regular file: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function bootstrapJournal(path, seedDir, files) {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    if (files.length === 0) return null;
    const journal = {
      version: 1,
      files: files.map((file) => ({ path: file, hash: hashFile(join(seedDir, file)) })),
    };
    writeFileSync(path, JSON.stringify(journal), { flag: 'wx' });
  }
  if (!lstatSync(path).isFile()) throw new Error('Invalid pending deployment bootstrap journal');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  if (journal?.version !== 1 || !Array.isArray(journal.files) || !journal.files.length) {
    throw new Error('Invalid pending deployment bootstrap journal');
  }
  for (const entry of journal.files) {
    const parts = typeof entry?.path === 'string' ? entry.path.split(sep) : [];
    if (
      parts.length < 2 ||
      !DEFINITION_NAMES.includes(parts[0]) ||
      parts.some((part) => ['', '.', '..'].includes(part)) ||
      !/^[a-f0-9]{64}$/.test(entry.hash)
    ) {
      throw new Error('Invalid path or hash in pending deployment bootstrap journal');
    }
  }
  return journal;
}

function seedEmptyRoots(root, seedDir, journal) {
  // Recovery touches only the exact original bootstrap paths. An edited file
  // requires operator reconciliation, never an overwrite or arbitrary merge.
  const missing = [];
  for (const entry of journal.files) {
    const parts = entry.path.split(sep);
    for (let count = 1; count < parts.length; count++)
      directory(join(root, ...parts.slice(0, count)));
    const target = join(root, entry.path);
    const exists = lstatSync(target, { throwIfNoEntry: false });
    if (hashFile(exists ? target : join(seedDir, entry.path)) !== entry.hash) {
      throw new Error(
        `Incomplete deployment bootstrap: ${entry.path} differs from the original seed; reconcile the pending journal before starting Raven`,
      );
    }
    if (!exists) missing.push(entry.path);
  }
  for (const file of missing) {
    copyFileSync(join(seedDir, file), join(root, file), constants.COPYFILE_EXCL);
  }
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validatePointer(root, historyDir) {
  const pointer = join(root, '.git');
  const stat = lstatSync(pointer, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      'Refusing to initialize inside an existing checkout; use a disposable application directory',
    );
  }
  if (readFileSync(pointer, 'utf8').trim() !== `gitdir: ${historyDir}`) {
    throw new Error('Existing .git pointer does not belong to this runtime history');
  }
}

function initializeHistory(root, historyDir) {
  directory(historyDir);
  if (readdirSync(historyDir).length === 0) {
    git(root, ['init', '--initial-branch=main', `--separate-git-dir=${historyDir}`]);
    writeFileSync(join(historyDir, 'info', 'exclude'), HISTORY_EXCLUDES);
  } else {
    // Validate persisted metadata before reconnecting it to a replacement image.
    execFileSync('git', [`--git-dir=${historyDir}`, 'rev-parse', '--is-bare-repository'], {
      stdio: 'pipe',
    });
    writeFileSync(join(root, '.git'), `gitdir: ${historyDir}\n`);
  }
  git(root, ['config', 'core.worktree', root]);
  for (const [key, value] of [
    ['user.name', 'Raven'],
    ['user.email', 'raven@localhost'],
  ]) {
    try {
      git(root, ['config', '--local', '--get', key]);
    } catch {
      git(root, ['config', '--local', key, value]);
    }
  }
}

function commitSeeds(root, files) {
  git(root, ['add', '--', ...files]);
  try {
    git(root, ['diff', '--cached', '--quiet', '--', ...files]);
    return; // Restored empty volumes may reproduce files already in history.
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  git(root, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Initialize Raven deployment definitions',
    '--',
    ...files,
  ]);
}

/** Seed empty persisted roots and reconnect their definition history. Never use a source checkout. */
export function initializeRuntime({ root = '/app', seedDir = DEFAULT_SEEDS } = {}) {
  root = resolve(root);
  directory(root);
  root = realpathSync(root);
  const historyDir = join(root, 'data', 'definition-history');
  validatePointer(root, historyDir);
  for (const name of ROOT_NAMES) directory(join(root, name));
  seedDir = resolve(seedDir);
  const files = planSeeds(root, seedDir);
  initializeHistory(root, historyDir);
  const journalPath = join(historyDir, 'raven-bootstrap.json');
  const journal = bootstrapJournal(journalPath, seedDir, files);
  const seededFiles = journal?.files.map((entry) => entry.path) ?? [];
  if (journal) {
    seedEmptyRoots(root, seedDir, journal);
    commitSeeds(root, seededFiles);
    rmSync(journalPath);
  }
  return { root, historyDir, seededFiles };
}
