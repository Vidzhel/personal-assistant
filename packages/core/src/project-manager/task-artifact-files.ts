import { isAbsolute, relative, resolve, sep } from 'node:path';
import { META_PROJECT_ID, type TaskArtifact } from '@raven/shared';
import type { ProjectWorkspaceStore } from './project-workspace.ts';
import { createProjectFileService } from './project-files-service.ts';

interface ArtifactSource {
  id: string;
  root: string;
}

export interface ArtifactLocation {
  projectId: string;
  sourceId: string;
  path: string;
}

interface ArtifactRequest {
  projectId?: string;
  artifact: TaskArtifact;
  workspaceStore: ProjectWorkspaceStore;
}

function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function sourceRelative(source: ArtifactSource, absolute: string): string | undefined {
  const path = relative(source.root, absolute);
  return safeRelative(path) ? path.split(sep).join('/') : undefined;
}

function artifactPath(artifact: TaskArtifact): string {
  if (artifact.type !== 'file' || !artifact.filePath) throw new Error('Not a file artifact');
  if (artifact.filePath.includes('\\') || artifact.filePath.includes('\0')) {
    throw new Error('Unsafe artifact path');
  }
  return artifact.filePath;
}

/** Resolve at registration so changing cwd never reinterprets a saved relative artifact. */
export function locateTaskArtifact(request: ArtifactRequest): ArtifactLocation {
  const { artifact, workspaceStore } = request;
  const projectId = request.projectId ?? META_PROJECT_ID;
  const path = artifactPath(artifact);
  const workspace = workspaceStore.getWorkspace(projectId);
  const sources: ArtifactSource[] = [
    { id: 'home', root: workspaceStore.getProjectHome(projectId) },
    ...workspace.sources
      .filter((source) => source.sourceType === 'folder')
      .map((source) => ({ id: source.id, root: source.uri })),
  ];
  if (isAbsolute(path)) {
    return locateAbsolute({ projectId, sources, absolute: path, sourceId: artifact.sourceId });
  }
  if (!safeRelative(path)) throw new Error('Artifact path must be a safe source-relative path');
  const sourceId = artifact.sourceId ?? workspace.execution.sourceId ?? 'home';
  if (!sources.some((source) => source.id === sourceId))
    throw new Error('Artifact source not found');
  return { projectId, sourceId, path };
}

function locateAbsolute({
  projectId,
  sources,
  absolute,
  sourceId,
}: {
  projectId: string;
  sources: ArtifactSource[];
  absolute: string;
  sourceId?: string;
}): ArtifactLocation {
  if (resolve(absolute) !== absolute) throw new Error('Artifact path must be canonical');
  const ordered = [...sources].sort((a, b) => b.root.length - a.root.length);
  for (const source of ordered) {
    if (sourceId && sourceId !== source.id) continue;
    const path = sourceRelative(source, absolute);
    if (path) return { projectId, sourceId: source.id, path };
  }
  throw new Error('Artifact file is outside the current project sources');
}

export function registerTaskArtifacts(request: {
  projectId?: string;
  artifacts: TaskArtifact[];
  workspaceStore?: ProjectWorkspaceStore;
}): TaskArtifact[] {
  return request.artifacts.map((artifact) => {
    if (artifact.type !== 'file') return artifact;
    if (!request.workspaceStore) throw new Error('Project file access is unavailable');
    const location = locateTaskArtifact({
      projectId: request.projectId,
      artifact,
      workspaceStore: request.workspaceStore,
    });
    const info = createProjectFileService(request.workspaceStore).getInfo(location);
    if (info.type !== 'file') throw new Error('A file artifact must be a regular file');
    return { ...artifact, sourceId: location.sourceId, filePath: location.path };
  });
}
