import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { projectWorkspaceDefaults } from '@raven/shared';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import {
  createMutationJournal,
  readProjectRecoveryReport,
  recoverProjectMutation,
  removeProjectMutationJournal,
  type RecoveryDeps,
} from '../project-manager/project-recovery/journal.ts';

interface Fixture {
  root: string;
  projectsDir: string;
  outsideDir: string;
  registry: ProjectRegistry;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'raven-project-recovery-journal-'));
  roots.push(root);
  const { projectsDir } = createRavenTestFixture(root);
  const outsideDir = join(root, 'outside');
  mkdirSync(outsideDir);
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  return { root, projectsDir, outsideDir, registry };
}

function recoveryDeps(fixture: Fixture): RecoveryDeps {
  return { projectsDir: fixture.projectsDir, projectRegistry: fixture.registry };
}

function journalFile(fixture: Fixture, mutationId: string): string {
  return join(fixture.projectsDir, '.project-mutations', `${mutationId}.yaml`);
}

function rewriteJournal(
  fixture: Fixture,
  mutationId: string,
  update: (record: Record<string, unknown>) => void,
): void {
  const path = journalFile(fixture, mutationId);
  const parsed: unknown = parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a YAML mapping');
  }
  const record = parsed as Record<string, unknown>;
  update(record);
  writeFileSync(path, stringify(record));
}

function createJournal(
  fixture: Fixture,
  path: string,
  originalBytes: string,
  intendedBytes: string,
) {
  return createMutationJournal({
    projectsDir: fixture.projectsDir,
    operation: 'update',
    projectId: path,
    path,
    originalBytes,
    intendedBytes,
  });
}

function createArchiveJournal(fixture: Fixture, path: string) {
  const archiveJson = JSON.stringify({ id: path, fsPath: path });
  return createMutationJournal({
    projectsDir: fixture.projectsDir,
    operation: 'archive',
    projectId: path,
    path,
    originalBytes: '# Original\n',
    intendedBytes: '# Original\n',
    archivePath: `.archive/${randomUUID()}`,
    archiveJson,
  });
}

