'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  'aria-label': string;
  children: ReactNode;
}

export function IconButton({ children, disabled, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors disabled:opacity-50"
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => {
        if (disabled !== true) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (disabled !== true) e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
