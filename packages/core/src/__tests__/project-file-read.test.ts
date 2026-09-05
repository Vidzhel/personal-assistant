import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectMutationError } from '../project-manager/project-mutation.ts';

const mockState = vi.hoisted(() => ({
  originalReadSync: undefined as unknown as typeof Fs.readSync,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs');
  mockState.originalReadSync = actual.readSync;
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    readSync: vi.fn(actual.readSync),
  };
});

import { closeSync, readSync } from 'node:fs';
import { readProjectTextFile } from '../project-manager/project-file-read.ts';

describe('readProjectTextFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-project-file-read-'));
  });

  afterEach(() => {
    vi.mocked(readSync).mockClear();
    vi.mocked(closeSync).mockClear();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a regular text file within its bound', () => {
    const path = join(dir, 'context.md');
    writeFileSync(path, '# Project\n');

    expect(readProjectTextFile(path, 100)).toBe('# Project\n');
  });

  it('returns undefined only when the initial path is absent', () => {
    expect(readProjectTextFile(join(dir, 'missing.md'), 100)).toBeUndefined();
  });

  it('rejects a symlink without reading its target', () => {
    const target = join(dir, 'outside.md');
    const path = join(dir, 'context.md');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, path);

    expect(() => readProjectTextFile(path, 100)).toThrow(ProjectMutationError);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('rejects a FIFO instead of blocking on it', () => {
    const path = join(dir, 'pipe');
    try {
      execFileSync('mkfifo', [path]);
    } catch {
      return;
    }

    expect(() => readProjectTextFile(path, 100)).toThrow(ProjectMutationError);
  });

  it('rejects files over the configured bound', () => {
    const path = join(dir, 'project.yaml');
    writeFileSync(path, '123456789');

    expect(() => readProjectTextFile(path, 8)).toThrow(/exceeds 8 bytes/);
  });

  it('reads both project context and workspace manifests through the same safe path', () => {
    const context = join(dir, 'context.md');
    const manifest = join(dir, 'project.yaml');
    writeFileSync(context, '# Human context\n');
    writeFileSync(manifest, 'version: 1\nexecution:\n  mode: default\nsources: []\n');

    expect(readProjectTextFile(context, 100)).toContain('Human context');
    expect(readProjectTextFile(manifest, 200)).toContain('sources: []');
  });

  it('preserves a valid UTF-8 BOM for byte-exact callers', () => {
    const path = join(dir, 'context.md');
    const bytes = Buffer.from('\uFEFF# Human context\n', 'utf8');
    writeFileSync(path, bytes);

    expect(Buffer.from(readProjectTextFile(path, 100)!, 'utf8')).toEqual(bytes);
  });

  it('rejects invalid UTF-8 without replacing its bytes', () => {
    const path = join(dir, 'project.yaml');
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => readProjectTextFile(path, 100)).toThrow(ProjectMutationError);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1);
  });

  it('rejects content changed in the opened inode during reading', () => {
    const path = join(dir, 'project.yaml');
    writeFileSync(path, 'original\n');
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      writeFileSync(path, 'short\n');
      return (mockState.originalReadSync as (...readArgs: typeof args) => number)(...args);
    });
    expect(() => readProjectTextFile(path, 100)).toThrow(/changed during read/);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1);
  });

  it('rejects replacement during read and closes the descriptor', () => {
    const path = join(dir, 'context.md');
    const moved = join(dir, 'context.original.md');
    writeFileSync(path, 'original\n');
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      renameSync(path, moved);
      writeFileSync(path, 'replacement\n');
      return (mockState.originalReadSync as (...readArgs: typeof args) => number)(...args);
    });

    expect(() => readProjectTextFile(path, 100)).toThrow(/changed during read/);
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1);
  });

  it('rejects a directory even when its path has readable entries', () => {
    const path = join(dir, 'project');
    mkdirSync(path);

    expect(() => readProjectTextFile(path, 100)).toThrow(ProjectMutationError);
  });
});
