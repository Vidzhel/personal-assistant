import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { META_PROJECT_ID } from '@raven/shared';
import type { EventBusInterface, ExecutionTask, TaskTree } from '@raven/shared';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import {
  readTaskTreeRecords,
  treeLocation,
  writeTaskTreeRecord,
  type TaskTreeRecordDeps,
} from '../task-execution/task-tree-records.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const PROJECTS = [
  { id: META_PROJECT_ID, fsPath: 'system' },
  { id: 'project-a', fsPath: 'project-a' },
  { id: 'project-b', fsPath: 'project-b' },
];

type EventBusMock = EventBusInterface & {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

type Fixture = {
  root: string;
  projectsDir: string;
  deps: TaskTreeRecordDeps;
  eventBus: EventBusMock;
};

function createEventBus(): EventBusMock {
  return {
    emit: vi.fn((_event: unknown): void => undefined),
    on: vi.fn((_type: string, _handler: (event: unknown) => void): void => undefined),
    off: vi.fn((_type: string, _handler: (event: unknown) => void): void => undefined),
  } as unknown as EventBusMock;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'raven-tree-file-validation-'));
  const projectsDir = join(root, 'projects');
  for (const project of PROJECTS) mkdirSync(join(projectsDir, project.fsPath), { recursive: true });
  const eventBus = createEventBus();
  const deps = { projectsDir, projects: () => PROJECTS, eventBus };
  return { root, projectsDir, deps, eventBus };
}

