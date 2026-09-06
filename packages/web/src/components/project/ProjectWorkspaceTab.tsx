'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectWorkspace, WorkspaceUpdate } from '@raven/shared';
import { Button } from '@/components/ui/Button';
import { ModelConfigControl } from '@/components/model-config/ModelConfigControl';
import type { ProjectTabProps } from './project-tab-registry';
import {
  createWorkspaceSource,
  deleteWorkspaceSource,
  getWorkspace,
  updateWorkspace,
  updateWorkspaceSource,
  type CreateWorkspaceSource,
  type ProjectWorkspaceResponse,
  type WorkspaceSource,
} from '@/lib/workspace-api';
import { ProjectFileBrowser } from './ProjectFileBrowser';
import { ProjectReadiness } from './ProjectReadiness';

const SOURCE_TYPES: Array<WorkspaceSource['sourceType']> = [
  'folder',
  'url',
  'file',
  'gdrive',
  'other',
];

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function contextFilesValue(source: WorkspaceSource): string {
  return source.contextFiles?.join('\n') ?? '';
}

function parseContextFiles(value: string): string[] {
  const paths = value
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  return paths;
}

function ModeSelector({
  mode,
  disabled,
  onChange,
}: {
  mode: ProjectWorkspace['execution']['mode'];
  disabled: boolean;
  onChange: (mode: ProjectWorkspace['execution']['mode']) => void;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block">Mode</span>
      <select
        value={mode}
        onChange={(event) => onChange(event.target.value as typeof mode)}
        disabled={disabled}
        className="w-full rounded border px-2 py-2"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
      >
        <option value="default">Default Raven tools</option>
        <option value="auto">Auto native tools</option>
        <option value="full">Full trusted host</option>
      </select>
    </label>
  );
}

