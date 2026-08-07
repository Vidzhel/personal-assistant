'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/app-store';
import type { Skill, SkillAction } from '@/lib/api-client';

// Tier chip colors — green/yellow/red mirror the permission engine's tiers
// (packages/core/src/permission-engine). Unknown tiers fall back to neutral.
const TIER_CHIP: Record<string, { bg: string; fg: string }> = {
  green: { bg: 'rgba(34,197,94,0.15)', fg: 'rgb(74,222,128)' },
  yellow: { bg: 'rgba(234,179,8,0.15)', fg: 'rgb(250,204,21)' },
  red: { bg: 'rgba(239,68,68,0.15)', fg: 'rgb(248,113,113)' },
};

function tierChipStyle(tier: string): { bg: string; fg: string } {
  return TIER_CHIP[tier] ?? { bg: 'var(--bg-hover)', fg: 'var(--text-muted)' };
}

function domainLabel(domain: string): string {
  if (!domain) return 'Other';
  return domain
    .split(/[-/]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function groupSkillsByDomain(skills: Skill[]): Map<string, Skill[]> {
  const groups = new Map<string, Skill[]>();
  for (const s of skills) {
    const label = domainLabel(s.domain);
    const existing = groups.get(label);
    if (existing) {
      existing.push(s);
    } else {
      groups.set(label, [s]);
    }
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

  const grouped = groupSkillsByDomain(skills);
  const orderedGroups = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));

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

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Skills</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Capability library skills, organized by domain.
        </p>
      </div>

      {orderedGroups.map((label) => {
        const domainSkills = grouped.get(label) ?? [];
        const isCollapsed = collapsed.has(label);

        return (
          <div key={label}>
            <button
              onClick={() => toggleGroup(label)}
              className="flex items-center gap-2 w-full text-left mb-3 cursor-pointer"
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

function ActionTierChip({ action }: { action: SkillAction }) {
  const c = tierChipStyle(action.tier);
  return (
    <span
      className="text-xs px-2 py-0.5 rounded"
      style={{ background: c.bg, color: c.fg }}
      title={`${action.name} — ${action.tier} tier`}
    >
      {action.name}
    </span>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex justify-between items-start gap-2">
        <h3 className="font-semibold">{skill.name}</h3>
        <span
          className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
        >
          {domainLabel(skill.domain)}
        </span>
      </div>
      <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
        {skill.description}
      </p>
      <div className="mt-3 space-y-2">
        {skill.actions.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {skill.actions.map((a) => (
              <ActionTierChip key={a.name} action={a} />
            ))}
          </div>
        )}
        {skill.mcps.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            MCP: {skill.mcps.join(', ')}
          </p>
        )}
        {skill.model && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Model: {skill.model}
          </p>
        )}
      </div>
    </div>
  );
}
