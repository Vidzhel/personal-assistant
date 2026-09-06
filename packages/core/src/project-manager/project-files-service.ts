import { createHash } from 'node:crypto';
import { opendirSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { HTTP_STATUS, type ProjectWorkspace } from '@raven/shared';
import { ProjectMutationError } from './project-mutation.ts';
import type { ProjectWorkspaceStore } from './project-workspace.ts';
import {
  assertDirectory,
  closeOpenedFile,
  createReadStreamFromFd,
  fileLimits,
  mimeForPath,
  openRelativeFile,
  openRelativeFileFromDirectory,
  PAYLOAD_TOO_LARGE,
  previewForPath,
  readOpenedText,
  type ContentRequest,
  type FileRequest,
  type OpenedPath,
  type ProjectFileInfo,
  type ProjectFileListing,
} from './project-files-access.ts';

export type {
  ContentRequest,
  FileRequest,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileListing,
  ProjectFilePreview,
} from './project-files-access.ts';

export interface OpenProjectContent {
  info: ProjectFileInfo;
  text?: string;
  stream?: ReturnType<typeof createReadStreamFromFd>;
}

interface ResolvedRoot {
  projectId: string;
  sourceId: string;
  root: string;
  workspace: unknown;
}

function rootFor(store: ProjectWorkspaceStore, input: FileRequest): ResolvedRoot {
  const sourceId = input.sourceId ?? 'home';
  const workspace = store.getWorkspace(input.projectId);
  const root =
    sourceId === 'home' ? store.getProjectHome(input.projectId) : sourceUri(input, workspace);
  const absolute = resolve(root);
  assertDirectory(absolute);
  return { projectId: input.projectId, sourceId, root: absolute, workspace };
}

function sourceUri(input: FileRequest, workspace: ProjectWorkspace): string {
  const sources = workspace.sources;
  const source = sources.find((candidate) => candidate.id === input.sourceId);
  if (!source)
    throw new ProjectMutationError(`Source not found: ${input.sourceId}`, HTTP_STATUS.NOT_FOUND);
  if (source.sourceType !== 'folder')
    throw new ProjectMutationError('Only folder sources can be browsed', HTTP_STATUS.BAD_REQUEST);
  return source.uri;
}

function revision(root: ResolvedRoot, stats: { dev: number; ino: number }): string {
  return createRevision({
    workspace: root.workspace,
    root: root.root,
    dev: stats.dev,
    ino: stats.ino,
  });
}

function createRevision(options: {
  workspace: unknown;
  root: string;
  dev: number;
  ino: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(options.workspace))
    .update('\0')
    .update(options.root)
    .update('\0')
    .update(String(options.dev))
    .update('\0')
    .update(String(options.ino))
    .digest('hex');
}

function checkRevision(
  root: ResolvedRoot,
  stats: { dev: number; ino: number },
  expected: string | undefined,
): string {
  const actual = revision(root, stats);
  if (expected !== undefined && expected !== actual) {
    throw new ProjectMutationError('Workspace grant changed; refresh and retry');
  }
  return actual;
}

function infoFromOpened(options: {
  root: ResolvedRoot;
  path: string;
  opened: OpenedPath;
  grantRevision: string;
}): ProjectFileInfo {
  const { root, path, opened, grantRevision } = options;
  const type = opened.stats.isDirectory() ? 'directory' : 'file';
  return {
    projectId: root.projectId,
    sourceId: root.sourceId,
    path,
    revision: grantRevision,
    name: path ? (path.split('/').at(-1) ?? '') : (root.root.split('/').at(-1) ?? ''),
    type,
    size: opened.stats.size,
    modifiedAt: opened.stats.mtime.toISOString(),
    preview: previewForPath(path, type),
    mimeType: type === 'directory' ? 'application/json' : mimeForPath(path),
  };
}

function openProjectPath(
  store: ProjectWorkspaceStore,
  input: FileRequest,
): { root: ResolvedRoot; opened: OpenedPath; revision: string } {
  const root = rootFor(store, input);
  const opened = openRelativeFile(root.root, input.path);
  try {
    const grantRevision = checkRevision(root, opened.rootStats, input.revision);
    return { root, opened, revision: grantRevision };
  } catch (cause) {
    closeOpenedFile(opened);
    throw cause;
  }
}

export interface ProjectFileService {
  list(input: FileRequest): ProjectFileListing;
  getInfo(input: FileRequest): ProjectFileInfo;
  openContent(input: ContentRequest): OpenProjectContent;
}

function listFiles(store: ProjectWorkspaceStore, input: FileRequest): ProjectFileListing {
  const opened = openProjectPath(store, input);
  try {
    if (!opened.opened.stats.isDirectory()) {
      throw new ProjectMutationError('File path is not a directory', HTTP_STATUS.BAD_REQUEST);
    }
    const listing = listOpenedDirectory(opened.root.root, input.path, opened.opened.fd);
    return {
      projectId: opened.root.projectId,
      sourceId: opened.root.sourceId,
      path: input.path,
      revision: opened.revision,
      ...listing,
    };
  } finally {
    closeOpenedFile(opened.opened);
  }
}

function getFileInfo(store: ProjectWorkspaceStore, input: FileRequest): ProjectFileInfo {
  const opened = openProjectPath(store, input);
  try {
    return infoFromOpened({
      root: opened.root,
      path: input.path,
      opened: opened.opened,
      grantRevision: opened.revision,
    });
  } finally {
    closeOpenedFile(opened.opened);
  }
}

function textContent(opened: OpenedPath, info: ProjectFileInfo): OpenProjectContent {
  try {
    return { info, text: readOpenedText(opened) };
  } finally {
    closeOpenedFile(opened);
  }
}

function pdfPreviewTooLarge(input: ContentRequest, info: ProjectFileInfo): boolean {
  return input.download !== true && info.preview === 'pdf' && info.size > fileLimits().maxPdfBytes;
}

function openFileContent(store: ProjectWorkspaceStore, input: ContentRequest): OpenProjectContent {
  const opened = openProjectPath(store, input);
  const info = infoFromOpened({
    root: opened.root,
    path: input.path,
    opened: opened.opened,
    grantRevision: opened.revision,
  });
  if (info.type !== 'file') {
    closeOpenedFile(opened.opened);
    throw new ProjectMutationError(
      'Directories cannot be served as content',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  if (input.download !== true && info.preview === 'none') {
    closeOpenedFile(opened.opened);
    throw new ProjectMutationError(
      'This file type is available as a download only',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  const limits = fileLimits();
  if (pdfPreviewTooLarge(input, info)) {
    closeOpenedFile(opened.opened);
    throw new ProjectMutationError(
      'PDF preview exceeds 32 MiB; download the file',
      PAYLOAD_TOO_LARGE,
    );
  }
  if (input.download !== true && (info.preview === 'text' || info.preview === 'html')) {
    return textContent(opened.opened, info);
  }
  if (info.size > limits.maxDownloadBytes) {
    closeOpenedFile(opened.opened);
    throw new ProjectMutationError(
      `File exceeds the ${limits.maxDownloadBytes}-byte download limit`,
      PAYLOAD_TOO_LARGE,
    );
  }
  return { info, stream: createReadStreamFromFd(opened.opened.fd, info.size) };
}

export function createProjectFileService(store: ProjectWorkspaceStore): ProjectFileService {
  return {
    list: (input) => listFiles(store, input),
    getInfo: (input) => getFileInfo(store, input),
    openContent: (input) => openFileContent(store, input),
  };
}

function listOpenedDirectory(
  root: string,
  path: string,
  fd: number,
): Pick<ProjectFileListing, 'entries' | 'truncated'> {
  const entries: ProjectFileListing['entries'] = [];
  const maximum = fileLimits().maxListingEntries;
  let visited = 0;
  let truncated = false;
  const directory = opendirSync(`/proc/self/fd/${String(fd)}`);
  try {
    let item: Dirent | null;
    while (true) {
      item = directory.readSync();
      if (item === null) break;
      visited += 1;
      if (visited > maximum) {
        truncated = true;
        break;
      }
      const childPath = path ? `${path}/${item.name}` : item.name;
      const entry = readListingEntry({
        root,
        directoryFd: fd,
        name: item.name,
        path: childPath,
        relativePath: childPath.slice(path ? path.length + 1 : 0),
      });
      if (entry) entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries, truncated };
}

function readListingEntry(options: {
  root: string;
  directoryFd: number;
  name: string;
  path: string;
  relativePath: string;
}): ProjectFileListing['entries'][number] | undefined {
  try {
    const child = openRelativeFileFromDirectory(
      options.directoryFd,
      options.root,
      options.relativePath,
    );
    try {
      const type = child.stats.isDirectory() ? 'directory' : 'file';
      if (!child.stats.isDirectory() && !child.stats.isFile()) return undefined;
      return {
        name: options.name,
        path: options.path,
        type,
        size: child.stats.size,
        modifiedAt: child.stats.mtime.toISOString(),
        preview: previewForPath(options.path, type),
      };
    } finally {
      closeOpenedFile(child);
    }
  } catch {
    // A file may disappear during listing; do not expose an unsafe entry.
    return undefined;
  }
}
