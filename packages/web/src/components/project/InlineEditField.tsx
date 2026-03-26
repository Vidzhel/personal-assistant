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
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave]);

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
