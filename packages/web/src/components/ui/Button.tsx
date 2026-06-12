'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, { bg: string; fg: string; border: string; hover: string }> = {
  primary: { bg: 'var(--accent)', fg: '#ffffff', border: 'transparent', hover: 'var(--accent-hover)' },
  secondary: { bg: 'var(--bg-card)', fg: 'var(--text)', border: 'var(--border)', hover: 'var(--bg-hover)' },
  ghost: { bg: 'transparent', fg: 'var(--text-muted)', border: 'transparent', hover: 'var(--bg-hover)' },
  danger: { bg: 'var(--error)', fg: '#ffffff', border: 'transparent', hover: '#dc2626' },
};

const SIZE: Record<Size, string> = {
  sm: 'text-xs px-2 py-1',
  md: 'text-sm px-3 py-1.5',
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'onMouseEnter' | 'onMouseLeave'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, disabled, children, ...rest }: ButtonProps) {
  const v = VARIANT[variant];
  const off = disabled === true || loading === true;
  return (
    <button
      {...rest}
      disabled={off}
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 ${SIZE[size]}`}
      style={{ background: v.bg, color: v.fg, borderColor: v.border }}
      onMouseEnter={(e) => {
        if (!off) e.currentTarget.style.background = v.hover;
      }}
      onMouseLeave={(e) => {
        if (!off) e.currentTarget.style.background = v.bg;
      }}
    >
      {loading === true ? '…' : children}
    </button>
  );
}
