import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createTaskStore } from '../task-manager/task-store.ts';
import { sha256 } from '../project-manager/project-records.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe('task record interruption boundaries', () => {
  let root: string;
  const projects = [
    { id: 'meta', fsPath: 'system' },
    { id: 'a', fsPath: 'a' },
    { id: 'b', fsPath: 'b' },
  ];
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const deps = () => ({ projectsDir: root, projects: () => projects, eventBus });
  const store = () => createTaskStore(deps());
  const path = (owner: string, id: string) => join(root, owner, 'tasks/board', `${id}.yaml`);

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'raven-task-faults-'));
    for (const project of projects) fs.mkdirSync(join(root, project.fsPath));
    eventBus.emit.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['write', 'rename'])(
    'keeps original bytes and emits no update after a failed %s',
    (boundary) => {
      const tasks = store();
      const task = tasks.createTask({ title: 'Original', projectId: 'a' });
      const original = fs.readFileSync(path('a', task.id), 'utf8');
      eventBus.emit.mockClear();
      const fail = () => {
        throw new Error('injected disk failure');
      };
      if (boundary === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(fail);
      else vi.spyOn(fs, 'renameSync').mockImplementationOnce(fail);
      expect(() => tasks.updateTask(task.id, { title: 'Uncommitted' })).toThrow(
        'injected disk failure',
      );
      expect(fs.readFileSync(path('a', task.id), 'utf8')).toBe(original);
      expect(tasks.getTask(task.id)?.title).toBe('Original');
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(fs.readdirSync(join(root, 'a/tasks/board'))).toEqual([`${task.id}.yaml`]);
    },
  );

  function interruptedMove(phase: 'intent' | 'destination' | 'source-removed') {
    const task = store().createTask({ title: 'Move me', projectId: 'a' });
    const sourcePath = path('a', task.id);
    const destinationPath = path('b', task.id);
    const destinationBytes = stringify({ ...task, projectId: 'b' });
    const intent = {
      sourcePath,
      destinationPath,
      sourceHash: sha256(fs.readFileSync(sourcePath, 'utf8')),
      destinationHash: sha256(destinationBytes),
      destinationBytes,
    };
    fs.mkdirSync(join(root, '.raven-record-moves'));
    const intentPath = join(root, '.raven-record-moves', 'interrupted.json');
    fs.writeFileSync(intentPath, JSON.stringify(intent));
    if (phase !== 'intent') {
      fs.mkdirSync(join(root, 'b/tasks/board'), { recursive: true });
      fs.writeFileSync(destinationPath, destinationBytes);
    }
    if (phase === 'source-removed') fs.unlinkSync(sourcePath);
    return { task, intent, intentPath };
  }

  it.each(['intent', 'destination', 'source-removed'] as const)(
    'recovers one authoritative task after the %s boundary',
    (phase) => {
      const { task, intent, intentPath } = interruptedMove(phase);
      const reopened = store();
      expect(reopened.queryTasks({})).toMatchObject([{ id: task.id, projectId: 'b' }]);
      expect(fs.readFileSync(intent.destinationPath, 'utf8')).toBe(intent.destinationBytes);
      expect(fs.existsSync(intent.sourcePath)).toBe(false);
      expect(fs.existsSync(intentPath)).toBe(false);
      expect(store().queryTasks({})).toHaveLength(1);
    },
  );

  it.each(['source', 'destination', 'intent'] as const)(
    'reports %s corruption without deleting either task copy',
    (target) => {
      const { intent, intentPath } = interruptedMove('destination');
      if (target === 'intent')
        fs.writeFileSync(intentPath, JSON.stringify({ ...intent, destinationBytes: 'changed' }));
      else
        fs.writeFileSync(
          target === 'source' ? intent.sourcePath : intent.destinationPath,
          'owner edit',
        );
      const source = fs.readFileSync(intent.sourcePath, 'utf8');
      const destination = fs.readFileSync(intent.destinationPath, 'utf8');
      expect(() => store().queryTasks({})).toThrow();
      expect(fs.readFileSync(intent.sourcePath, 'utf8')).toBe(source);
      expect(fs.readFileSync(intent.destinationPath, 'utf8')).toBe(destination);
      expect(fs.existsSync(intentPath)).toBe(true);
    },
  );

  it('rejects an intent whose different path strings refer to the same source', () => {
    const { intent, intentPath } = interruptedMove('intent');
    const sourceBytes = fs.readFileSync(intent.sourcePath, 'utf8');
    const destinationPath = `${root}/a/tasks/board/../board/${intent.sourcePath.split('/').at(-1)}`;
    fs.writeFileSync(
      intentPath,
      JSON.stringify({
        ...intent,
        destinationPath,
        destinationBytes: sourceBytes,
        destinationHash: sha256(sourceBytes),
      }),
    );
    expect(() => store().queryTasks({})).toThrow();
    expect(fs.readFileSync(intent.sourcePath, 'utf8')).toBe(sourceBytes);
    expect(fs.existsSync(intentPath)).toBe(true);
  });

  it('does not recreate a project removed while a move was interrupted', () => {
    const { intent } = interruptedMove('intent');
    fs.rmSync(join(root, 'b'), { recursive: true });
    expect(() => store().queryTasks({})).toThrow();
    expect(fs.existsSync(join(root, 'b'))).toBe(false);
    expect(fs.existsSync(intent.sourcePath)).toBe(true);
  });
});
