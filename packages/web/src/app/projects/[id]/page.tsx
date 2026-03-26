'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api, type Project } from '@/lib/api-client';
import { getProjectTabs, type ProjectTabDef } from '@/components/project/project-tab-registry';
import { InlineEditField } from '@/components/project/InlineEditField';

// eslint-disable-next-line max-lines-per-function -- page component with tab layout and project header
export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  const tabs: ProjectTabDef[] = getProjectTabs();

  useEffect(() => {
    api
      .getProject(id)
      .then(setProject)
      .catch(() => setError(true));
  }, [id]);

  const handleNewSession = useCallback(async () => {
    await api.createSession(id);
    setActiveTab('sessions');
  }, [id]);

  const handleUpdateName = useCallback(
    async (name: string) => {
      const updated = await api.updateProject(id, { name });
      setProject(updated);
    },
    [id],
  );

  const handleUpdateDescription = useCallback(
    async (description: string) => {
      const updated = await api.updateProject(id, { description: description || null });
      setProject(updated);
    },
    [id],
  );

  if (error) {
    return (
      <div className="p-8" style={{ color: 'var(--text-muted)' }}>
        Project not found.
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-8" style={{ color: 'var(--text-muted)' }}>
        Loading project...
      </div>
    );
  }

  const ActiveComponent = tabs.find((t) => t.key === activeTab)?.component;

  return (
    <div className="flex flex-col h-screen">
      {/* Compact project header — persists across all tabs */}
      <div className="px-6 pt-4 pb-0 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-start justify-between gap-4 mb-2">
          <div className="flex-1 min-w-0">
            <InlineEditField
              value={project.name}
              onSave={handleUpdateName}
              as="h1"
              className="text-lg font-bold"
            />
            <InlineEditField
              value={project.description ?? ''}
              onSave={handleUpdateDescription}
              placeholder="Add a description..."
              className="text-sm mt-0.5"
              style={{ color: 'var(--text-muted)' }}
            />
            <div className="flex gap-1 mt-1.5">
              {project.skills.map((s) => (
                <span
                  key={s}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={() => void handleNewSession()}
            className="px-3 py-1.5 rounded text-sm font-medium transition-colors shrink-0"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            New Chat
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
              style={{
                borderColor: activeTab === t.key ? 'var(--accent)' : 'transparent',
                color: activeTab === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {ActiveComponent && (
          <ActiveComponent
            projectId={id}
            projectName={project.name}
            project={project}
            onProjectUpdated={setProject}
            onNewSession={handleNewSession}
          />
        )}
      </div>
    </div>
  );
}
