import type { ComponentType } from 'react';
import type { Project } from '@/lib/api-client';
import { ProjectOverviewTab } from './ProjectOverviewTab';
import { ProjectTasksTab } from './ProjectTasksTab';
import { ProjectKnowledgeTab } from './ProjectKnowledgeTab';
import { ProjectSessionsTab } from './ProjectSessionsTab';
import { ProjectAgentsTab } from './ProjectAgentsTab';
import { ProjectTemplatesTab } from './ProjectTemplatesTab';

export interface ProjectTabProps {
  projectId: string;
  projectName: string;
  project: Project;
  onProjectUpdated: (project: Project) => void;
  onNewSession: () => Promise<void>;
}

export interface ProjectTabDef {
  key: string;
  label: string;
  component: ComponentType<ProjectTabProps>;
}

const TAB_REGISTRY: Record<string, ProjectTabDef[]> = {
  default: [
    { key: 'overview', label: 'Overview', component: ProjectOverviewTab },
    { key: 'tasks', label: 'Tasks', component: ProjectTasksTab },
    { key: 'agents', label: 'Agents', component: ProjectAgentsTab },
    { key: 'templates', label: 'Templates', component: ProjectTemplatesTab },
    { key: 'knowledge', label: 'Knowledge', component: ProjectKnowledgeTab },
    { key: 'sessions', label: 'Sessions', component: ProjectSessionsTab },
  ],
};

export function getProjectTabs(projectType = 'default'): ProjectTabDef[] {
  return TAB_REGISTRY[projectType] ?? TAB_REGISTRY['default'];
}

export function registerProjectTabs(projectType: string, tabs: ProjectTabDef[]): void {
  TAB_REGISTRY[projectType] = tabs;
}
