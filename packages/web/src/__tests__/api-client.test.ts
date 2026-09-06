import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { apiRequest } from '@/lib/api-request';
import { projectPath, projectIdFromRoute } from '@/lib/url-paths';

afterEach(() => vi.unstubAllGlobals());

describe('API success/error and project identity contracts', () => {
  it('accepts empty DELETE and 204 responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.deleteProjectDataSource('parent/child', 'source')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toContain('/projects/parent%2Fchild/data-sources/source');
  });

  it('shows refused mutation details from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Project still has sessions' }), { status: 409 }),
        ),
    );
    await expect(api.deleteProject('parent/child')).rejects.toThrow('Project still has sessions');
  });

  it('prefers Fastify refusal details over a generic HTTP status label', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: 'Conflict', message: 'Project still has sessions' },
            { status: 409 },
          ),
        ),
    );
    await expect(api.deleteProject('parent/child')).rejects.toThrow('Project still has sessions');
  });

  it('decodes a Next route segment once before encoding the canonical ID for API calls', () => {
    expect(projectPath(projectIdFromRoute('course%2Fone'))).toBe('/projects/course%2Fone');
    expect(projectIdFromRoute('literal%252Fname')).toBe('literal%2Fname');
    expect(projectIdFromRoute('legacy%name')).toBe('legacy%name');
  });

  it('fetches the persisted project after a successful update acknowledgement', async () => {
    const project = { id: 'parent/child', name: 'New name', skills: [] };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json(project));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.updateProject(project.id, { name: project.name })).resolves.toEqual(project);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([expect.stringContaining('/projects/parent%2Fchild')]),
    );
    expect(fetcher.mock.calls[0][1].method).toBe('PUT');
    expect(fetcher.mock.calls[1][1].method).toBeUndefined();
  });

  it('encodes nested project IDs in ordinary links, API paths and queries', async () => {
    expect(projectPath('research/teaching & notes')).toBe(
      '/projects/research%2Fteaching%20%26%20notes',
    );
    const fetcher = vi.fn().mockImplementation(async () => Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    await api.getProject('parent/child');
    await api.getProjectSessions('parent/child');
    await api.createSession('parent/child');
    await api.getProjectKnowledgeLinks('parent/child');
    await api.getProjectChildren('parent/child');
    await api.getTaskCounts('parent/child&other');
    expect(
      fetcher.mock.calls.slice(0, 5).every((call) => call[0].includes('/projects/parent%2Fchild')),
    ).toBe(true);
    expect(fetcher.mock.calls[5][0]).toContain('projectId=parent%2Fchild%26other');
  });

  it('preserves request headers and reports malformed successful JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not-json'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      apiRequest('/fixture', { headers: new Headers({ 'X-Fixture': 'value' }) }),
    ).rejects.toThrow('invalid JSON');
    expect(fetcher.mock.calls[0][1].headers.get('X-Fixture')).toBe('value');
  });

  it('requires and encodes the selected project for graph requests', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ nodes: [], edges: [], view: 'links' }));
    vi.stubGlobal('fetch', fetcher);
    await api.getKnowledgeGraph({ projectId: 'parent/child', view: 'tags' });
    expect(fetcher.mock.calls[0][0]).toContain(
      '/knowledge/graph?projectId=parent%2Fchild&view=tags',
    );
  });
});
