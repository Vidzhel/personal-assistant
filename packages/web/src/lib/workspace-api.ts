import type {
  ModelConfig,
  ProjectReadinessReport,
  ProjectWorkspace,
  ProjectWorkspaceSource,
  WorkspaceUpdate,
} from '@raven/shared';
import { CORE_API_URL } from '@/lib/core-endpoints';
import { apiRequest } from '@/lib/api-request';
import { projectPath } from '@/lib/url-paths';

export type WorkspaceSource = ProjectWorkspaceSource & { projectId?: string };
export type ProjectWorkspaceResponse = ProjectWorkspace & {
  effectiveModelConfig?: ModelConfig;
  modelConfigError?: string;
};

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  preview: 'text' | 'image' | 'pdf' | 'html' | 'none';
}

export interface ProjectFileListing {
  projectId: string;
  sourceId: string;
  path: string;
  revision: string;
  entries: ProjectFileEntry[];
  truncated: boolean;
}

export interface ProjectFileInfo {
  projectId: string;
  sourceId: string;
  path: string;
  revision: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  preview: 'text' | 'image' | 'pdf' | 'html' | 'none';
  mimeType?: string;
}

export interface CreateWorkspaceSource {
  uri: string;
  label: string;
  description?: string;
  sourceType: ProjectWorkspaceSource['sourceType'];
  contextFiles?: string[];
}

export interface UpdateWorkspaceSource {
  uri?: string;
  label?: string;
  description?: string;
  sourceType?: ProjectWorkspaceSource['sourceType'];
  contextFiles?: string[];
}

function fileQuery(projectId: string, sourceId: string, path = ''): string {
  const query = new URLSearchParams({ sourceId });
  if (path) query.set('path', path);
  return `${projectPath(projectId)}/files?${query.toString()}`;
}

function fileEndpoint(
  projectId: string,
  endpoint: string,
  options: { sourceId: string; path: string },
): string {
  const query = new URLSearchParams(options);
  return `${projectPath(projectId)}/files/${endpoint}?${query.toString()}`;
}

export function getWorkspace(projectId: string): Promise<ProjectWorkspaceResponse> {
  return apiRequest<ProjectWorkspaceResponse>(`${projectPath(projectId)}/workspace`);
}

export function getProjectReadiness(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectReadinessReport> {
  return apiRequest<ProjectReadinessReport>(`${projectPath(projectId)}/readiness`, { signal });
}

export function updateWorkspace(
  projectId: string,
  patch: WorkspaceUpdate,
): Promise<ProjectWorkspaceResponse> {
  return apiRequest<ProjectWorkspaceResponse>(`${projectPath(projectId)}/workspace`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function createWorkspaceSource(
  projectId: string,
  input: CreateWorkspaceSource,
): Promise<WorkspaceSource> {
  return apiRequest<WorkspaceSource>(`${projectPath(projectId)}/data-sources`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateWorkspaceSource(
  projectId: string,
  sourceId: string,
  input: UpdateWorkspaceSource,
): Promise<WorkspaceSource> {
  return apiRequest<WorkspaceSource>(
    `${projectPath(projectId)}/data-sources/${encodeURIComponent(sourceId)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deleteWorkspaceSource(projectId: string, sourceId: string): Promise<unknown> {
  return apiRequest<unknown>(
    `${projectPath(projectId)}/data-sources/${encodeURIComponent(sourceId)}`,
    { method: 'DELETE' },
  );
}

export function listProjectFiles(
  projectId: string,
  sourceId = 'home',
  path = '',
): Promise<ProjectFileListing> {
  return apiRequest<ProjectFileListing>(fileQuery(projectId, sourceId, path));
}

export function getProjectFileInfo(
  projectId: string,
  sourceId: string,
  path: string,
): Promise<ProjectFileInfo> {
  return apiRequest<ProjectFileInfo>(fileEndpoint(projectId, 'info', { sourceId, path }));
}

export interface ProjectFileContentOptions {
  sourceId: string;
  path: string;
  revision: string;
  download?: boolean;
  signal?: AbortSignal;
}

export function projectFileContentUrl(
  projectId: string,
  options: ProjectFileContentOptions,
): string {
  const query = new URLSearchParams({
    sourceId: options.sourceId,
    path: options.path,
    revision: options.revision,
  });
  if (options.download) query.set('download', '1');
  return `${CORE_API_URL}${projectPath(projectId)}/files/content?${query.toString()}`;
}

export async function fetchProjectFileContent(
  projectId: string,
  options: ProjectFileContentOptions,
): Promise<Response> {
  const response = await fetch(projectFileContentUrl(projectId, options), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Could not load file (${response.status}).`);
  return response;
}

export async function headProjectFileContent(
  projectId: string,
  options: ProjectFileContentOptions,
): Promise<void> {
  const response = await fetch(projectFileContentUrl(projectId, options), {
    method: 'HEAD',
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Could not load file (${response.status}).`);
}
