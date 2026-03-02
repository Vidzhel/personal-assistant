'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type Project } from '@/lib/api-client';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api.getProject(id).then(setProject).catch(() => {});
  }, [id]);

  if (!project) {
    return <div className="p-8" style={{ color: 'var(--text-muted)' }}>Loading project...</div>;
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <h1 className="text-lg font-bold">{project.name}</h1>
        <div className="flex gap-1 mt-1">
          {project.skills.map((s) => (
            <span key={s} className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}>
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <ChatPanel projectId={id} />
      </div>
    </div>
  );
}
