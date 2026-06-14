'use client';

import { TaskBoard } from '@/components/board/TaskBoard';
import type { ProjectTabProps } from './project-tab-registry';

export function ProjectTasksTab({ projectId }: ProjectTabProps) {
  return <TaskBoard projectId={projectId} />;
}
