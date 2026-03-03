'use client';

interface StatusCardsProps {
  health: {
    status: string;
    uptime: number;
    skills: string[];
    agentQueue: number;
    agentsRunning: number;
  } | null;
  projectCount: number;
  scheduleCount: number;
}

export function StatusCards({ health, projectCount, scheduleCount }: StatusCardsProps) {
  const cards = [
    {
      label: 'Status',
      value: health?.status === 'ok' ? 'Online' : 'Offline',
      color: health?.status === 'ok' ? 'var(--success)' : 'var(--error)',
    },
    {
      label: 'Skills',
      value: String(health?.skills.length ?? 0),
      color: 'var(--accent)',
    },
    {
      label: 'Projects',
      value: String(projectCount),
      color: 'var(--text)',
    },
    {
      label: 'Agents Running',
      value: String(health?.agentsRunning ?? 0),
      color: health?.agentsRunning ? 'var(--warning)' : 'var(--text-muted)',
    },
    {
      label: 'Queue',
      value: String(health?.agentQueue ?? 0),
      color: 'var(--text-muted)',
    },
    {
      label: 'Schedules',
      value: String(scheduleCount),
      color: 'var(--text-muted)',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="p-4 rounded-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            {card.label}
          </p>
          <p className="text-xl font-semibold" style={{ color: card.color }}>
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
