'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';

interface Props {
  onCreated: () => void;
  onCancel: () => void;
}

// eslint-disable-next-line max-lines-per-function -- React form component
export function CreateSuiteForm({ onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!name || !displayName) {
      setError('Name and display name are required');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      setError('Name must be kebab-case');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.createSuite({ name, displayName, description });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rounded border p-3 space-y-3"
      style={{ borderColor: 'var(--accent)', background: 'var(--bg-hover)' }}
    >
      <h4 className="text-sm font-medium">Create New Suite</h4>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="suite-name (kebab-case)"
        className="w-full px-2 py-1 rounded border text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      />

      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Display Name"
        className="w-full px-2 py-1 rounded border text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      />

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="w-full px-2 py-1 rounded border text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      />

      {error && (
        <p className="text-xs" style={{ color: '#ef4444' }}>
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="px-3 py-1 rounded text-xs font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          {saving ? 'Creating...' : 'Create Suite'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1 rounded text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
