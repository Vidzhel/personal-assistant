'use client';

import { KnowledgeView } from '@/components/knowledge/KnowledgeView';
import type { ProjectTabProps } from './project-tab-registry';

export function ProjectKnowledgeTab({ projectId }: ProjectTabProps) {
  return <KnowledgeView projectId={projectId} />;
}
