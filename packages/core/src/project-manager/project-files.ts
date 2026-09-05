import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { lstat, realpath, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { HTTP_STATUS } from '@raven/shared';
import { ProjectMutationError } from './project-mutation.ts';

const RESERVED = new Set([
  'agents',
  'templates',
  'schedules',
  'tasks',
  'node_modules',
  'meta',
  '_global',
]);
const MAX_PROJECT_DEPTH = 3;

export function assertProjectPath(path: string, system = false): void {
  const parts = path.split('/');
  if (
    parts.some(
      (part) => !part || part.startsWith('.') || RESERVED.has(part) || part.includes('\\'),
    ) ||
    path.includes('\0')
  ) {
    throw new ProjectMutationError(
      'Invalid project path: use a relative, non-reserved path without ".." segments',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  if (parts.length > MAX_PROJECT_DEPTH)
    throw new ProjectMutationError(
      'Projects support at most three directory levels',
      HTTP_STATUS.BAD_REQUEST,
    );
  if (parts[0] === 'system' && !system) {
    throw new ProjectMutationError('The system project path is reserved');
  }
}

export async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Check every existing component, including the final context/archive file. */
export async function managedPath(root: string, relativePath: string): Promise<string> {
  const base = resolve(root);
  if ((await realpath(base)) !== base)
    throw new ProjectMutationError('Project root must not be a symlink');
  const parts = relativePath.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) ||
    relativePath.includes('\0')
  ) {
    throw new ProjectMutationError('Invalid managed project path', HTTP_STATUS.BAD_REQUEST);
  }
  let path = base;
  for (const part of parts) {
    path = join(path, part);
    if (await pathPresent(path)) {
      if ((await lstat(path)).isSymbolicLink())
        throw new ProjectMutationError('Project paths must not contain symlinks');
    }
  }
  return path;
}

export async function readManagedContext(root: string, path: string): Promise<string> {
  return readFile(await managedPath(root, `${path}/context.md`), 'utf8');
}

/** Same-directory rename keeps readers from observing a truncated definition. */
export async function replaceContext(root: string, path: string, content: string): Promise<void> {
  await replaceContextChecked({ root, path, content });
}

export async function replaceContextChecked(options: {
  root: string;
  path: string;
  content: string;
  expectedHash?: string;
}): Promise<void> {
  const { root, path, content, expectedHash } = options;
  const destination = await managedPath(root, `${path}/context.md`);
  if (expectedHash !== undefined) {
    await assertContextHash(destination, expectedHash);
  }
  const temporary = join(dirname(destination), `.context-${randomUUID()}.tmp`);
  try {
    const mode = (await lstat(destination)).mode;
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    await managedPath(root, `${path}/context.md`);
    if (expectedHash !== undefined) await assertContextHash(destination, expectedHash);
    fsyncFile(temporary);
    await rename(temporary, destination);
    fsyncDirectory(dirname(destination));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function assertContextHash(path: string, expectedHash: string): Promise<void> {
  const current = await readFile(path, 'utf8');
  const hash = createHash('sha256').update(current).digest('hex');
  if (hash !== expectedHash)
    throw new ProjectMutationError(`Project context changed before update`);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
