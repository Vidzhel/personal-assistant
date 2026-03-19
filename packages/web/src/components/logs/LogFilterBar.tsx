'use client';

import type { LogFile } from '@/lib/api-client';

const BYTES_PER_KB = 1024;

const selectStyle = {
  background: 'var(--bg)',
  color: 'var(--text)',
  borderColor: 'var(--border)',
};

interface LogFilterBarProps {
  level: string;
  component: string;
  search: string;
  selectedFile: string;
  logFiles: LogFile[];
  onLevelChange: (v: string) => void;
  onComponentChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  onFileChange: (v: string) => void;
  onClear: () => void;
}

// eslint-disable-next-line max-lines-per-function -- JSX template with multiple filter controls
export function LogFilterBar({
  level,
  component,
  search,
  selectedFile,
  logFiles,
  onLevelChange,
  onComponentChange,
  onSearchChange,
  onFileChange,
  onClear,
}: LogFilterBarProps) {
  const hasFilters = !!(level || component || search);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={level}
        onChange={(e) => onLevelChange(e.target.value)}
        className="px-2 py-1.5 rounded text-sm border"
        style={selectStyle}
      >
        <option value="">All levels</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>

      <input
        type="text"
        placeholder="Component..."
        value={component}
        onChange={(e) => onComponentChange(e.target.value)}
        className="px-2 py-1.5 rounded text-sm border w-36"
        style={selectStyle}
      />

      <input
        type="text"
        placeholder="Search..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="px-2 py-1.5 rounded text-sm border w-48"
        style={selectStyle}
      />

      {logFiles.length > 0 && (
        <select
          value={selectedFile}
          onChange={(e) => onFileChange(e.target.value)}
          className="px-2 py-1.5 rounded text-sm border"
          style={selectStyle}
        >
          <option value="">Current log</option>
          {logFiles.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} ({(f.size / BYTES_PER_KB).toFixed(1)}KB)
            </option>
          ))}
        </select>
      )}

      {hasFilters && (
        <button
          onClick={onClear}
          className="px-2 py-1.5 rounded text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
