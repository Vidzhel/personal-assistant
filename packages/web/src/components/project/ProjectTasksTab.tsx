'use client';

import { KanbanBoard } from '@/components/tasks/KanbanBoard';
import type { ProjectTabProps } from './project-tab-registry';

export function ProjectTasksTab({ projectId }: ProjectTabProps) {
  return <KanbanBoard projectId={projectId} />;
}
