'use client';

import { useState } from 'react';
import { type MetricsResponse } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { formatDuration } from '@/lib/pipeline-helpers';

const POLL_INTERVAL_MS = 10_000;
const PERIODS = ['1h', '24h', '7d', '30d'] as const;
const DEFAULT_PERIOD = '24h';
const PERCENT_SYMBOL = '%';

interface StatsRow {
  name: string;
  total: number;
  successRate: number;
  avgDurationMs: number | null;
}

function PeriodSelector({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (p: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onSelect(p)}
          className="px-3 py-1 rounded text-xs font-medium transition-colors"
          style={{
            background: selected === p ? 'var(--accent)' : 'var(--bg-hover)',
            color: selected === p ? 'white' : 'var(--text-muted)',
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function TableHeader({ nameHeader }: { nameHeader: string }) {
  const headers = [
    { label: nameHeader, align: 'text-left' },
    { label: 'Count', align: 'text-right' },
    { label: 'Success Rate', align: 'text-right' },
    { label: 'Avg Duration', align: 'text-right' },
  ];
  return (
    <thead>
      <tr style={{ borderBottom: '1px solid var(--border)' }}>
        {headers.map((h) => (
          <th
            key={h.label}
            className={`${h.align} px-4 py-2 text-xs font-medium`}
            style={{ color: 'var(--text-muted)' }}
          >
            {h.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TableRow({ row }: { row: StatsRow }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td className="px-4 py-2 font-medium">{row.name}</td>
      <td className="px-4 py-2 text-right">{row.total}</td>
      <td className="px-4 py-2 text-right">
        {row.successRate}
        {PERCENT_SYMBOL}
      </td>
      <td className="px-4 py-2 text-right" style={{ color: 'var(--text-muted)' }}>
        {row.avgDurationMs !== null ? formatDuration(row.avgDurationMs) : '-'}
      </td>
    </tr>
  );
}

function StatsTable({
  title,
  nameHeader,
  rows,
}: {
  title: string;
  nameHeader: string;
  rows: StatsRow[];
}) {
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border)', background: 'var(--bg-card)' }}
    >
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No data for this period
        </p>
      ) : (
        <table className="w-full text-sm">
          <TableHeader nameHeader={nameHeader} />
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.name} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SummaryCards({ data }: { data: MetricsResponse | null }) {
  const taskTotal = String(data?.tasks.total ?? 0);
  const taskSuccessRate = `${data?.tasks.successRate ?? 0}${PERCENT_SYMBOL}`;
  const taskAvgDuration =
    data?.tasks.avgDurationMs != null ? formatDuration(data.tasks.avgDurationMs) : '-';
  const pipelineTotal = String(data?.pipelines.total ?? 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <SummaryCard label="Total Tasks" value={taskTotal} />
      <SummaryCard label="Task Success Rate" value={taskSuccessRate} />
      <SummaryCard label="Avg Task Duration" value={taskAvgDuration} />
      <SummaryCard label="Pipeline Runs" value={pipelineTotal} />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-20 rounded-lg animate-pulse"
          style={{ background: 'var(--bg-hover)' }}
        />
      ))}
    </div>
  );
}

function toStatsRows(data: MetricsResponse | null): {
  skillRows: StatsRow[];
  pipelineRows: StatsRow[];
} {
  const skillRows = (data?.perSkill ?? []).map((s) => ({
    name: s.skillName,
    total: s.total,
    successRate: s.successRate,
    avgDurationMs: s.avgDurationMs,
  }));
  const pipelineRows = (data?.perPipeline ?? []).map((p) => ({
    name: p.pipelineName,
    total: p.total,
    successRate: p.successRate,
    avgDurationMs: p.avgDurationMs,
  }));
  return { skillRows, pipelineRows };
}

export default function MetricsPage() {
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const { data, loading } = usePolling<MetricsResponse>(
    `/metrics?period=${period}`,
    POLL_INTERVAL_MS,
  );
  const { skillRows, pipelineRows } = toStatsRows(data);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Execution Metrics</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Task and pipeline performance overview.
          </p>
        </div>
        <PeriodSelector selected={period} onSelect={setPeriod} />
      </div>

      {loading && !data ? (
        <LoadingSkeleton />
      ) : (
        <>
          <SummaryCards data={data} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <StatsTable title="Per-Skill Breakdown" nameHeader="Skill" rows={skillRows} />
            <StatsTable title="Per-Pipeline Breakdown" nameHeader="Pipeline" rows={pipelineRows} />
          </div>
        </>
      )}
    </div>
  );
}
