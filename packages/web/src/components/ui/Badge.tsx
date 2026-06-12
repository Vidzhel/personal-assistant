'use client';

import type { CSSProperties } from 'react';
import { statusBadgeProps, sourceBadgeProps, type BadgeStyle } from './badge-helpers';

export function Badge({ label, bg, fg, title }: BadgeStyle & { title?: string }) {
  const style: CSSProperties = { background: bg, color: fg };
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap"
      style={style}
      title={title}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge {...statusBadgeProps(status)} title={status} />;
}

export function SourceBadge({ source }: { source: string }) {
  return <Badge {...sourceBadgeProps(source)} title={source} />;
}
