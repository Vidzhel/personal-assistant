'use client';

import { useState, useCallback } from 'react';
import { api } from '@/lib/api-client';

const PREVIEW_LENGTH = 80;

interface ProjectMemoryProps {
  systemPrompt: string | null;
  projectId: string;
  onSaved: (prompt: string | null) => void;
}

// eslint-disable-next-line max-lines-per-function -- project memory with collapsed/expanded states and save logic
export function ProjectMemory({ systemPrompt, projectId, onSaved }: ProjectMemoryProps) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = systemPrompt ? systemPrompt.slice(0, PREVIEW_LENGTH) : null;
  const truncated = systemPrompt && systemPrompt.length > PREVIEW_LENGTH;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    const previousPrompt = systemPrompt;
    onSaved(value || null);
    try {
      await api.updateProject(projectId, { systemPrompt: value || null });
      setExpanded(false);
    } catch {
      onSaved(previousPrompt ?? null);
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [value, projectId, systemPrompt, onSaved]);

  const handleCancel = useCallback(() => {
    setValue(systemPrompt ?? '');
    setExpanded(false);
    setError(null);
  }, [systemPrompt]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(systemPrompt ?? '');
          setExpanded(true);
        }}
        className="flex items-center gap-1.5 mt-2 text-xs cursor-pointer hover:opacity-80"
        style={{ color: 'var(--text-muted)' }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
        {preview ? (
          <span>
            {preview}
            {truncated && '...'}
          </span>
        ) : (
          <span style={{ fontStyle: 'italic' }}>Set project memory...</span>
        )}
      </button>
    );
  }

  return (
    <div className="mt-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded p-2 text-sm resize-y"
        style={{
          background: 'var(--bg-hover)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          minHeight: '80px',
          maxHeight: '200px',
        }}
        placeholder="Add project memory — instructions/context for all conversations..."
      />
      {error && (
        <div className="text-xs mt-1" style={{ color: '#ef4444' }}>
          {error}
        </div>
      )}
      <div className="flex gap-2 mt-1.5">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1 rounded text-xs font-medium"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleCancel}
          className="px-3 py-1 rounded text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