async function withAsyncFixture(run: (data: Fixture) => Promise<void>): Promise<void> {
  const data = fixture();
  try {
    await run(data);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}

function withFixture(run: (data: Fixture) => void): void {
  const data = fixture();
  try {
    run(data);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}

function validDocument(
  id: string,
  projectId = 'project-a',
  tasks: ReadonlyArray<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    id,
    projectId,
    status: 'running',
    tasks,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function validTask(
  treeId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    parentTaskId: treeId,
    node: {
      type: 'agent',
      id,
      title: id,
      prompt: `Do ${id}`,
      blockedBy: [],
    },
    status: 'todo',
    artifacts: [],
    retryCount: 0,
    ...overrides,
  };
}

function writeDocument(
  data: Fixture,
  projectFsPath: string,
  filename: string,
  document: Record<string, unknown> | string,
): string {
  const directory = join(data.projectsDir, projectFsPath, 'tasks', 'trees');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, typeof document === 'string' ? document : stringify(document));
  return path;
}

describe('execution tree file validation boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects malformed YAML and strict unknown top-level keys', () => {
    withFixture((data) => {
      writeDocument(data, 'project-a', 'malformed.yaml', 'id: [\n');
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/Invalid execution tree record/);

      rmSync(join(data.projectsDir, 'project-a', 'tasks'), { recursive: true, force: true });
      writeDocument(data, 'project-a', 'unknown.yaml', {
        ...validDocument('unknown'),
        unexpected: true,
      });
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/Unrecognized key/);
    });
  });

  it('rejects duplicate tree IDs across project directories', () => {
    withFixture((data) => {
      writeDocument(data, 'project-a', 'same.yaml', validDocument('same', 'project-a'));
      writeDocument(data, 'project-b', 'same.yaml', validDocument('same', 'project-b'));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/Duplicate execution tree ID/);
    });
  });

  it('rejects a filename that does not match the document ID', () => {
    withFixture((data) => {
      writeDocument(data, 'project-a', 'wrong-name.yaml', validDocument('tree-1'));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/filename does not match/);
    });
  });

  it('rejects a tree whose project owner differs from its directory', () => {
    withFixture((data) => {
      writeDocument(data, 'project-a', 'tree-1.yaml', validDocument('tree-1', 'project-b'));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/project ownership mismatch/);
    });
  });

  it('rejects a symlinked root, project ancestor, and record directory', () => {
    withFixture((data) => {
      const realRoot = join(data.root, 'real-projects');
      mkdirSync(join(realRoot, 'project-a'), { recursive: true });
      rmSync(data.projectsDir, { recursive: true, force: true });
      symlinkSync(realRoot, data.projectsDir);
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/root must not be a symlink/);

      rmSync(data.projectsDir);
      mkdirSync(data.projectsDir);
      const outsideProject = join(data.root, 'outside-project');
      mkdirSync(outsideProject);
      rmSync(join(data.projectsDir, 'project-a'), { recursive: true, force: true });
      symlinkSync(outsideProject, join(data.projectsDir, 'project-a'));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/symlink/);

      rmSync(join(data.projectsDir, 'project-a'), { recursive: true, force: true });
      mkdirSync(join(data.projectsDir, 'project-a'), { recursive: true });
      const outsideTrees = join(data.root, 'outside-trees');
      mkdirSync(outsideTrees);
      symlinkSync(outsideTrees, join(data.projectsDir, 'project-a', 'tasks'));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/symlink/);
    });
  });

  it('treats a deleted record file as absent instead of retaining stale state', () => {
    withFixture((data) => {
      const path = writeDocument(data, 'project-a', 'tree-1.yaml', validDocument('tree-1'));
      expect(readTaskTreeRecords(data.deps)).toHaveLength(1);
      unlinkSync(path);
      expect(readTaskTreeRecords(data.deps)).toEqual([]);
    });
  });

  it.each([
    [
      'duplicate execution IDs',
      [validTask('tree-1', 'task-1'), validTask('tree-1', 'task-1')],
      /Duplicate execution task ID/,
    ],
    [
      'execution and node IDs differ',
      [
        validTask('tree-1', 'task-1', {
          node: { type: 'agent', id: 'node-1', title: 'node-1', prompt: 'Do it', blockedBy: [] },
        }),
      ],
      /Execution\/node ID mismatch/,
    ],
    [
      'execution has a different parent tree',
      [validTask('tree-1', 'task-1', { parentTaskId: 'tree-2' })],
      /wrong tree owner/,
    ],
  ] as const)('rejects %s', (_label, tasks, expected) => {
    withFixture((data) => {
      writeDocument(data, 'project-a', 'tree-1.yaml', validDocument('tree-1', 'project-a', tasks));
      expect(() => readTaskTreeRecords(data.deps)).toThrow(expected);
    });
  });

  it('rejects dependency cycles and missing condition targets', () => {
    withFixture((data) => {
      writeDocument(
        data,
        'project-a',
        'cycle.yaml',
        validDocument('cycle', 'project-a', [
          validTask('cycle', 'a', {
            node: { type: 'agent', id: 'a', title: 'a', prompt: 'a', blockedBy: ['b'] },
          }),
          validTask('cycle', 'b', {
            node: { type: 'agent', id: 'b', title: 'b', prompt: 'b', blockedBy: ['a'] },
          }),
        ]),
      );
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/dependency cycle/);

      rmSync(join(data.projectsDir, 'project-a', 'tasks'), { recursive: true, force: true });
      writeDocument(
        data,
        'project-a',
        'missing-target.yaml',
        validDocument('missing-target', 'project-a', [
          validTask('missing-target', 'condition', {
            node: {
              type: 'condition',
              id: 'condition',
              title: 'condition',
              expression: '{{ missing.result }}',
              blockedBy: [],
            },
          }),
        ]),
      );
      expect(() => readTaskTreeRecords(data.deps)).toThrow(/Missing condition target/);
    });
  });

  it.each(['write', 'rename'] as const)(
    'preserves the original record on failed atomic %s',
    (boundary) => {
      withFixture((data) => {
        const tree: TaskTree = {
          id: 'tree-1',
          projectId: 'project-a',
          status: 'running',
          tasks: new Map<string, ExecutionTask>(),
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        };
        const location = treeLocation(data.deps, 'project-a', tree.id);
        writeTaskTreeRecord(data.deps, location, tree);
        const original = readFileSync(location.filePath, 'utf8');
        const before = readTaskTreeRecords(data.deps);
        const fail = () => {
          throw new Error(`injected ${boundary} failure`);
        };
        if (boundary === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(fail);
        else vi.spyOn(fs, 'renameSync').mockImplementationOnce(fail);

        const changed: TaskTree = { ...tree, plan: 'must not publish' };
        expect(() => writeTaskTreeRecord(data.deps, location, changed)).toThrow(
          `injected ${boundary} failure`,
        );
        expect(readFileSync(location.filePath, 'utf8')).toBe(original);
        expect(readTaskTreeRecords(data.deps)).toEqual(before);
        expect(fs.readdirSync(location.directory)).toEqual(['tree-1.yaml']);
      });
    },
  );

  it.each(['write', 'rename'] as const)(
    'keeps a running tree unchanged when cancellation persistence fails at %s',
    async (boundary) => {
      await withAsyncFixture(async (data) => {
        const engine = new TaskExecutionEngine({
          projectsDir: data.projectsDir,
          projects: () => PROJECTS,
          eventBus: data.eventBus,
        });
        try {
          const tree = engine.createTree({
            id: `tree-${boundary}`,
            projectId: 'project-a',
            tasks: [
              {
                type: 'agent',
                id: `task-${boundary}`,
                title: 'Long-running task',
                prompt: 'Keep running',
                blockedBy: [],
              },
            ],
          });
          await engine.startTree(tree.id);
          const location = treeLocation(data.deps, tree.projectId, tree.id);
          const original = readFileSync(location.filePath, 'utf8');
          data.eventBus.emit.mockClear();
          const fail = () => {
            throw new Error(`injected ${boundary} failure`);
          };
          if (boundary === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(fail);
          else vi.spyOn(fs, 'renameSync').mockImplementationOnce(fail);

          await expect(Promise.resolve().then(() => engine.cancelTree(tree.id))).rejects.toThrow(
            `injected ${boundary} failure`,
          );

          const current = engine.getTree(tree.id);
          expect(current?.status).toBe('running');
          expect([...current!.tasks.values()].map((task) => task.status)).toEqual(['in_progress']);
          expect(readFileSync(location.filePath, 'utf8')).toBe(original);
          expect(data.eventBus.emit).not.toHaveBeenCalled();
          expect(fs.readdirSync(location.directory)).toEqual([`${tree.id}.yaml`]);
        } finally {
          await engine.stop();
        }
      });
    },
  );
});
