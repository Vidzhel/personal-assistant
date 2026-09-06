'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  getProjectFileInfo,
  listProjectFiles,
  type ProjectFileEntry,
  type ProjectFileInfo,
  type ProjectFileListing,
  type WorkspaceSource,
} from '@/lib/workspace-api';
import { FilePreview } from './FilePreview';

const KIB = 1024;
const MIB = KIB * KIB;

interface ProjectFileBrowserProps {
  projectId: string;
  sources: WorkspaceSource[];
  defaultSourceId?: string;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function sourceOptions(sources: WorkspaceSource[]): WorkspaceSource[] {
  return sources.filter((source) => source.sourceType === 'folder');
}

function Breadcrumbs({ path, onChange }: { path: string; onChange: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <nav aria-label="File breadcrumbs" className="flex items-center gap-1 overflow-x-auto text-xs">
      <button className="shrink-0 underline" onClick={() => onChange('')}>
        Home
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join('/');
        return (
          <span key={target} className="shrink-0">
            {' / '}
            <button className="underline" onClick={() => onChange(target)}>
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function EntryRow({
  entry,
  onOpen,
}: {
  entry: ProjectFileEntry;
  onOpen: (entry: ProjectFileEntry) => void;
}) {
  return (
    <li
      className="flex items-center justify-between gap-2 border-b py-2 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <button
        className="min-w-0 truncate text-left text-sm underline"
        onClick={() => onOpen(entry)}
      >
        {entry.type === 'directory' ? '📁 ' : '📄 '}
        {entry.name}
      </button>
      <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
        {entry.type === 'directory' ? 'Folder' : formatSize(entry.size)}
      </span>
    </li>
  );
}

function formatSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${Math.round(bytes / KIB)} KiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function Listing({
  listing,
  onOpen,
}: {
  listing: ProjectFileListing;
  onOpen: (entry: ProjectFileEntry) => void;
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {listing.entries.length} entries{listing.truncated ? ' (listing truncated)' : ''}
        </span>
      </div>
      {listing.entries.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          This folder is empty.
        </p>
      ) : (
        <ul>
          {listing.entries.map((entry) => (
            <EntryRow key={entry.path} entry={entry} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

function useListing(input: {
  projectId: string;
  sourceId: string;
  path: string;
  refreshKey: number;
}) {
  const [listing, setListing] = useState<ProjectFileListing>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setListing(undefined);
    setError(undefined);
    void listProjectFiles(input.projectId, input.sourceId, input.path)
      .then((next) => {
        if (active) setListing(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause, 'Could not list this folder.'));
      });
    return () => {
      active = false;
    };
  }, [input.path, input.projectId, input.refreshKey, input.sourceId]);
  return { listing, error };
}

function useFileInfo(projectId: string, sourceId: string, entry: ProjectFileEntry | undefined) {
  const [info, setInfo] = useState<ProjectFileInfo>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!entry || entry.type !== 'file') {
      setInfo(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setInfo(undefined);
    setError(undefined);
    void getProjectFileInfo(projectId, sourceId, entry.path)
      .then((next) => {
        if (active) setInfo(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause, 'Could not inspect this file.'));
      });
    return () => {
      active = false;
    };
  }, [entry, projectId, sourceId]);
  return { info, error };
}

function BrowserControls({
  sourceId,
  folders,
  path,
  loading,
  onSourceChange,
  onPathChange,
  onRefresh,
}: {
  sourceId: string;
  folders: WorkspaceSource[];
  path: string;
  loading: boolean;
  onSourceChange: (sourceId: string) => void;
  onPathChange: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">Files</h3>
        <Button size="sm" onClick={onRefresh} disabled={loading}>
          Refresh
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="workspace-file-source">
          Source
        </label>
        <select
          id="workspace-file-source"
          value={sourceId}
          onChange={(event) => onSourceChange(event.target.value)}
          className="min-w-0 max-w-full rounded border px-2 py-1 text-sm"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
        >
          <option value="home">Managed home</option>
          {folders.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
      </div>
      <Breadcrumbs path={path} onChange={onPathChange} />
    </>
  );
}

interface PathJumpInput {
  projectId: string;
  sourceId: string;
  sourceVersion: string;
}

function usePathJump(input: PathJumpInput, onResolved: (info: ProjectFileInfo) => void) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setPath('');
    setError(undefined);
    setLoading(false);
  }, [input.projectId, input.sourceId, input.sourceVersion]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const submit = useCallback(async () => {
    const nextPath = path;
    if (!nextPath.trim()) {
      setError('Enter a relative file or folder path.');
      return;
    }
    const current = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const info = await getProjectFileInfo(input.projectId, input.sourceId, nextPath);
      if (current === request.current) onResolved(info);
    } catch (cause: unknown) {
      if (current === request.current) setError(message(cause, 'Could not open that path.'));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [input.projectId, input.sourceId, onResolved, path]);
  return { path, setPath, error, loading, submit };
}

function PathJump({
  projectId,
  sourceId,
  sourceVersion,
  onResolved,
}: {
  projectId: string;
  sourceId: string;
  sourceVersion: string;
  onResolved: (info: ProjectFileInfo) => void;
}) {
  const jump = usePathJump({ projectId, sourceId, sourceVersion }, onResolved);
  return (
    <form
      className="flex min-w-0 flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void jump.submit();
      }}
    >
      <label className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="block">File or folder path</span>
        <input
          value={jump.path}
          onChange={(event) => jump.setPath(event.target.value)}
          placeholder="e.g. src/index.ts"
          disabled={jump.loading}
          className="w-full min-w-0 rounded border px-2 py-1 text-sm"
        />
      </label>
      <Button type="submit" size="sm" loading={jump.loading} disabled={jump.loading}>
        Open
      </Button>
      {jump.error && (
        <p role="alert" className="basis-full text-sm" style={{ color: 'var(--error)' }}>
          {jump.error}
        </p>
      )}
    </form>
  );
}

function BrowserOutput({
  error,
  listing,
  infoError,
  info,
  onOpen,
}: {
  error?: string;
  listing?: ProjectFileListing;
  infoError?: string;
  info?: ProjectFileInfo;
  onOpen: (entry: ProjectFileEntry) => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
      {!error && !listing && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading files…
        </p>
      )}
      {listing && <Listing listing={listing} onOpen={onOpen} />}
      {infoError && (
        <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
          {infoError}
        </p>
      )}
      {info && <FilePreview projectId={info.projectId} sourceId={info.sourceId} info={info} />}
    </>
  );
}

function useBrowserNavigation(initialSource: string, projectId: string, sourceSignature: string) {
  const [sourceId, setSourceId] = useState(initialSource);
  const [path, setPath] = useState('');
  const [entry, setEntry] = useState<ProjectFileEntry>();
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    setSourceId(initialSource);
    setPath('');
    setEntry(undefined);
    setRefreshKey((value) => value + 1);
  }, [initialSource, projectId, sourceSignature]);
  return {
    sourceId,
    path,
    entry,
    refreshKey,
    openEntry: (next: ProjectFileEntry) => {
      setEntry(next.type === 'file' ? next : undefined);
      if (next.type === 'directory') setPath(next.path);
    },
    changeSource: (next: string) => {
      setSourceId(next);
      setPath('');
      setEntry(undefined);
    },
    changePath: (next: string) => {
      setPath(next);
      setEntry(undefined);
    },
    refresh: () => {
      setEntry(undefined);
      setRefreshKey((value) => value + 1);
    },
  };
}

