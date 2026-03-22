'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api-client';

const SYSTEM_ACCESS_LABELS: Record<string, string> = {
  none: 'No system file access (default)',
  read: 'Can read system files (config, code)',
  'read-write': 'Can read and modify system files (requires approval)',
};

// eslint-disable-next-line max-lines-per-function -- page component with project creation form and listing
export default function ProjectsPage() {
  const { projects, skills, fetchProjects, fetchSkills } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [systemAccess, setSystemAccess] = useState<'none' | 'read' | 'read-write'>('none');

  useEffect(() => {
    fetchProjects();
    fetchSkills();
  }, [fetchProjects, fetchSkills]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    await api.createProject({ name: name.trim(), skills: selectedSkills, systemAccess });
    setName('');
    setSelectedSkills([]);
    setSystemAccess('none');
    setShowCreate(false);
    fetchProjects();
  };

  // Separate meta-project and regular projects
  const metaProject = projects.find((p) => p.isMeta);
  const regularProjects = projects.filter((p) => !p.isMeta);

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
          <div>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              System Access:
            </p>
            <select
              value={systemAccess}
              onChange={(e) => setSystemAccess(e.target.value as 'none' | 'read' | 'read-write')}
              className="px-3 py-2 rounded text-sm outline-none"
              style={{
                background: 'var(--bg)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
              }}
            >
              {Object.entries(SYSTEM_ACCESS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Controls whether agents in this project can access Raven&apos;s system files
            </p>
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
        {/* Meta-project pinned first */}
        {metaProject && (
          <Link
            href={`/projects/${metaProject.id}`}
            className="block p-4 rounded-lg transition-colors"
            style={{
              background: 'var(--bg-card)',
              border: '2px solid var(--accent)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm" style={{ color: 'var(--accent)' }}>
                $
              </span>
              <h3 className="font-semibold">{metaProject.name}</h3>
            </div>
            {metaProject.description && (
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                {metaProject.description}
              </p>
            )}
            <div className="flex gap-1 mt-3">
              <span
                className="text-xs px-2 py-0.5 rounded"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                system
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded"
                style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
              >
                read-write
              </span>
            </div>
          </Link>
        )}

        {/* Regular projects */}
        {regularProjects.map((p) => (
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
              {p.systemAccess && p.systemAccess !== 'none' && (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                >
                  {p.systemAccess}
                </span>
              )}
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
