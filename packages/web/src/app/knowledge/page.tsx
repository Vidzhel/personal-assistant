'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { KnowledgeView } from '@/components/knowledge/KnowledgeView';
import { api } from '@/lib/api-client';

function useProjects(): ProjectSelection {
  const [projects, setProjects] = useState<ProjectSelection['projects']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  useEffect(() => {
    api
      .getProjects()
      .then((nextProjects) => {
        setProjects(nextProjects);
        setError(null);
      })
      .catch((cause) => {
        setProjects([]);
        setError(cause instanceof Error ? cause.message : 'Could not load projects.');
      })
      .finally(() => setLoading(false));
  }, []);
  return { projects, projectId, loading, error };
}

interface ProjectSelection {
  projects: Awaited<ReturnType<typeof api.getProjects>>;
  projectId: string | null;
  loading: boolean;
  error: string | null;
}

function useProjectHighlight(searchParams: ReturnType<typeof useSearchParams>): void {
  const { nodes, setHighlightedNodeIds } = useKnowledgeStore();
  useEffect(() => {
    const highlight = searchParams.get('highlight');
    const visible = new Set(nodes.map((node) => node.id));
    setHighlightedNodeIds(highlight ? highlight.split(',').filter((id) => visible.has(id)) : []);
  }, [nodes, searchParams, setHighlightedNodeIds]);
}

function projectDestination(input: {
  pathname: string;
  searchParams: { toString: () => string };
  currentProjectId: string | null;
  nextProjectId: string;
}): string {
  const { pathname, searchParams, currentProjectId, nextProjectId } = input;
  const next = new URLSearchParams(searchParams.toString());
  if (nextProjectId) next.set('projectId', nextProjectId);
  else next.delete('projectId');
  if (currentProjectId && nextProjectId !== currentProjectId) next.delete('highlight');
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function ProjectOptions({ projects }: { projects: ProjectSelection['projects'] }): ReactNode {
  return (
    <>
      <option value="">Select a project</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </>
  );
}

function ProjectSelectionError({ selection }: { selection: ProjectSelection }): ReactNode {
  const { projects, projectId, loading, error } = selection;
  const selected = projects.some((project) => project.id === projectId);
  if (error)
    return (
      <p role="alert" className="px-3 py-2 text-sm">
        {error}
      </p>
    );
  if (!loading && projectId && !selected) {
    return (
      <p role="alert" className="px-3 py-2 text-sm">
        Selected project is unavailable.
      </p>
    );
  }
  return null;
}

function ProjectPicker({ selection }: { selection: ProjectSelection }): ReactNode {
  const { projects, projectId, loading, error: projectsError } = selection;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedProject = projects.find((project) => project.id === projectId);

  return (
    <>
      <label className="flex min-w-0 items-center gap-2 p-3 border-b text-sm">
        <span>Project</span>
        <select
          aria-label="Knowledge project"
          className="min-w-0 max-w-full flex-1"
          value={selectedProject?.id ?? ''}
          disabled={loading || Boolean(projectsError)}
          onChange={(event) =>
            router.replace(
              projectDestination({
                pathname,
                searchParams,
                currentProjectId: projectId,
                nextProjectId: event.target.value,
              }),
              {
                scroll: false,
              },
            )
          }
        >
          <ProjectOptions projects={projects} />
        </select>
      </label>
      <ProjectSelectionError selection={selection} />
    </>
  );
}

function KnowledgePageInner() {
  const selection = useProjects();
  const searchParams = useSearchParams();
  useProjectHighlight(searchParams);
  const selectedProject = selection.projects.find((project) => project.id === selection.projectId);

  return (
    <div className="flex flex-col h-full">
      <ProjectPicker selection={selection} />
      <KnowledgeView projectId={selectedProject?.id} />
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={null}>
      <KnowledgePageInner />
    </Suspense>
  );
}