function browserSourceState(folders: WorkspaceSource[], defaultSourceId?: string) {
  const initialSource =
    defaultSourceId && folders.some((source) => source.id === defaultSourceId)
      ? defaultSourceId
      : 'home';
  const sourceSignature = folders
    .map((source) => `${source.id}:${source.uri}:${source.updatedAt ?? ''}`)
    .join('|');
  return { initialSource, sourceSignature };
}

export function ProjectFileBrowser({
  projectId,
  sources,
  defaultSourceId,
}: ProjectFileBrowserProps) {
  const folders = useMemo(() => sourceOptions(sources), [sources]);
  const { initialSource, sourceSignature } = browserSourceState(folders, defaultSourceId);
  const navigation = useBrowserNavigation(initialSource, projectId, sourceSignature);
  const resolvePath = useCallback(
    (info: ProjectFileInfo) => {
      if (info.type === 'directory') navigation.changePath(info.path);
      else navigation.openEntry(info);
    },
    [navigation],
  );
  const { listing, error } = useListing({
    projectId,
    sourceId: navigation.sourceId,
    path: navigation.path,
    refreshKey: navigation.refreshKey,
  });
  const { info, error: infoError } = useFileInfo(projectId, navigation.sourceId, navigation.entry);

  return (
    <section className="space-y-3" aria-label="Project files">
      <BrowserControls
        sourceId={navigation.sourceId}
        folders={folders}
        path={navigation.path}
        loading={!listing && !error}
        onSourceChange={navigation.changeSource}
        onPathChange={navigation.changePath}
        onRefresh={navigation.refresh}
      />
      <PathJump
        projectId={projectId}
        sourceId={navigation.sourceId}
        sourceVersion={sourceSignature}
        onResolved={resolvePath}
      />
      <BrowserOutput
        error={error}
        listing={listing}
        infoError={infoError}
        info={info}
        onOpen={navigation.openEntry}
      />
    </section>
  );
}
