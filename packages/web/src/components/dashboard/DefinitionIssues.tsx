'use client';

import { useState } from 'react';
import { apiRequest } from '@/lib/api-request';

export interface DefinitionIssue {
  source: string;
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

function ReloadDefinitionsButton({ onReload }: { onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/definitions/reload', { method: 'POST' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      onReload();
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void reload()}
        className="rounded border px-3 py-2 text-sm disabled:opacity-50"
      >
        {busy ? 'Reloading…' : 'Reload definitions'}
      </button>
    </>
  );
}

export function DefinitionIssues({
  issues,
  onReload,
}: {
  issues: DefinitionIssue[];
  onReload: () => void;
}) {
  if (issues.length === 0) return null;
  return (
    <section
      aria-label="Definition issues"
      className="rounded-lg border p-4 space-y-3"
      style={{ borderColor: 'var(--warning)' }}
    >
      <h2 className="font-semibold">Definitions need attention</h2>
      <p className="text-sm">Review these files, then reload to check your corrections.</p>
      <ul className="space-y-3 text-sm">
        {issues.map((issue) => (
          <li
            key={`${issue.source}:${issue.path}:${issue.code}:${issue.message}`}
            className="break-words"
          >
            <code>{issue.path}</code>
            <p style={{ color: 'var(--text-muted)' }}>{issue.message}</p>
          </li>
        ))}
      </ul>
      <ReloadDefinitionsButton onReload={onReload} />
    </section>
  );
}