function SourceSelector({
  sourceId,
  folders,
  disabled,
  onChange,
}: {
  sourceId: string;
  folders: WorkspaceSource[];
  disabled: boolean;
  onChange: (sourceId: string) => void;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block">Working folder</span>
      <select
        value={sourceId}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="w-full rounded border px-2 py-2"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
      >
        <option value="">Managed project home</option>
        {folders.map((source) => (
          <option key={source.id} value={source.id}>
            {source.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExecutionSelectors({
  mode,
  sourceId,
  folders,
  disabled,
  onModeChange,
  onSourceChange,
}: {
  mode: ProjectWorkspace['execution']['mode'];
  sourceId: string;
  folders: WorkspaceSource[];
  disabled: boolean;
  onModeChange: (mode: ProjectWorkspace['execution']['mode']) => void;
  onSourceChange: (sourceId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ModeSelector mode={mode} disabled={disabled} onChange={onModeChange} />
      <SourceSelector
        sourceId={sourceId}
        folders={folders}
        disabled={disabled}
        onChange={onSourceChange}
      />
    </div>
  );
}

function ExecutionSettings({
  workspace,
  disabled,
  onSave,
}: {
  workspace: ProjectWorkspaceResponse;
  disabled: boolean;
  onSave: (patch: WorkspaceUpdate) => Promise<boolean>;
}) {
  const [mode, setMode] = useState(workspace.execution.mode);
  const [sourceId, setSourceId] = useState(workspace.execution.sourceId ?? '');
  useEffect(() => {
    setMode(workspace.execution.mode);
    setSourceId(workspace.execution.sourceId ?? '');
  }, [workspace]);
  const folders = workspace.sources.filter((source) => source.sourceType === 'folder');
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold">Execution</h3>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Paths are on the Raven server. Full mode is trusted host execution and does not isolate
        paths.
      </p>
      <ExecutionSelectors
        mode={mode}
        sourceId={sourceId}
        folders={folders}
        disabled={disabled}
        onModeChange={setMode}
        onSourceChange={setSourceId}
      />
      <Button
        onClick={() => void onSave({ execution: { mode, sourceId: sourceId || null } })}
        loading={disabled}
        disabled={disabled}
      >
        Save execution settings
      </Button>
    </section>
  );
}

function ProjectModelSettings({
  workspace,
  disabled,
  onSave,
  onCatalogLoaded,
}: {
  workspace: ProjectWorkspaceResponse;
  disabled: boolean;
  onSave: (patch: WorkspaceUpdate) => Promise<boolean>;
  onCatalogLoaded: () => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold">Model defaults</h3>
      {workspace.modelConfigError && (
        <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
          Effective model unavailable: {workspace.modelConfigError}
        </p>
      )}
      <ModelConfigControl
        scope="project"
        value={workspace.execution.modelConfig}
        effectiveValue={workspace.effectiveModelConfig}
        disabled={disabled}
        onSave={(modelConfig) => onSave({ execution: { modelConfig } })}
        onCatalogLoaded={workspace.modelConfigError ? onCatalogLoaded : undefined}
      />
    </section>
  );
}

function SourceIdentityFields({
  source,
  disabled,
  uri,
  label,
  onUri,
  onLabel,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  uri: string;
  label: string;
  onUri: (value: string) => void;
  onLabel: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input
        value={label}
        onChange={(event) => onLabel(event.target.value)}
        disabled={disabled}
        aria-label={`${source.id} label`}
        placeholder="Label"
        className="rounded border px-2 py-1.5 text-sm"
      />
      <input
        value={uri}
        onChange={(event) => onUri(event.target.value)}
        disabled={disabled}
        aria-label={`${source.id} path`}
        placeholder="Server path or URL"
        className="rounded border px-2 py-1.5 text-sm"
      />
    </div>
  );
}

function SourceFields({
  source,
  disabled,
  uri,
  label,
  description,
  contextFiles,
  onUri,
  onLabel,
  onDescription,
  onContextFiles,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  uri: string;
  label: string;
  description: string;
  contextFiles: string;
  onUri: (value: string) => void;
  onLabel: (value: string) => void;
  onDescription: (value: string) => void;
  onContextFiles: (value: string) => void;
}) {
  return (
    <>
      <SourceIdentityFields
        source={source}
        disabled={disabled}
        uri={uri}
        label={label}
        onUri={onUri}
        onLabel={onLabel}
      />
      <SourceDescription
        source={source}
        disabled={disabled}
        description={description}
        onChange={onDescription}
      />
      <SourceContextFiles
        source={source}
        disabled={disabled}
        value={contextFiles}
        onChange={onContextFiles}
      />
    </>
  );
}

function SourceDescription({
  source,
  disabled,
  description,
  onChange,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  description: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={description}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      aria-label={`${source.id} description`}
      placeholder="Description (optional)"
      className="w-full rounded border px-2 py-1.5 text-sm"
    />
  );
}

function SourceContextFiles({
  source,
  disabled,
  value,
  onChange,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  if (source.sourceType !== 'folder') return null;
  return (
    <>
      <FolderPathHint />
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={`${source.id} context files`}
        placeholder="Context files, one relative path per line"
        rows={2}
        className="w-full rounded border px-2 py-1.5 text-sm"
      />
    </>
  );
}

function FolderPathHint() {
  return (
    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
      Use a folder path visible to Raven. With the default Docker workspace mount, use{' '}
      <code>{'/workspace/<repository>'}</code>.
    </p>
  );
}

function SourceRowHeader({ source, selected }: { source: WorkspaceSource; selected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <strong className="truncate">{source.label}</strong>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {selected ? 'Selected cwd' : source.sourceType}
      </span>
    </div>
  );
}

function SourceRowEditor({
  source,
  disabled,
  values,
  onChange,
  onSave,
  onDelete,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  values: { uri: string; label: string; description: string; contextFiles: string };
  onChange: {
    uri: (value: string) => void;
    label: (value: string) => void;
    description: (value: string) => void;
    contextFiles: (value: string) => void;
  };
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <SourceFields
        source={source}
        disabled={disabled}
        {...values}
        onUri={onChange.uri}
        onLabel={onChange.label}
        onDescription={onChange.description}
        onContextFiles={onChange.contextFiles}
      />
      <SourceRowActions disabled={disabled} onSave={onSave} onDelete={onDelete} />
    </>
  );
}

function SourceRowActions({
  disabled,
  onSave,
  onDelete,
}: {
  disabled: boolean;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={onSave} loading={disabled} disabled={disabled}>
        Save source
      </Button>
      <Button size="sm" variant="danger" onClick={onDelete} disabled={disabled}>
        Remove
      </Button>
    </div>
  );
}

function useSourceDraft(source: WorkspaceSource) {
  const [uri, setUri] = useState(source.uri);
  const [label, setLabel] = useState(source.label);
  const [description, setDescription] = useState(source.description ?? '');
  const [contextFiles, setContextFiles] = useState(contextFilesValue(source));
  useEffect(() => {
    setUri(source.uri);
    setLabel(source.label);
    setDescription(source.description ?? '');
    setContextFiles(contextFilesValue(source));
  }, [source]);
  return {
    values: { uri, label, description, contextFiles },
    onChange: {
      uri: setUri,
      label: setLabel,
      description: setDescription,
      contextFiles: setContextFiles,
    },
  };
}

function SourceRow({
  source,
  disabled,
  selected,
  onSave,
  onDelete,
}: {
  source: WorkspaceSource;
  disabled: boolean;
  selected: boolean;
  onSave: (id: string, input: Parameters<typeof updateWorkspaceSource>[2]) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const draft = useSourceDraft(source);
  const { uri, label, description, contextFiles } = draft.values;
  const save = () =>
    onSave(source.id, {
      uri,
      label,
      description,
      contextFiles: source.sourceType === 'folder' ? parseContextFiles(contextFiles) : undefined,
    });
  const remove = () => {
    if (window.confirm(`Remove source “${source.label}”? Repository contents stay untouched.`))
      void onDelete(source.id);
  };
  return (
    <li
      className="space-y-2 rounded border p-3"
      style={{ borderColor: selected ? 'var(--accent)' : 'var(--border)' }}
    >
      <SourceRowHeader source={source} selected={selected} />
      <SourceRowEditor
        source={source}
        disabled={disabled}
        values={draft.values}
        onChange={draft.onChange}
        onSave={() => void save()}
        onDelete={remove}
      />
    </li>
  );
}

function SourceList({
  workspace,
  disabled,
  onSave,
  onDelete,
}: {
  workspace: ProjectWorkspaceResponse;
  disabled: boolean;
  onSave: (id: string, input: Parameters<typeof updateWorkspaceSource>[2]) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const selected = workspace.execution.sourceId;
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">Sources</h3>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Removing a source only detaches it from this project; it never deletes repository files.
        </p>
      </div>
      {workspace.sources.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No attached sources.
        </p>
      ) : (
        <ul className="space-y-2">
          {workspace.sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              disabled={disabled}
              selected={source.id === selected}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AddSourceIdentityFields({
  disabled,
  sourceType,
  uri,
  label,
  description,
  onType,
  onUri,
  onLabel,
  onDescription,
}: {
  disabled: boolean;
  sourceType: CreateWorkspaceSource['sourceType'];
  uri: string;
  label: string;
  description: string;
  onType: (value: CreateWorkspaceSource['sourceType']) => void;
  onUri: (value: string) => void;
  onLabel: (value: string) => void;
  onDescription: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input
        value={label}
        onChange={(event) => onLabel(event.target.value)}
        disabled={disabled}
        placeholder="Label"
        className="rounded border px-2 py-1.5 text-sm"
      />
      <input
        value={uri}
        onChange={(event) => onUri(event.target.value)}
        disabled={disabled}
        placeholder="Server folder path or URL"
        className="rounded border px-2 py-1.5 text-sm"
      />
      <SourceTypeField sourceType={sourceType} disabled={disabled} onChange={onType} />
      <input
        value={description}
        onChange={(event) => onDescription(event.target.value)}
        disabled={disabled}
        placeholder="Description (optional)"
        className="rounded border px-2 py-1.5 text-sm"
      />
    </div>
  );
}

function SourceTypeField({
  sourceType,
  disabled,
  onChange,
}: {
  sourceType: CreateWorkspaceSource['sourceType'];
  disabled: boolean;
  onChange: (value: CreateWorkspaceSource['sourceType']) => void;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block">Source type</span>
      <SourceTypeSelector sourceType={sourceType} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function SourceTypeSelector({
  sourceType,
  disabled,
  onChange,
}: {
  sourceType: CreateWorkspaceSource['sourceType'];
  disabled: boolean;
  onChange: (value: CreateWorkspaceSource['sourceType']) => void;
}) {
  return (
    <select
      value={sourceType}
      onChange={(event) => onChange(event.target.value as typeof sourceType)}
      disabled={disabled}
      className="rounded border px-2 py-1.5 text-sm"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
    >
      {SOURCE_TYPES.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>
  );
}

function AddSourceFields({
  disabled,
  sourceType,
  uri,
  label,
  description,
  contextFiles,
  onType,
  onUri,
  onLabel,
  onDescription,
  onContextFiles,
}: {
  disabled: boolean;
  sourceType: CreateWorkspaceSource['sourceType'];
  uri: string;
  label: string;
  description: string;
  contextFiles: string;
  onType: (value: CreateWorkspaceSource['sourceType']) => void;
  onUri: (value: string) => void;
  onLabel: (value: string) => void;
  onDescription: (value: string) => void;
  onContextFiles: (value: string) => void;
}) {
  return (
    <>
      <AddSourceIdentityFields
        disabled={disabled}
        sourceType={sourceType}
        uri={uri}
        label={label}
        description={description}
        onType={onType}
        onUri={onUri}
        onLabel={onLabel}
        onDescription={onDescription}
      />
      <AddSourceContext
        sourceType={sourceType}
        disabled={disabled}
        value={contextFiles}
        onChange={onContextFiles}
      />
    </>
  );
}

function AddSourceContext({
  sourceType,
  disabled,
  value,
  onChange,
}: {
  sourceType: CreateWorkspaceSource['sourceType'];
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  if (sourceType !== 'folder') return null;
  return (
    <>
      <FolderPathHint />
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder="Context files, one relative path per line"
        rows={2}
        className="w-full rounded border px-2 py-1.5 text-sm"
      />
    </>
  );
}

function AddSourceButton({
  disabled,
  valid,
  onClick,
}: {
  disabled: boolean;
  valid: boolean;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} loading={disabled} disabled={disabled || !valid}>
      Attach source
    </Button>
  );
}

function AddSource({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (input: CreateWorkspaceSource) => Promise<boolean>;
}) {
  const [sourceType, setSourceType] = useState<CreateWorkspaceSource['sourceType']>('folder');
  const [uri, setUri] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [contextFiles, setContextFiles] = useState('');
  const submit = async () => {
    const saved = await onCreate({
      uri,
      label,
      sourceType,
      description: description || undefined,
      contextFiles: sourceType === 'folder' ? parseContextFiles(contextFiles) : undefined,
    });
    if (!saved) return;
    setUri('');
    setLabel('');
    setDescription('');
    setContextFiles('');
  };
  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold">Attach source</h3>
      <AddSourceFields
        disabled={disabled}
        sourceType={sourceType}
        uri={uri}
        label={label}
        description={description}
        contextFiles={contextFiles}
        onType={setSourceType}
        onUri={setUri}
        onLabel={setLabel}
        onDescription={setDescription}
        onContextFiles={setContextFiles}
      />
      <AddSourceButton
        disabled={disabled}
        valid={Boolean(uri.trim() && label.trim())}
        onClick={() => void submit()}
      />
    </section>
  );
}

function useWorkspaceLoader(projectId: string, active: { current: boolean }) {
  const generation = useRef(0);
  const [workspace, setWorkspace] = useState<ProjectWorkspace>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, [active, projectId]);
  const load = useCallback(async (): Promise<boolean> => {
    if (!active.current) return false;
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await getWorkspace(projectId);
      if (!active.current || generation.current !== current) return false;
      setWorkspace(next);
      return true;
    } catch (cause) {
      if (!active.current || generation.current !== current) return false;
      setError(errorMessage(cause, 'Could not load workspace.'));
      return false;
    } finally {
      if (active.current && generation.current === current) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { workspace, loading, error, setError, load };
}

function useWorkspaceController(projectId: string) {
  const active = useRef(true);
  const { workspace, loading, error, setError, load } = useWorkspaceLoader(projectId, active);
  const [saving, setSaving] = useState(false);
  const mutate = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      if (!active.current) return false;
      setSaving(true);
      setError(undefined);
      try {
        await operation();
        if (!active.current) return false;
        return await load();
      } catch (cause) {
        if (!active.current) return false;
        setError(errorMessage(cause, 'Could not save workspace.'));
        return false;
      } finally {
        if (active.current) setSaving(false);
      }
    },
    [load, setError],
  );
  return {
    workspace,
    loading,
    error,
    saving,
    load,
    mutate,
    dismissError: () => setError(undefined),
  };
}

function WorkspacePanels({
  projectId,
  workspace,
  saving,
  mutate,
  reload,
}: {
  projectId: string;
  workspace: ProjectWorkspaceResponse;
  saving: boolean;
  mutate: (operation: () => Promise<unknown>) => Promise<boolean>;
  reload: () => Promise<boolean>;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <ExecutionSettings
          workspace={workspace}
          disabled={saving}
          onSave={(patch) => mutate(() => updateWorkspace(projectId, patch))}
        />
        <ProjectModelSettings
          workspace={workspace}
          disabled={saving}
          onSave={(patch) => mutate(() => updateWorkspace(projectId, patch))}
          onCatalogLoaded={() => void reload()}
        />
        <SourceList
          workspace={workspace}
          disabled={saving}
          onSave={(id, input) => mutate(() => updateWorkspaceSource(projectId, id, input))}
          onDelete={(id) => mutate(() => deleteWorkspaceSource(projectId, id))}
        />
        <ExecutionReminder workspace={workspace} />
        <AddSource
          disabled={saving}
          onCreate={(input) => mutate(() => createWorkspaceSource(projectId, input))}
        />
      </div>
      <ProjectFileBrowser
        projectId={projectId}
        sources={workspace.sources}
        defaultSourceId={workspace.execution.sourceId}
      />
    </div>
  );
}

function ExecutionReminder({ workspace }: { workspace: ProjectWorkspace }) {
  if (!workspace.sources.some((source) => source.sourceType === 'folder')) return null;
  if (workspace.execution.sourceId && workspace.execution.mode !== 'default') return null;
  return (
    <p
      role="status"
      className="rounded border p-3 text-sm"
      style={{ borderColor: 'var(--accent)' }}
    >
      For autonomous repository commands, choose the repository under Working folder, select Auto or
      Full mode in Execution, and click Save execution settings.
    </p>
  );
}

function WorkspaceRetry({ disabled, onRetry }: { disabled: boolean; onRetry: () => void }) {
  return (
    <Button size="sm" onClick={onRetry} disabled={disabled} loading={disabled}>
      Retry
    </Button>
  );
}

function WorkspaceErrorBanner({
  message,
  disabled,
  onRetry,
  onDismiss,
}: {
  message: string;
  disabled: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded border p-3 shadow"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--error)' }}
    >
      <p
        className="min-w-0 max-h-40 overflow-y-auto break-words text-sm"
        style={{ color: 'var(--error)' }}
      >
        {message}
      </p>
      <WorkspaceRetry disabled={disabled} onRetry={onRetry} />
      <Button size="sm" onClick={onDismiss} disabled={disabled}>
        Dismiss error
      </Button>
    </div>
  );
}

function WorkspaceContent({
  projectId,
  controller,
}: {
  projectId: string;
  controller: ReturnType<typeof useWorkspaceController>;
}) {
  const disabled = controller.loading || controller.saving;
  if (controller.loading && !controller.workspace) {
    return (
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading workspace…
      </div>
    );
  }
  if (!controller.workspace) {
    return (
      <div className="space-y-3" role="alert" style={{ color: 'var(--error)' }}>
        <p>{controller.error ?? 'Workspace unavailable.'}</p>
        <WorkspaceRetry disabled={disabled} onRetry={() => void controller.load()} />
      </div>
    );
  }
  return (
    <>
      {controller.error && (
        <WorkspaceErrorBanner
          message={controller.error}
          disabled={disabled}
          onRetry={() => void controller.load()}
          onDismiss={controller.dismissError}
        />
      )}
      <WorkspacePanels
        projectId={projectId}
        workspace={controller.workspace}
        saving={controller.saving}
        mutate={controller.mutate}
        reload={controller.load}
      />
    </>
  );
}

export function ProjectWorkspaceTab({ projectId }: ProjectTabProps) {
  const controller = useWorkspaceController(projectId);
  const readinessRefreshKey = controller.workspace
    ? JSON.stringify({
        execution: controller.workspace.execution,
        sources: controller.workspace.sources,
      })
    : undefined;
  return (
    <div role="region" aria-label="Project workspace" className="h-full overflow-y-auto p-4 sm:p-6">
      <ProjectReadiness projectId={projectId} refreshKey={readinessRefreshKey} />
      <WorkspaceContent projectId={projectId} controller={controller} />
    </div>
  );
}
