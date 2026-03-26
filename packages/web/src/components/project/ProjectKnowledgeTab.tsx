'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api-client';
import type { ProjectDataSource, LinkedBubbleSummary } from '@/lib/api-client';
import type { ProjectTabProps } from './project-tab-registry';

const SAVE_INDICATOR_MS = 2000;
const PREVIEW_MAX_CHARS = 100;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  gdrive: 'Google Drive',
  file: 'Local File',
  url: 'URL',
  other: 'Other',
};

// eslint-disable-next-line max-lines-per-function -- unified tab with three sections
export function ProjectKnowledgeTab({ projectId, project, onProjectUpdated }: ProjectTabProps) {
  const [dataSources, setDataSources] = useState<ProjectDataSource[]>([]);
  const [knowledgeLinks, setKnowledgeLinks] = useState<LinkedBubbleSummary[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt ?? '');
  const [saved, setSaved] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ bubbleId: string; title: string; score: number }>
  >([]);
  const [newSource, setNewSource] = useState({
    uri: '',
    label: '',
    description: '',
    sourceType: 'url',
  });

  const loadData = useCallback(async () => {
    const [ds, kl] = await Promise.all([
      api.getProjectDataSources(projectId),
      api.getProjectKnowledgeLinks(projectId),
    ]);
    setDataSources(ds);
    setKnowledgeLinks(kl);
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useEffect(() => {
    setSystemPrompt(project.systemPrompt ?? '');
  }, [project.systemPrompt]);

  const handleSavePrompt = useCallback(async () => {
    const updated = await api.updateProject(projectId, { systemPrompt: systemPrompt || null });
    onProjectUpdated(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), SAVE_INDICATOR_MS);
  }, [projectId, systemPrompt, onProjectUpdated]);

  const handleAddSource = useCallback(async () => {
    await api.createProjectDataSource(projectId, {
      uri: newSource.uri,
      label: newSource.label,
      description: newSource.description || undefined,
      sourceType: newSource.sourceType,
    });
    setNewSource({ uri: '', label: '', description: '', sourceType: 'url' });
    setShowAddSource(false);
    loadData();
  }, [projectId, newSource, loadData]);

  const handleDeleteSource = useCallback(
    async (dsId: string) => {
      await api.deleteProjectDataSource(projectId, dsId);
      loadData();
    },
    [projectId, loadData],
  );

  const handleUnlink = useCallback(
    async (bubbleId: string) => {
      await api.unlinkKnowledgeFromProject(projectId, bubbleId);
      loadData();
    },
    [projectId, loadData],
  );

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    const result = await api.searchKnowledge(searchQuery);
    setSearchResults(
      result.results.map((r) => ({ bubbleId: r.bubbleId, title: r.title, score: r.score })),
    );
  }, [searchQuery]);

  const handleLinkBubble = useCallback(
    async (bubbleId: string) => {
      await api.linkKnowledgeToProject(projectId, bubbleId);
      setShowLinkPicker(false);
      setSearchResults([]);
      setSearchQuery('');
      loadData();
    },
    [projectId, loadData],
  );

  return (
    <div className="space-y-6">
      {/* Linked Knowledge Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            Linked Knowledge
          </h3>
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => setShowLinkPicker(!showLinkPicker)}
          >
            Link Knowledge
          </button>
        </div>

        {showLinkPicker && (
          <div
            className="rounded p-4 border mb-4"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
          >
            <div className="flex gap-2 mb-2">
              <input
                className="flex-1 px-3 py-1.5 rounded text-sm border"
                style={{
                  background: 'var(--bg)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
                placeholder="Search knowledge bubbles..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button
                className="px-3 py-1.5 rounded text-sm"
                style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
                onClick={handleSearch}
              >
                Search
              </button>
            </div>
            {searchResults.map((r) => (
              <div
                key={r.bubbleId}
                className="flex items-center justify-between py-1.5 px-2 rounded"
                style={{ background: 'var(--bg)' }}
              >
                <span className="text-sm" style={{ color: 'var(--text)' }}>
                  {r.title}
                </span>
                <button
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                  onClick={() => handleLinkBubble(r.bubbleId)}
                >
                  Link
                </button>
              </div>
            ))}
          </div>
        )}

        {knowledgeLinks.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No linked knowledge bubbles yet.
          </p>
        ) : (
          <div className="grid gap-3">
            {knowledgeLinks.map((link) => (
              <div
                key={link.bubbleId}
                className="rounded p-4 border"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm" style={{ color: 'var(--text)' }}>
                      {link.title}
                    </h4>
                    <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
                      {link.contentPreview?.slice(0, PREVIEW_MAX_CHARS)}
                    </p>
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {(link.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-0.5 rounded-full"
                          style={{ background: 'var(--accent)', color: '#fff', opacity: 0.8 }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {link.source && `Source: ${link.source}`}
                      {link.createdAt && ` · ${new Date(link.createdAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button
                    className="text-xs px-2 py-1 rounded ml-2"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                    onClick={() => handleUnlink(link.bubbleId)}
                  >
                    Unlink
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Data Sources Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            Data Sources
          </h3>
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => setShowAddSource(!showAddSource)}
          >
            Add Data Source
          </button>
        </div>

        {showAddSource && (
          <div
            className="rounded p-4 border mb-4 space-y-2"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
          >
            <input
              className="w-full px-3 py-1.5 rounded text-sm border"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              placeholder="Label"
              value={newSource.label}
              onChange={(e) => setNewSource({ ...newSource, label: e.target.value })}
            />
            <input
              className="w-full px-3 py-1.5 rounded text-sm border"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              placeholder="URI (file path, URL, or Google Drive link)"
              value={newSource.uri}
              onChange={(e) => setNewSource({ ...newSource, uri: e.target.value })}
            />
            <input
              className="w-full px-3 py-1.5 rounded text-sm border"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              placeholder="Description (optional)"
              value={newSource.description}
              onChange={(e) => setNewSource({ ...newSource, description: e.target.value })}
            />
            <select
              className="w-full px-3 py-1.5 rounded text-sm border"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              value={newSource.sourceType}
              onChange={(e) => setNewSource({ ...newSource, sourceType: e.target.value })}
            >
              <option value="url">URL</option>
              <option value="gdrive">Google Drive</option>
              <option value="file">Local File</option>
              <option value="other">Other</option>
            </select>
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 rounded text-sm"
                style={{ background: 'var(--accent)', color: '#fff' }}
                onClick={handleAddSource}
                disabled={!newSource.uri || !newSource.label}
              >
                Add
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm"
                style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
                onClick={() => setShowAddSource(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {dataSources.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No data sources linked yet.
          </p>
        ) : (
          <div className="space-y-2">
            {dataSources.map((ds) => (
              <div
                key={ds.id}
                className="flex items-center justify-between rounded p-3 border"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm" style={{ color: 'var(--text)' }}>
                      {ds.label}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                    >
                      {SOURCE_TYPE_LABELS[ds.sourceType] ?? ds.sourceType}
                    </span>
                  </div>
                  <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {ds.sourceType === 'url' ? (
                      <a
                        href={ds.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent)' }}
                      >
                        {ds.uri}
                      </a>
                    ) : (
                      ds.uri
                    )}
                  </p>
                  {ds.description && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {ds.description}
                    </p>
                  )}
                </div>
                <button
                  className="text-xs px-2 py-1 rounded ml-2"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                  onClick={() => handleDeleteSource(ds.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Project Instructions Section */}
      <section>
        <h3 className="text-lg font-semibold mb-3" style={{ color: 'var(--text)' }}>
          Project Instructions
          {saved && (
            <span className="text-xs ml-2 font-normal" style={{ color: 'var(--success)' }}>
              Saved
            </span>
          )}
        </h3>
        <textarea
          className="w-full rounded border p-3 text-sm font-mono"
          style={{
            background: 'var(--bg)',
            borderColor: 'var(--border)',
            color: 'var(--text)',
            minHeight: 120,
          }}
          placeholder="Custom instructions for agents working in this project..."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          onBlur={handleSavePrompt}
        />
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Auto-saves when you click away.
        </p>
      </section>
    </div>
  );
}
