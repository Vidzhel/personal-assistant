'use client';

import type { ReactNode } from 'react';

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  children: ReactNode;
}

export function Disclosure({ open, onToggle, header, children }: DisclosureProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full text-left"
        style={{ color: 'var(--text-muted)' }}
      >
        <span
          className="text-xs inline-block transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▸
        </span>
        {header}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
