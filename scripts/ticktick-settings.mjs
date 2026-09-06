import { spawnSync } from 'node:child_process';
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
import { pathToFileURL } from 'node:url';

const MAX_ENV_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 4096;

export function validateTicktickToken(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_TOKEN_LENGTH ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      'TickTick MCP token must be 1-4096 characters, non-blank, and without surrounding whitespace or controls',
    );
  }
  return value;
}

function activeAssignments(lines, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  return lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
}

function renderLiteral(value) {
  return `'${value.replaceAll("'", "\\'")}'`;
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

export function updateTicktickSettings({ envFile, token, validateCandidate }) {
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
  const assignments = activeAssignments(lines, 'TICKTICK_MCP_TOKEN');
  if (assignments.length > 1) throw new Error('TICKTICK_MCP_TOKEN is assigned more than once');
  const rendered = `TICKTICK_MCP_TOKEN=${renderLiteral(validateTicktickToken(token))}`;
  if (assignments.length === 1) lines[assignments[0]] = rendered;
  else lines.push(rendered);
  const content = `${lines.join(newline)}${hadFinalNewline || lines.length > 0 ? newline : ''}`;

  writeAtomic(path, content, stat.mode & 0o777, (candidate) => {
    validateCandidate?.(candidate);
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.size !== Buffer.byteLength(source) ||
      readFileSync(path, 'utf8') !== source
    ) {
      throw new Error('Environment file changed during validation; retry with the current file');
    }
  });
}

function validateComposeCandidate(candidate) {
  const repositoryRoot = resolve(import.meta.dirname, '..');
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
    { cwd: repositoryRoot, env: process.env, stdio: 'ignore', timeout: 30_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Docker Compose rejected the proposed TickTick setting');
  }
}

async function readToken() {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > MAX_TOKEN_LENGTH) {
      throw new Error('TickTick MCP token is longer than 4096 characters');
    }
  }
  return validateTicktickToken(value);
}

async function main() {
  const [envFile] = process.argv.slice(2);
  if (!envFile || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/ticktick-settings.mjs ENV_FILE');
  }
  if (process.env.TICKTICK_MCP_TOKEN?.trim()) {
    throw new Error(
      'Unset the exported TICKTICK_MCP_TOKEN environment variable before configuring TickTick',
    );
  }
  if (process.env.COMPOSE_FILE?.trim()) {
    throw new Error(
      'Unset the exported COMPOSE_FILE environment variable before configuring TickTick',
    );
  }
  updateTicktickSettings({
    envFile,
    token: await readToken(),
    validateCandidate: validateComposeCandidate,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
