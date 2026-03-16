const SELECT_STYLE = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
};

const CLEAR_STYLE = {
  background: 'var(--bg-hover)',
  color: 'var(--text-muted)',
  border: '1px solid var(--border)',
};

interface FilterBarProps {
  sources: string[];
  eventTypes: string[];
  selectedSource: string;
  selectedType: string;
  onSourceChange: (v: string) => void;
  onTypeChange: (v: string) => void;
  onClear: () => void;
}

function FilterSelect({
  value,
  onChange,
  label,
  placeholder,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-1.5 rounded-md text-sm"
      style={SELECT_STYLE}
      aria-label={label}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function FilterBar({
  sources,
  eventTypes,
  selectedSource,
  selectedType,
  onSourceChange,
  onTypeChange,
  onClear,
}: FilterBarProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <FilterSelect
        value={selectedSource}
        onChange={onSourceChange}
        label="Filter by source"
        placeholder="All sources"
        options={sources}
      />
      <FilterSelect
        value={selectedType}
        onChange={onTypeChange}
        label="Filter by event type"
        placeholder="All types"
        options={eventTypes}
      />
      {(selectedSource || selectedType) && (
        <button
          onClick={onClear}
          className="px-3 py-1.5 rounded-md text-sm cursor-pointer"
          style={CLEAR_STYLE}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
