'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

interface InlineEditFieldProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  as?: 'h1' | 'p';
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

// eslint-disable-next-line max-lines-per-function -- inline edit with editing/display states
export function InlineEditField({
  value,
  onSave,
  as = 'p',
  placeholder = 'Click to edit...',
  className = '',
  style,
}: InlineEditFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      setEditing(false);
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave, saving]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void handleSave();
      if (e.key === 'Escape') {
        setDraft(value);
        setEditing(false);
      }
    },
    [handleSave, value],
  );

  if (editing) {
    return (
      <div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void handleSave()}
          onKeyDown={handleKeyDown}
          disabled={saving}
          className={`bg-transparent outline-none border-b ${className}`}
          style={{ borderColor: 'var(--accent)', ...style }}
        />
        {error && (
          <p role="alert" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  const Tag = as;
  return (
    <Tag
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:opacity-80 ${className}`}
      style={style}
      title="Click to edit"
    >
      {value || (
        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{placeholder}</span>
      )}
    </Tag>
  );
}
