import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { META_PROJECT_ID, TaskRecordSchema } from '@raven/shared';
import { atomicWrite, sha256 } from '../project-manager/project-records.ts';
import { createTaskStore } from '../task-manager/task-store.ts';

function eventBus() {
  return { emit: () => undefined, on: () => undefined, off: () => undefined };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-task-records-'));
  const projectsDir = join(root, 'projects');
  const projects = [
    { id: META_PROJECT_ID, fsPath: 'system' },
    { id: 'project-a', fsPath: 'project-a' },
    { id: 'project-b', fsPath: 'project-b' },
  ];
  for (const project of projects) mkdirSync(join(projectsDir, project.fsPath), { recursive: true });
  const deps = { projectsDir, projects: () => projects, eventBus: eventBus() };
  return { root, projectsDir, deps, store: createTaskStore(deps) };
}

describe('project-local task records', () => {
  it('writes to the project board and reflects edits after a new store', () => {
    const fixtureData = fixture();
    try {
      const created = fixtureData.store.createTask({ title: 'File task', projectId: 'project-a' });
      const path = join(
        fixtureData.projectsDir,
        'project-a',
        'tasks',
        'board',
        `${created.id}.yaml`,
      );
      expect(existsSync(path)).toBe(true);
      const edited = { ...created, title: 'Edited on disk' };
      writeFileSync(path, stringify(TaskRecordSchema.parse(edited)));
      const reopened = createTaskStore(fixtureData.deps);
      expect(reopened.getTask(created.id)?.title).toBe('Edited on disk');
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('recovers a move intent left after destination publication', () => {
    const fixtureData = fixture();
    try {
      const created = fixtureData.store.createTask({ title: 'Move me', projectId: 'project-a' });
      const sourcePath = join(
        fixtureData.projectsDir,
        'project-a',
        'tasks',
        'board',
        `${created.id}.yaml`,
      );
      const destinationPath = join(
        fixtureData.projectsDir,
        'project-b',
        'tasks',
        'board',
        `${created.id}.yaml`,
      );
      const destinationBytes = stringify({ ...created, projectId: 'project-b' });
      const intentPath = join(fixtureData.projectsDir, '.raven-record-moves', 'move-1.json');
      atomicWrite(
        fixtureData.projectsDir,
        intentPath,
        JSON.stringify({
          sourcePath,
          destinationPath,
          sourceHash: sha256(readFileSync(sourcePath, 'utf8')),
          destinationHash: sha256(destinationBytes),
          destinationBytes,
        }),
      );
      atomicWrite(fixtureData.projectsDir, destinationPath, destinationBytes);
      const reopened = createTaskStore(fixtureData.deps);
      expect(reopened.getTask(created.id)?.projectId).toBe('project-b');
      expect(existsSync(sourcePath)).toBe(false);
      expect(existsSync(intentPath)).toBe(false);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked board directory', () => {
    const fixtureData = fixture();
    try {
      const outside = join(fixtureData.root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(fixtureData.projectsDir, 'project-a', 'tasks'));
      expect(() => fixtureData.store.queryTasks({})).toThrow(/symlink/i);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('refuses a move after the source was externally changed', () => {
    const fixtureData = fixture();
    try {
      const created = fixtureData.store.createTask({ title: 'Conflict', projectId: 'project-a' });
      const sourcePath = join(
        fixtureData.projectsDir,
        'project-a',
        'tasks',
        'board',
        `${created.id}.yaml`,
      );
      const destinationPath = join(
        fixtureData.projectsDir,
        'project-b',
        'tasks',
        'board',
        `${created.id}.yaml`,
      );
      const destinationBytes = stringify({ ...created, projectId: 'project-b' });
      const original = readFileSync(sourcePath, 'utf8');
      atomicWrite(
        fixtureData.projectsDir,
        join(fixtureData.projectsDir, '.raven-record-moves', 'conflict.json'),
        JSON.stringify({
          sourcePath,
          destinationPath,
          sourceHash: sha256(original),
          destinationHash: sha256(destinationBytes),
          destinationBytes,
        }),
      );
      writeFileSync(sourcePath, `${original}\n# external edit\n`);
      expect(() => createTaskStore(fixtureData.deps).getTask(created.id)).toThrow(
        /source changed/i,
      );
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(destinationPath)).toBe(false);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed records before a create can write', () => {
    const fixtureData = fixture();
    try {
      const board = join(fixtureData.projectsDir, 'project-a', 'tasks', 'board');
      mkdirSync(board, { recursive: true });
      writeFileSync(join(board, 'malformed.yaml'), 'id: malformed\nstatus: todo\n');
      expect(() => fixtureData.store.createTask({ title: 'Blocked by malformed file' })).toThrow(
        /Invalid task record/,
      );
      expect(existsSync(join(fixtureData.projectsDir, 'system', 'tasks'))).toBe(false);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate task IDs from disk', () => {
    const fixtureData = fixture();
    try {
      const task = fixtureData.store.createTask({ title: 'Original', projectId: 'project-a' });
      const duplicate = join(
        fixtureData.projectsDir,
        'project-b',
        'tasks',
        'board',
        `${task.id}.yaml`,
      );
      atomicWrite(
        fixtureData.projectsDir,
        duplicate,
        stringify({ ...task, projectId: 'project-b' }),
      );
      expect(() => fixtureData.store.queryTasks({})).toThrow(/Duplicate task record id/);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('rejects a foreign project record on disk', () => {
    const fixtureData = fixture();
    try {
      const task = fixtureData.store.createTask({ title: 'Foreign', projectId: 'project-b' });
      const path = join(fixtureData.projectsDir, 'project-a', 'tasks', 'board', `${task.id}.yaml`);
      atomicWrite(
        fixtureData.projectsDir,
        path,
        readFileSync(
          join(fixtureData.projectsDir, 'project-b', 'tasks', 'board', `${task.id}.yaml`),
          'utf8',
        ),
      );
      expect(() => fixtureData.store.queryTasks({})).toThrow(/ownership mismatch/);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('rejects a record whose filename differs from its ID', () => {
    const fixtureData = fixture();
    try {
      const task = fixtureData.store.createTask({
        title: 'Wrong filename',
        projectId: 'project-a',
      });
      const source = join(
        fixtureData.projectsDir,
        'project-a',
        'tasks',
        'board',
        `${task.id}.yaml`,
      );
      const wrong = join(fixtureData.projectsDir, 'project-a', 'tasks', 'board', 'wrong-name.yaml');
      atomicWrite(fixtureData.projectsDir, wrong, readFileSync(source, 'utf8'));
      rmSync(source);
      expect(() => fixtureData.store.queryTasks({})).toThrow(/filename does not match/);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });

  it('does not recreate a missing physical project on create', () => {
    const fixtureData = fixture();
    try {
      const projectRoot = join(fixtureData.projectsDir, 'project-a');
      rmSync(projectRoot, { recursive: true, force: true });
      expect(() =>
        fixtureData.store.createTask({ title: 'Missing project', projectId: 'project-a' }),
      ).toThrow(/Project directory does not exist/);
      expect(existsSync(projectRoot)).toBe(false);
    } finally {
      rmSync(fixtureData.root, { recursive: true, force: true });
    }
  });
});
