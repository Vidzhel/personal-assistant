'use client';

interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  if (!diff) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No diff available
      </p>
    );
  }

  const lines = diff.split('\n');

  return (
    <pre
      className="text-xs overflow-x-auto p-3 rounded-md font-mono leading-relaxed"
      style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
    >
      {lines.map((line, i) => {
        let color = 'var(--text)';
        let bg = 'transparent';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = 'var(--success)';
          bg = 'rgba(34, 197, 94, 0.08)';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = 'var(--error)';
          bg = 'rgba(239, 68, 68, 0.08)';
        } else if (line.startsWith('@@')) {
          color = 'var(--accent)';
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          color = 'var(--text-muted)';
        }

        return (
          <span key={i} style={{ color, background: bg, display: 'block' }}>
            {line}
          </span>
        );
      })}
    </pre>
  );
}
