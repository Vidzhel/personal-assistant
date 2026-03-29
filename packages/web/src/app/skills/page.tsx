'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/app-store';
import type { Skill } from '@/lib/api-client';

interface SkillDomain {
  label: string;
  keywords: string[];
}

const DOMAINS: SkillDomain[] = [
  { label: 'File Management', keywords: ['document', 'file', 'media', 'pdf', 'image'] },
  {
    label: 'Communication',
    keywords: ['email', 'gmail', 'messaging', 'telegram', 'slack', 'chat'],
  },
  {
    label: 'Productivity',
    keywords: ['task', 'ticktick', 'schedule', 'calendar', 'briefing', 'digest', 'todo'],
  },
  { label: 'Finance', keywords: ['bank', 'finance', 'payment', 'invoice'] },
  { label: 'System', keywords: ['orchestrat', 'analysis', 'config', 'system', 'meta'] },
];

function classifySkill(skill: Skill): string {
  const text = `${skill.name} ${skill.description} ${skill.capabilities.join(' ')}`.toLowerCase();
  for (const domain of DOMAINS) {
    if (domain.keywords.some((kw) => text.includes(kw))) {
      return domain.label;
    }
  }
  return 'Other';
}

function groupSkills(skills: Skill[]): Map<string, Skill[]> {
  const groups = new Map<string, Skill[]>();
  for (const s of skills) {
    const domain = classifySkill(s);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain)!.push(s);
  }
  return groups;
}

// eslint-disable-next-line max-lines-per-function -- page component with grouped skill cards
export default function SkillsPage() {
  const { skills, fetchSkills } = useAppStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const grouped = groupSkills(skills);

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  // Stable order: defined domains first, then "Other"
  const orderedGroups = [...DOMAINS.map((d) => d.label), 'Other'].filter((label) =>
    grouped.has(label),
  );

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Skills</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Active integrations organized by domain.
        </p>
      </div>

      {orderedGroups.map((label) => {
        const domainSkills = grouped.get(label) ?? [];
        const isCollapsed = collapsed.has(label);

        return (
          <div key={label}>
            <button
              onClick={() => toggleGroup(label)}
              className="flex items-center gap-2 w-full text-left mb-3"
            >
              <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                {isCollapsed ? '>' : 'v'}
              </span>
              <h2 className="text-lg font-semibold">{label}</h2>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                ({domainSkills.length})
              </span>
            </button>

            {!isCollapsed && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-2">
                {domainSkills.map((s) => (
                  <SkillCard key={s.name} skill={s} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {skills.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          No skills loaded.
        </div>
      )}
    </div>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const [showTools, setShowTools] = useState(false);

  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex justify-between items-start">
        <h3 className="font-semibold">{skill.displayName}</h3>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          v{skill.version}
        </span>
      </div>
      <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
        {skill.description}
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex gap-1 flex-wrap">
          {skill.capabilities.map((c) => (
            <span
              key={c}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
            >
              {c}
            </span>
          ))}
        </div>
        {skill.mcpServers.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            MCP: {skill.mcpServers.join(', ')}
          </p>
        )}
        {skill.agentDefinitions.length > 0 && (
          <div>
            <button
              onClick={() => setShowTools(!showTools)}
              className="text-xs underline"
              style={{ color: 'var(--accent)' }}
            >
              {showTools ? 'Hide' : 'Show'} agents ({skill.agentDefinitions.length})
            </button>
            {showTools && (
              <div className="mt-1 flex gap-1 flex-wrap">
                {skill.agentDefinitions.map((a) => (
                  <span
                    key={a}
                    className="text-xs px-2 py-0.5 rounded"
                    style={{ background: 'rgba(59,130,246,0.15)', color: 'rgb(96,165,250)' }}
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
