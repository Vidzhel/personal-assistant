'use client';

import Link from 'next/link';

interface StatusCardsProps {
  health: {
    status: string;
    uptime: number;
    skills: string[];
    agentQueue: number;
    agentsRunning: number;
  } | null;
  projectCount: number;
  templateCount: number;
  scheduleCount: number;
}

// eslint-disable-next-line max-lines-per-function, complexity -- status cards with conditional styling per card
export function StatusCards({
  health,
  projectCount,
  templateCount,
  scheduleCount,
}: StatusCardsProps) {
  const cards = [
    {
      label: 'Status',
      value:
        health?.status === 'ok' ? 'Online' : health?.status === 'degraded' ? 'Degraded' : 'Offline',
      color:
        health?.status === 'ok'
          ? 'var(--success)'
          : health?.status === 'degraded'
            ? 'var(--warning, #eab308)'
            : 'var(--error)',
      href: undefined as string | undefined,
    },
    {
      label: 'Skills',
      value: String(health?.skills?.length ?? 0),
      color: 'var(--accent)',
      href: '/skills',
    },
    {
      label: 'Projects',
      value: String(projectCount),
      color: 'var(--text)',
      href: '/projects',
    },
    {
      label: 'Agents Running',
      value: String(health?.agentsRunning ?? 0),
      color: health?.agentsRunning ? 'var(--warning)' : 'var(--text-muted)',
      href: '/agents',
    },
    {
      label: 'Templates',
      value: String(templateCount),
      color: 'var(--text-muted)',
      href: '/templates',
    },
    {
      label: 'Schedules',
      value: String(scheduleCount),
      color: 'var(--text-muted)',
      href: '/schedules',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {cards.map((card) => {
        const content = (
          <>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
              {card.label}
            </p>
            <p className="text-xl font-semibold" style={{ color: card.color }}>
              {card.value}
            </p>
          </>
        );

        if (card.href) {
          return (
            <Link
              key={card.label}
              href={card.href}
              className="p-4 rounded-lg transition-colors hover:brightness-110"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              {content}
            </Link>
          );
        }

        return (
          <div
            key={card.label}
            className="p-4 rounded-lg"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
