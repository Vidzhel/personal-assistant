'use client';

import { useState } from 'react';
import { type LogFile, type LogsResponse } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { LogFilterBar } from '@/components/logs/LogFilterBar';
import { LogList } from '@/components/logs/LogList';

const REFRESH_MS = 5000;
const FILES_REFRESH_MS = 30000;

export default function LogsPage() {
  const [level, setLevel] = useState('');
  const [component, setComponent] = useState('');
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState('');

  const queryParams = new URLSearchParams();
  queryParams.set('lines', '500');
  if (level) queryParams.set('level', level);
  if (component) queryParams.set('component', component);
  if (search) queryParams.set('search', search);

  const logsPath = selectedFile ? `/logs/${selectedFile}?${queryParams}` : `/logs?${queryParams}`;
  const { data: logsData, loading } = usePolling<LogsResponse>(logsPath, REFRESH_MS);
  const { data: logFiles } = usePolling<LogFile[]>('/logs/files', FILES_REFRESH_MS);

  const entries = logsData?.lines ?? [];

  return (
    <div className="p-8 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">System Logs</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Structured log output from all Raven subsystems.
          {logsData ? ` Showing ${entries.length} of ${logsData.total} lines.` : ''}
        </p>
      </div>

      <LogFilterBar
        level={level}
        component={component}
        search={search}
        selectedFile={selectedFile}
        logFiles={logFiles ?? []}
        onLevelChange={setLevel}
        onComponentChange={setComponent}
        onSearchChange={setSearch}
        onFileChange={setSelectedFile}
        onClear={() => {
          setLevel('');
          setComponent('');
          setSearch('');
        }}
      />

      <LogList entries={entries} loading={loading} />
    </div>
  );
}
