import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { ProjectMutationError } from './project-mutation.ts';

const READ_CHUNK_BYTES = Buffer.poolSize;

function failure(path: string, error: unknown): ProjectMutationError {
  const message = error instanceof Error ? error.message : String(error);
  return new ProjectMutationError(`Cannot safely read ${path}: ${message}`);
}

function sameFileState(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function assertRegular(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ProjectMutationError(`Cannot safely read ${path}: expected a regular file`);
  }
}

function assertPathMatchesDescriptor(path: string, descriptor: Stats, maxBytes: number): void {
  const pathStats = lstatSync(path);
  assertRegular(path, pathStats);
  if (pathStats.dev !== descriptor.dev || pathStats.ino !== descriptor.ino) {
    throw new ProjectMutationError(`Cannot safely read ${path}: file changed during read`);
  }
  if (pathStats.size > maxBytes) {
    throw new ProjectMutationError(`Cannot safely read ${path}: file exceeds ${maxBytes} bytes`);
  }
}

function readBounded(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(buffer.subarray(0, bytesRead));
    if (total > maxBytes) {
      throw new ProjectMutationError(`File exceeds ${maxBytes} bytes`);
    }
  }
  return Buffer.concat(chunks, total);
}

function readOpenedFile(fd: number, path: string, maxBytes: number): string {
  const before = fstatSync(fd);
  assertRegular(path, before);
  if (before.size > maxBytes) {
    throw new ProjectMutationError(`Cannot safely read ${path}: file exceeds ${maxBytes} bytes`);
  }
  assertPathMatchesDescriptor(path, before, maxBytes);
  const content = readBounded(fd, maxBytes);
  const after = fstatSync(fd);
  assertRegular(path, after);
  if (content.length !== before.size || !sameFileState(before, after)) {
    throw new ProjectMutationError(`Cannot safely read ${path}: file changed during read`);
  }
  assertPathMatchesDescriptor(path, after, maxBytes);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
}

function openProjectFile(path: string): number | undefined {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure(path, error);
  }
}

function closeProjectFile(fd: number): unknown {
  try {
    closeSync(fd);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Read a bounded, stable regular file without following a symlink or FIFO. */
export function readProjectTextFile(path: string, maxBytes: number): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ProjectMutationError(`Invalid maximum file size: ${String(maxBytes)}`);
  }
  const fd = openProjectFile(path);
  if (fd === undefined) return undefined;

  let result: string | undefined;
  let problem: unknown;
  let closeProblem: unknown;
  try {
    result = readOpenedFile(fd, path, maxBytes);
  } catch (error) {
    problem = error;
  } finally {
    closeProblem = closeProjectFile(fd);
  }
  if (problem instanceof ProjectMutationError) throw problem;
  if (problem !== undefined) throw failure(path, problem);
  if (closeProblem !== undefined) throw failure(path, closeProblem);
  return result;
}
