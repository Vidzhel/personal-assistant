'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api-client';
import type { LinkedBubbleSummary } from '@/lib/api-client';
import type { ProjectTabProps } from '@/components/project/project-tab-registry';
import { usePolling } from '@/hooks/usePolling';
import { projectPath } from '@/lib/url-paths';
const REFERENCE_POLL_MS = 15000;

const SAVE_INDICATOR_MS = 2000;
const PREVIEW_MAX_CHARS = 100;

// eslint-disable-next-line max-lines-per-function -- unified linked knowledge and instructions tab
export function ProjectKnowledgeTab({ projectId, project, onProjectUpdated }: ProjectTabProps) {
  const links = usePolling<LinkedBubbleSummary[]>(
    `${projectPath(projectId)}/knowledge-links`,
    REFERENCE_POLL_MS,
  );
  const knowledgeLinks = links.data ?? [];
  const [error, setError] = useState<string | null>(null);
  const reportError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : 'The change could not be saved.');
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt ?? '');
  const [saved, setSaved] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ bubbleId: string; title: string; score: number }>
  >([]);
  const loadData = useCallback(() => {
    links.refresh();
  }, [links.refresh]);

  useEffect(() => {
    setSystemPrompt(project.systemPrompt ?? '');
  }, [project.systemPrompt]);

  const handleSavePrompt = useCallback(async () => {
    const updated = await api.updateProject(projectId, { systemPrompt: systemPrompt || null });
    onProjectUpdated(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), SAVE_INDICATOR_MS);
  }, [projectId, systemPrompt, onProjectUpdated]);

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
      <KnowledgeErrors error={error} links={links.error} />
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Manage repository attachments and context-file links in the Workspace tab.
      </p>
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
            disabled={Boolean(links.error)}
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
                onKeyDown={(e) => e.key === 'Enter' && void handleSearch().catch(reportError)}
              />
              <button
                className="px-3 py-1.5 rounded text-sm"
                style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
                onClick={() => {
                  setError(null);
                  void handleSearch().catch(reportError);
                }}
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
                  onClick={() => {
                    setError(null);
                    void handleLinkBubble(r.bubbleId).catch(reportError);
                  }}
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
                    onClick={() => {
                      setError(null);
                      void handleUnlink(link.bubbleId).catch(reportError);
                    }}
                  >
                    Unlink
                  </button>
                </div>
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
          onBlur={() => {
            setError(null);
            void handleSavePrompt().catch(reportError);
          }}
        />
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Auto-saves when you click away.
        </p>
      </section>
    </div>
  );
}

function KnowledgeErrors({ error, links }: { error: string | null; links: Error | null }) {
  return (
    <>
      {error && (
        <p role="alert" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
      {links && <p role="status">{links.message}</p>}
    </>
  );
}
