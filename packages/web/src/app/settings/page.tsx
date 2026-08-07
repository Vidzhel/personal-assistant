'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { usePolling } from '@/hooks/usePolling';
import { tierBadgeProps, tierRank } from '@/components/ui/badge-helpers';
import type { ActionCatalogEntry } from '@/lib/api-client';

const SECONDS_PER_MINUTE = 60;
const CATALOG_REFRESH_INTERVAL_MS = 30000;

// eslint-disable-next-line max-lines-per-function -- page component with system info display
export default function SettingsPage() {
  const { health, fetchHealth } = useAppStore();
  const { data: catalog } = usePolling<ActionCatalogEntry[]>(
    '/permissions/catalog',
    CATALOG_REFRESH_INTERVAL_MS,
  );

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          System configuration and status.
        </p>
      </div>

      <div
        className="p-4 rounded-lg space-y-4"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <h2 className="font-semibold">System Info</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p style={{ color: 'var(--text-muted)' }}>Status</p>
            <p style={{ color: health?.status === 'ok' ? 'var(--success)' : 'var(--error)' }}>
              {health?.status ?? 'Unknown'}
            </p>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)' }}>Uptime</p>
            <p>
              {health
                ? `${Math.floor(health.uptime / SECONDS_PER_MINUTE)}m ${Math.floor(health.uptime % SECONDS_PER_MINUTE)}s`
                : '-'}
            </p>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)' }}>Loaded Skills</p>
            <p>{health?.skills.join(', ') ?? '-'}</p>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)' }}>API URL</p>
            <p className="font-mono text-xs">
              {process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api'}
            </p>
          </div>
        </div>
      </div>

      <div
        className="p-4 rounded-lg space-y-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <h2 className="font-semibold">Configuration</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Capabilities live in{' '}
          <code
            className="font-mono text-xs px-1 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)' }}
          >
            library/
          </code>{' '}
          — add or edit a skill's{' '}
          <code
            className="font-mono text-xs px-1 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)' }}
          >
            config.json
          </code>{' '}
          to change what it declares (MCPs, actions, tiers). See the{' '}
          <a href="/skills" className="underline" style={{ color: 'var(--accent)' }}>
            Skills
          </a>{' '}
          page for what is currently loaded.
        </p>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Agents, templates, and schedules are scoped per project under{' '}
          <code
            className="font-mono text-xs px-1 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)' }}
          >
            projects/&lt;project&gt;/
          </code>{' '}
          — edit the YAML files there directly, or use the{' '}
          <a href="/agents" className="underline" style={{ color: 'var(--accent)' }}>
            Agents
          </a>{' '}
          page.
        </p>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Edit{' '}
          <code
            className="font-mono text-xs px-1 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)' }}
          >
            .env
          </code>{' '}
          for API keys and system settings.
        </p>
      </div>

      <ActionCatalogTable catalog={catalog ?? []} />
    </div>
  );
}

function ActionCatalogTable({ catalog }: { catalog: ActionCatalogEntry[] }) {
  const sorted = [...catalog].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));

  return (
    <div
      className="p-4 rounded-lg space-y-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold">Action Catalog</h2>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Every action the library declares, the tier it resolves to, and where that tier came from.
        Tiers are read-only here — override one by adding it to{' '}
        <code
          className="font-mono text-xs px-1 py-0.5 rounded"
          style={{ background: 'var(--bg-hover)' }}
        >
          config/permissions.json
        </code>
        .
      </p>

      {sorted.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No actions loaded.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="py-1.5 pr-4 font-medium">Action</th>
                <th className="py-1.5 pr-4 font-medium">Tier</th>
                <th className="py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <ActionCatalogRow key={entry.name} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActionCatalogRow({ entry }: { entry: ActionCatalogEntry }) {
  const tier = tierBadgeProps(entry.tier);
  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <td className="py-1.5 pr-4 font-mono text-xs">{entry.name}</td>
      <td className="py-1.5 pr-4">
        <span
          className="text-xs px-2 py-0.5 rounded"
          style={{ background: tier.bg, color: tier.fg }}
        >
          {entry.tier}
        </span>
      </td>
      <td className="py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        {entry.source}
      </td>
    </tr>
  );
}