describe('project recovery journal boundaries', () => {
  it.each(['changed staging context', 'extra staging file'])(
    'retains conflicting create staging when there is an %s',
    async (change) => {
      const fixture = await makeFixture();
      const path = 'created-project';
      const intendedBytes = '# Created project\n';
      const preparedPath = `.project-mutations/prepared-${randomUUID()}`;
      const journal = createMutationJournal({
        projectsDir: fixture.projectsDir,
        operation: 'create',
        projectId: path,
        path,
        originalBytes: '',
        intendedBytes,
        preparedPath,
      });
      const preparedDirectory = join(fixture.projectsDir, preparedPath);
      mkdirSync(preparedDirectory);
      writeFileSync(
        join(preparedDirectory, 'context.md'),
        change === 'changed staging context' ? '# Changed\n' : intendedBytes,
      );
      if (change === 'extra staging file')
        writeFileSync(join(preparedDirectory, 'owner.txt'), 'keep me');
      const before = readFileSync(join(preparedDirectory, 'context.md'), 'utf8');

      expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
        expect.objectContaining({ mutationId: journal.mutationId, state: 'conflict' }),
      ]);
      await expect(
        recoverProjectMutation(recoveryDeps(fixture), journal.mutationId),
      ).rejects.toThrow(/conflicts/);
      expect(readFileSync(join(preparedDirectory, 'context.md'), 'utf8')).toBe(before);
      expect(lstatSync(preparedDirectory).isDirectory()).toBe(true);
      if (change === 'extra staging file') {
        expect(readFileSync(join(preparedDirectory, 'owner.txt'), 'utf8')).toBe('keep me');
      }
    },
  );

  it('treats a published create with a missing workspace anchor as a conflict', async () => {
    const fixture = await makeFixture();
    const path = 'published-project';
    const intendedBytes = '# Published project\n';
    const workspaceBytes = stringify(projectWorkspaceDefaults());
    const journal = createMutationJournal({
      projectsDir: fixture.projectsDir,
      operation: 'create',
      projectId: path,
      path,
      originalBytes: '',
      intendedBytes,
      preparedPath: `.project-mutations/prepared-${randomUUID()}`,
      workspaceBytes,
    });
    const publishedDirectory = join(fixture.projectsDir, path);
    mkdirSync(publishedDirectory);
    writeFileSync(join(publishedDirectory, 'context.md'), intendedBytes);

    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
      expect.objectContaining({ mutationId: journal.mutationId, state: 'conflict' }),
    ]);
    await expect(recoverProjectMutation(recoveryDeps(fixture), journal.mutationId)).rejects.toThrow(
      /conflicts/,
    );
    expect(readFileSync(join(publishedDirectory, 'context.md'), 'utf8')).toBe(intendedBytes);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(1);
  });

  it('retains a symlinked workspace anchor in conflicted create staging', async () => {
    const fixture = await makeFixture();
    const path = 'symlinked-project';
    const intendedBytes = '# Symlinked project\n';
    const workspaceBytes = stringify(projectWorkspaceDefaults());
    const preparedPath = `.project-mutations/prepared-${randomUUID()}`;
    const journal = createMutationJournal({
      projectsDir: fixture.projectsDir,
      operation: 'create',
      projectId: path,
      path,
      originalBytes: '',
      intendedBytes,
      preparedPath,
      workspaceBytes,
    });
    const preparedDirectory = join(fixture.projectsDir, preparedPath);
    mkdirSync(preparedDirectory);
    writeFileSync(join(preparedDirectory, 'context.md'), intendedBytes);
    const outsideManifest = join(fixture.outsideDir, 'project.yaml');
    writeFileSync(outsideManifest, workspaceBytes);
    symlinkSync(outsideManifest, join(preparedDirectory, 'project.yaml'));

    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
      expect.objectContaining({ mutationId: journal.mutationId, state: 'conflict' }),
    ]);
    await expect(recoverProjectMutation(recoveryDeps(fixture), journal.mutationId)).rejects.toThrow(
      /conflicts/,
    );
    expect(lstatSync(join(preparedDirectory, 'project.yaml')).isSymbolicLink()).toBe(true);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(1);
  });

  it('cancels an empty create staging directory and clears its journal', async () => {
    const fixture = await makeFixture();
    const path = 'empty-create';
    const preparedPath = `.project-mutations/prepared-${randomUUID()}`;
    const journal = createMutationJournal({
      projectsDir: fixture.projectsDir,
      operation: 'create',
      projectId: path,
      path,
      originalBytes: '',
      intendedBytes: '# Created\n',
      preparedPath,
    });
    mkdirSync(join(fixture.projectsDir, preparedPath));

    await expect(
      recoverProjectMutation(recoveryDeps(fixture), journal.mutationId),
    ).resolves.toMatchObject({
      status: 'cancelled',
      mutationId: journal.mutationId,
    });
    expect(() => lstatSync(join(fixture.projectsDir, preparedPath))).toThrow();
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
  });

  it.each(['originalBytes', 'intendedBytes'])(
    'rejects an update journal with tampered %s before changing the source',
    async (field) => {
      const fixture = await makeFixture();
      const path = 'updated-project';
      const source = join(fixture.projectsDir, path, 'context.md');
      mkdirSync(join(fixture.projectsDir, path));
      writeFileSync(source, '# Original\n');
      const journal = createJournal(fixture, path, '# Original\n', '# Updated\n');
      rewriteJournal(fixture, journal.mutationId, (record) => {
        record[field] = field === 'originalBytes' ? '# Other original\n' : '# Other intended\n';
      });
      const before = readFileSync(source, 'utf8');

      expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
        expect.objectContaining({ mutationId: journal.mutationId, state: 'invalid' }),
      ]);
      await expect(
        recoverProjectMutation(recoveryDeps(fixture), journal.mutationId),
      ).rejects.toThrow();
      expect(readFileSync(source, 'utf8')).toBe(before);
    },
  );

  it('rejects an archive snapshot hash mismatch without touching the source', async () => {
    const fixture = await makeFixture();
    const path = 'archived-project';
    const source = join(fixture.projectsDir, path, 'context.md');
    mkdirSync(join(fixture.projectsDir, path));
    writeFileSync(source, '# Original\n');
    const journal = createArchiveJournal(fixture, path);
    rewriteJournal(fixture, journal.mutationId, (record) => {
      record.archiveJson = JSON.stringify({ id: path, fsPath: path, changed: true });
    });
    const before = readFileSync(source, 'utf8');

    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
      expect.objectContaining({ mutationId: journal.mutationId, state: 'invalid' }),
    ]);
    await expect(
      recoverProjectMutation(recoveryDeps(fixture), journal.mutationId),
    ).rejects.toThrow();
    expect(readFileSync(source, 'utf8')).toBe(before);
  });

  it('rejects an archive journal whose intended context differs from its source', async () => {
    const fixture = await makeFixture();
    const path = 'invalid-archive';
    const archiveJson = JSON.stringify({ id: path, fsPath: path });

    expect(() =>
      createMutationJournal({
        projectsDir: fixture.projectsDir,
        operation: 'archive',
        projectId: path,
        path,
        originalBytes: '# Original\n',
        intendedBytes: '# Changed\n',
        archivePath: `.archive/${randomUUID()}`,
        archiveJson,
      }),
    ).toThrow();
  });

  it('blocks all recovery operations when the journal directory is a symlink', async () => {
    const fixture = await makeFixture();
    const journalPath = join(fixture.projectsDir, '.project-mutations');
    const marker = join(fixture.outsideDir, 'marker.txt');
    writeFileSync(marker, 'outside bytes');
    symlinkSync(fixture.outsideDir, journalPath, 'dir');

    expect(readProjectRecoveryReport(fixture.projectsDir)).toEqual({
      pendingProjectPaths: ['.'],
      entries: [expect.objectContaining({ state: 'invalid', path: '.' })],
    });
    expect(() => removeProjectMutationJournal(fixture.projectsDir, 'safe-id')).toThrow(
      /symlink|unsafe/,
    );
    await expect(recoverProjectMutation(recoveryDeps(fixture), 'safe-id')).rejects.toThrow(
      /symlink|unsafe/,
    );
    expect(readFileSync(marker, 'utf8')).toBe('outside bytes');
    expect(readlinkSync(journalPath)).toBe(fixture.outsideDir);
  });

  it.each([
    ['unsafe prepared path', 'create', 'preparedPath'],
    ['unsafe archive path', 'archive', 'archivePath'],
    ['partial non-archive metadata', 'update', 'archivePath'],
  ])(
    'marks %s as invalid without writing outside the project root',
    async (_name, operation, field) => {
      const fixture = await makeFixture();
      const path = `${operation}-project`;
      const outsideFile = join(fixture.outsideDir, 'untouched.txt');
      writeFileSync(outsideFile, 'preserve');
      let mutationId: string;
      if (operation === 'create') {
        const journal = createMutationJournal({
          projectsDir: fixture.projectsDir,
          operation: 'create',
          projectId: path,
          path,
          originalBytes: '',
          intendedBytes: '# Created\n',
          preparedPath: `.project-mutations/prepared-${randomUUID()}`,
        });
        mutationId = journal.mutationId;
      } else if (operation === 'archive') {
        mutationId = createArchiveJournal(fixture, path).mutationId;
      } else {
        mutationId = createJournal(fixture, path, '# Original\n', '# Updated\n').mutationId;
      }
      rewriteJournal(fixture, mutationId, (record) => {
        record[field] =
          operation === 'update' ? `.archive/${randomUUID()}` : '../outside/untouched.txt';
      });

      expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([
        expect.objectContaining({ mutationId, state: 'invalid' }),
      ]);
      await expect(recoverProjectMutation(recoveryDeps(fixture), mutationId)).rejects.toThrow();
      expect(readFileSync(outsideFile, 'utf8')).toBe('preserve');
    },
  );
});
