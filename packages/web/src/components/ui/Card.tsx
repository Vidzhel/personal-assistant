'use client';

import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  interactive?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

export function Card({ children, interactive, selected, onClick, className = '' }: CardProps) {
  const style: CSSProperties = {
    background: 'var(--bg-card)',
    borderColor: selected === true ? 'var(--accent)' : 'var(--border)',
  };
  return (
    <div
      onClick={onClick}
      role={interactive === true ? 'button' : undefined}
      tabIndex={interactive === true ? 0 : undefined}
      className={`rounded-lg border p-3 ${interactive === true ? 'transition-colors' : ''} ${className}`}
      style={style}
      onMouseEnter={(e) => {
        if (interactive === true) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (interactive === true) e.currentTarget.style.background = 'var(--bg-card)';
      }}
    >
      {children}
    </div>
  );
}
