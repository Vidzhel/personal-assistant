import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_ENV_BYTES = 256 * 1024;
const PRIVATE_COMPOSE_FILE = 'docker-compose.private.yml';
const USERNAME_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function canonicalPrivateOrigin(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error('Private origin must be a bounded HTTPS URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Private origin must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Private origin must be an HTTPS origin without credentials, path or query');
  }
  return url.origin;
}

export function validatePrivateUsername(value) {
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error('Owner username must be 1-64 letters, numbers, dots, underscores, tildes or hyphens');
  }
  return value;
}

export function validatePasswordHash(value) {
  if (typeof value !== 'string' || !BCRYPT_PATTERN.test(value)) {
    throw new Error('Caddy returned an invalid bcrypt password hash');
  }
  return value;
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('COMPOSE_FILE has invalid quoting');
    }
  }
  const comment = value.search(/\s+#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function activeAssignments(lines, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`);
  return lines.flatMap((line, index) => {
    const match = pattern.exec(line);
    return match ? [{ index, value: parseEnvValue(match[1]) }] : [];
  });
}

function composeFiles(lines) {
  const assignments = activeAssignments(lines, 'COMPOSE_FILE');
  if (assignments.length > 1) throw new Error('COMPOSE_FILE is assigned more than once');
  const configured = assignments[0]?.value || 'docker-compose.yml';
  if (configured.includes('\0') || configured.includes('\n') || configured.includes('\r')) {
    throw new Error('COMPOSE_FILE contains invalid control characters');
  }
  const files = configured.split(':').map((value) => value.trim());
  if (files.some((value) => !value)) throw new Error('COMPOSE_FILE contains an empty path');
  if (files.some((value) => !/^[A-Za-z0-9_./ @+~-]+$/.test(value))) {
    throw new Error('COMPOSE_FILE must contain literal paths without interpolation or shell syntax');
  }
  if (!files.includes(PRIVATE_COMPOSE_FILE)) files.push(PRIVATE_COMPOSE_FILE);
  return files.join(':');
}

function replaceSetting(lines, key, renderedValue) {
  const assignments = activeAssignments(lines, key);
  if (assignments.length > 1) throw new Error(`${key} is assigned more than once`);
  const rendered = `${key}=${renderedValue}`;
  if (assignments.length === 1) lines[assignments[0].index] = rendered;
  else lines.push(rendered);
}

function renderPlain(value) {
  if (!/^[A-Za-z0-9_./:@+~-]+$/.test(value)) return JSON.stringify(value);
  return value;
}

function writeAtomic(path, content, mode, validateCandidate) {
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temp, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    validateCandidate?.(temp);
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

export function updatePrivateAccessSettings({
  envFile,
  origin,
  username,
  passwordHash,
  validateCandidate,
}) {
  const path = resolve(envFile);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Environment file must be a regular file, not a symlink');
  }
  if (stat.size > MAX_ENV_BYTES) throw new Error('Environment file is too large to update safely');
  const source = readFileSync(path, 'utf8');
  if (source.includes('\0')) throw new Error('Environment file contains a NUL byte');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = source.endsWith('\n');
  const lines = source ? source.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const nextComposeFiles = composeFiles(lines);

  replaceSetting(lines, 'COMPOSE_FILE', renderPlain(nextComposeFiles));
  replaceSetting(lines, 'RAVEN_BASE_URL', renderPlain(canonicalPrivateOrigin(origin)));
  replaceSetting(lines, 'RAVEN_PRIVATE_USERNAME', renderPlain(validatePrivateUsername(username)));
  replaceSetting(lines, 'RAVEN_PRIVATE_PASSWORD_HASH', `'${validatePasswordHash(passwordHash)}'`);

  const content = `${lines.join(newline)}${hadFinalNewline || lines.length > 0 ? newline : ''}`;
  writeAtomic(path, content, stat.mode & 0o777, (candidate) => {
    validateCandidate?.(candidate);
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.size !== Buffer.byteLength(source) || readFileSync(path, 'utf8') !== source) {
      throw new Error('Environment file changed during validation; retry with the current file');
    }
  });
}

function validateComposeCandidate(candidate) {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const env = { ...process.env };
  delete env.COMPOSE_FILE;
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-directory',
      repositoryRoot,
      '--env-file',
      candidate,
      'config',
      '--quiet',
    ],
    { cwd: repositoryRoot, env, stdio: 'ignore', timeout: 30_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Docker Compose rejected the proposed private access settings');
  }
}

async function main() {
  const [envFile] = process.argv.slice(2);
  if (!envFile || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/private-access-settings.mjs ENV_FILE');
  }
  if (process.env.COMPOSE_FILE?.trim()) {
    throw new Error(
      'Unset the exported COMPOSE_FILE environment variable before configuring private access',
    );
  }
  updatePrivateAccessSettings({
    envFile,
    origin: process.env.RAVEN_BASE_URL_INPUT,
    username: process.env.RAVEN_PRIVATE_USERNAME_INPUT,
    passwordHash: process.env.RAVEN_PRIVATE_PASSWORD_HASH_INPUT,
    validateCandidate: validateComposeCandidate,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
