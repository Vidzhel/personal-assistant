import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { META_PROJECT_ID } from '@raven/shared';
import { createTaskStore, type TaskStore } from '../../task-manager/task-store.ts';

const PROJECTS = [
  ['proj-1', 'proj-1'],
  ['proj-2', 'proj-2'],
  ['proj-filter', 'proj-filter'],
  ['proj-inherit', 'proj-inherit'],
  ['count-proj', 'count-proj'],
] as const;

export function createTaskStoreFixture(
  projectsDir: string,
  eventBus: Parameters<typeof createTaskStore>[0]['eventBus'],
): TaskStore {
  const projects = [
    { id: META_PROJECT_ID, fsPath: 'system' },
    ...PROJECTS.map(([id, fsPath]) => ({ id, fsPath })),
  ];
  for (const project of projects) mkdirSync(join(projectsDir, project.fsPath), { recursive: true });
  return createTaskStore({ projectsDir, projects: () => projects, eventBus });
}
