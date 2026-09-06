import type { ProjectReadinessReport } from '@raven/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectReadinessReportView,
  readinessStatePresentation,
} from '@/components/project/ProjectReadiness';
import { getProjectReadiness } from '@/lib/workspace-api';

const report: ProjectReadinessReport = {
  projectId: 'parent/child',
  checkedAt: '2026-09-06T12:00:00.000Z',
  status: 'degraded',
  workspace: {
    state: 'unavailable',
    mode: 'default',
    settingSources: ['project'],
    blockedOperations: ['native write'],
    sources: [
      {
        id: 'repository',
        label: 'Repository',
        sourceType: 'folder',
        selected: true,
        state: 'unavailable',
        contextIndexes: [{ path: 'AGENTS.md', state: 'unavailable' }],
      },
    ],
  },
  agent: { state: 'verified', id: 'default', name: 'Raven', skills: ['gmail', 'calendar'] },
  capabilities: [
    {
      name: 'gmail',
      displayName: 'Gmail',
      state: 'unverified',
      requirements: [
        { kind: 'executable', name: 'node', state: 'verified' },
        {
          kind: 'authentication',
          name: 'Google account',
          state: 'unverified',
          correction: 'Connect the owner account, then run its provider check.',
        },
      ],
      findings: [],
    },
    {
      name: 'calendar',
      displayName: 'Calendar',
      state: 'verified',
      requirements: [],
      findings: [],
    },
  ],
  definitionDiagnostics: [],
  recentFailures: [],
  findings: [
    {
      code: 'workspace.cwd_missing',
      severity: 'blocking',
      scope: 'workspace',
      message: 'The selected repository is not mounted.',
      correction: 'Mount its parent folder and select the repository again.',
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('project readiness presentation', () => {
  it('distinguishes local verification from unverified authentication', () => {
    expect(readinessStatePresentation('verified', 'executable').label).toBe('Verified locally');
    expect(readinessStatePresentation('unverified', 'authentication').label).toBe(
      'Authentication unverified',
    );
  });

  it('keeps an optional failure alongside usable capabilities and actionable corrections', () => {
    const html = renderToStaticMarkup(createElement(ProjectReadinessReportView, { report }));

    expect(html).toContain('Gmail');
    expect(html).toContain('Authentication unverified');
    expect(html).toContain('Calendar');
    expect(html).toContain('Verified locally');
    expect(html).toContain('Mount its parent folder and select the repository again.');
    expect(html).toContain('Blocked operations: native write');
  });

  it('requests readiness through the encoded project route', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(report));
    vi.stubGlobal('fetch', fetcher);

    await expect(getProjectReadiness('parent/child')).resolves.toEqual(report);

    expect(fetcher.mock.calls[0][0]).toBe('/api/projects/parent%2Fchild/readiness');
  });
});
