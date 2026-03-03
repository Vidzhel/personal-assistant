'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api-client';

export default function ProjectsPage() {
  const { projects, skills, fetchProjects, fetchSkills } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  useEffect(() => {
    fetchProjects();
    fetchSkills();
  }, [fetchProjects, fetchSkills]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    await api.createProject({ name: name.trim(), skills: selectedSkills });
    setName('');
    setSelectedSkills([]);
    setShowCreate(false);
    fetchProjects();
  };

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Each project has its own chat session and skill context.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          New Project
        </button>
      </div>

      {showCreate && (
        <div
          className="p-4 rounded-lg space-y-3"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="w-full px-3 py-2 rounded text-sm outline-none"
            style={{
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
          <div>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Skills:
            </p>
            <div className="flex gap-2 flex-wrap">
              {skills.map((s) => (
                <button
                  key={s.name}
                  onClick={() =>
                    setSelectedSkills((prev) =>
                      prev.includes(s.name) ? prev.filter((n) => n !== s.name) : [...prev, s.name],
                    )
                  }
                  className="px-3 py-1 rounded text-xs"
                  style={{
                    background: selectedSkills.includes(s.name) ? 'var(--accent)' : 'var(--bg)',
                    color: selectedSkills.includes(s.name) ? 'white' : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {s.displayName}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={handleCreate}
            className="px-4 py-2 rounded text-sm"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Create
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="block p-4 rounded-lg transition-colors"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <h3 className="font-semibold">{p.name}</h3>
            {p.description && (
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                {p.description}
              </p>
            )}
            <div className="flex gap-1 mt-3 flex-wrap">
              {p.skills.map((s) => (
                <span
                  key={s}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
                >
                  {s}
                </span>
              ))}
            </div>
          </Link>
        ))}
        {projects.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No projects yet. Create one to start chatting with Raven.
          </p>
        )}
      </div>
    </div>
  );
}
