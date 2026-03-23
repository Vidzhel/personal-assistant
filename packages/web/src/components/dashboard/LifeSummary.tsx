'use client';

import Link from 'next/link';

interface SummaryCard {
  label: string;
  value: number | string;
  href: string;
  color?: string;
}

interface LifeSummaryProps {
  cards: SummaryCard[];
}

export function LifeSummary({ cards }: LifeSummaryProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <Link
          key={card.label}
          href={card.href}
          className="p-4 rounded-lg transition-colors hover:opacity-80"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {card.label}
          </p>
          <p
            className="text-2xl font-bold mt-1"
            style={{ color: card.color ?? 'var(--text)' }}
          >
            {card.value}
          </p>
        </Link>
      ))}
    </div>
  );
}
