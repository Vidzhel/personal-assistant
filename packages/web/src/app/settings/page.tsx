'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';

export default function SettingsPage() {
  const { health, fetchHealth } = useAppStore();

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>System configuration and status.</p>
      </div>

      <div className="p-4 rounded-lg space-y-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
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
            <p>{health ? `${Math.floor(health.uptime / 60)}m ${Math.floor(health.uptime % 60)}s` : '-'}</p>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)' }}>Loaded Skills</p>
            <p>{health?.skills.join(', ') ?? '-'}</p>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)' }}>API URL</p>
            <p className="font-mono text-xs">{process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001/api'}</p>
          </div>
        </div>
      </div>

      <div className="p-4 rounded-lg space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <h2 className="font-semibold">Configuration</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Edit <code className="font-mono text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-hover)' }}>config/skills.json</code> to enable/disable skills.
        </p>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Edit <code className="font-mono text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-hover)' }}>.env</code> for API keys and system settings.
        </p>
      </div>
    </div>
  );
}
