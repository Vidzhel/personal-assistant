import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { Readable } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { HTTP_STATUS } from '@raven/shared';
import { ProjectMutationError } from './project-mutation.ts';

const PROC_FD = '/proc/self/fd';
const MAX_LISTING_ENTRIES = 500;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_DOWNLOAD_BYTES = 536_870_912;
const MAX_PDF_BYTES = 33_554_432;
const MAX_FILENAME_BYTES = 255;
const HEX_RADIX = 16;
export const PAYLOAD_TOO_LARGE = 413;
const ROOT_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.sql',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.cs',
  '.css',
  '.sh',
  '.log',
  '.qmd',
  '.ipynb',
  '.bib',
  '.tex',
  '.rmd',
  '.r',
]);
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MIME_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

export type ProjectFilePreview = 'text' | 'image' | 'pdf' | 'html' | 'none';

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  preview: ProjectFilePreview;
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
  preview: ProjectFilePreview;
  mimeType: string;
}

export interface FileRequest {
  projectId: string;
  sourceId?: string;
  path: string;
  revision?: string;
}

export interface ContentRequest extends FileRequest {
  revision: string;
  download?: boolean;
}

export interface OpenedPath {
  fd: number;
  stats: Stats;
  rootStats: Stats;
  path: string;
}

function error(message: string, statusCode: number = HTTP_STATUS.CONFLICT): ProjectMutationError {
  return new ProjectMutationError(message, statusCode);
}

function isMissing(errorValue: unknown): boolean {
  return (errorValue as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateRelativePath(path: string, allowEmpty = true): string[] {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\')) {
    throw error('File path is invalid', HTTP_STATUS.BAD_REQUEST);
  }
  if (path === '' && allowEmpty) return [];
  if (
    path.startsWith('/') ||
    path === '' ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw error(
      'File path must be relative and contain no traversal segments',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  return path.split('/');
}

export function assertDirectory(path: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    if (isMissing(cause)) throw error(`File root is unavailable: ${path}`);
    throw error(`Cannot inspect file root: ${path}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw error(`File root is unsafe: ${path}`);
  if (resolve(path) !== path || realpathSync(path) !== path) {
    throw error(`File root is not canonical: ${path}`);
  }
  return stats;
}

function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor is already unusable; preserve the original operation result.
  }
}

function openRoot(root: string): number {
  assertDirectory(root);
  const parts = root.split('/').filter(Boolean);
  let fd = openSync('/', ROOT_FLAGS);
  try {
    for (const part of parts) {
      const child = openChild(fd, part, true);
      closeFd(fd);
      fd = child;
    }
    return fd;
  } catch (cause) {
    closeFd(fd);
    throw error(`File root cannot be opened: ${root}: ${String(cause)}`);
  }
}

function openChild(parentFd: number, name: string, directory: boolean): number {
  const flags = directory ? ROOT_FLAGS : FILE_FLAGS;
  try {
    return openSync(join(PROC_FD, String(parentFd), name), flags);
  } catch (cause) {
    if (isMissing(cause)) throw error(`File is unavailable: ${name}`, HTTP_STATUS.NOT_FOUND);
    throw error(`File path is unsafe or unavailable: ${name}`);
  }
}

function duplicateDirectory(fd: number): number {
  try {
    return openSync(join(PROC_FD, String(fd)), constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (cause) {
    throw error(`Directory cannot be opened: ${String(cause)}`);
  }
}

export function openRelativeFile(root: string, path: string): OpenedPath {
  const parts = validateRelativePath(path);
  return openRelativeParts(root, parts, false);
}

export function openRelativeFileFromDirectory(
  rootFd: number,
  root: string,
  path: string,
): OpenedPath {
  const parts = validateRelativePath(path);
  return openRelativePartsFromDirectory({ rootFd, root, parts, finalDirectory: false });
}

function openRelativeParts(root: string, parts: string[], finalDirectory: boolean): OpenedPath {
  let fd = openRoot(root);
  const rootStats = fstatSync(fd);
  let current = root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const child = openChild(fd, parts[index], last ? finalDirectory : true);
      closeFd(fd);
      fd = child;
      current = join(current, parts[index]);
    }
    const stats = fstatSync(fd);
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw error('Special files and symlinks cannot be served', HTTP_STATUS.BAD_REQUEST);
    }
    return { fd, stats, rootStats, path: current };
  } catch (cause) {
    closeFd(fd);
    throw cause;
  }
}

function openRelativePartsFromDirectory(options: {
  rootFd: number;
  root: string;
  parts: string[];
  finalDirectory: boolean;
}): OpenedPath {
  const { rootFd, root, parts, finalDirectory } = options;
  const rootStats = fstatSync(rootFd);
  let fd = duplicateDirectory(rootFd);
  let current = root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const child = openChild(fd, parts[index], last ? finalDirectory : true);
      closeFd(fd);
      fd = child;
      current = join(current, parts[index]);
    }
    const stats = fstatSync(fd);
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw error('Special files and symlinks cannot be served', HTTP_STATUS.BAD_REQUEST);
    }
    return { fd, stats, rootStats, path: current };
  } catch (cause) {
    closeFd(fd);
    throw cause;
  }
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

export function mimeForPath(path: string): string {
  const extension = fileExtension(path);
  if (extension === '.html' || extension === '.htm') return 'text/html; charset=utf-8';
  if (MIME_TYPES[extension]) return MIME_TYPES[extension];
  if (TEXT_EXTENSIONS.has(extension)) return `text/plain; charset=utf-8`;
  return 'application/octet-stream';
}

export function previewForPath(path: string, type: 'file' | 'directory'): ProjectFilePreview {
  if (type === 'directory') return 'none';
  const extension = fileExtension(path);
  if (extension === '.html' || extension === '.htm') return 'html';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (Object.hasOwn(IMAGE_TYPES, extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  return 'none';
}

function assertSize(stats: Stats, maximum: number): void {
  if (stats.size > maximum)
    throw error(`File exceeds the ${maximum}-byte limit`, PAYLOAD_TOO_LARGE);
}

function sameFileState(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readText(fd: number, path: string, expected: Stats): string {
  assertSize(expected, MAX_TEXT_BYTES);
  const buffer = Buffer.allocUnsafe(expected.size + 1);
  let total = 0;
  while (total < expected.size) {
    const count = readSync(fd, buffer, total, expected.size - total, total);
    if (count === 0) throw error(`File changed while reading: ${path}`);
    total += count;
  }
  const extra = readSync(fd, buffer, expected.size, 1, expected.size);
  if (extra !== 0) throw error(`File changed while reading: ${path}`);
  const after = fstatSync(fd);
  if (!sameFileState(expected, after)) {
    throw error(`File changed while reading: ${path}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, total),
    );
  } catch (cause) {
    throw error(`File is not valid UTF-8: ${path}: ${String(cause)}`);
  }
}

function cleanFileName(name: string): string {
  return (
    name
      .replaceAll(/[\r\n]/g, '_')
      .replaceAll('"', '_')
      .replaceAll('\\', '_') || 'download'
  );
}

function truncateUtf8(name: string): string {
  let result = '';
  for (const character of name) {
    const candidate = result + character;
    if (Buffer.byteLength(candidate, 'utf8') > MAX_FILENAME_BYTES) break;
    result = candidate;
  }
  return result || 'download';
}

function asciiFallback(name: string): string {
  const ascii = name.replaceAll(/[^\x20-\x7e]/g, '_');
  return truncateUtf8(ascii);
}

function rfc5987(name: string): string {
  return encodeURIComponent(name).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.codePointAt(0)?.toString(HEX_RADIX).toUpperCase() ?? ''}`,
  );
}

export function contentDisposition(path: string, download: boolean): string {
  const name = truncateUtf8(cleanFileName(basename(path)));
  return `${download ? 'attachment' : 'inline'}; filename="${asciiFallback(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

export function isInertMarkup(path: string): boolean {
  const extension = fileExtension(path);
  return (
    extension === '.svg' || extension === '.xml' || extension === '.html' || extension === '.htm'
  );
}

export function createReadStreamFromFd(fd: number, size: number): Readable {
  if (size === 0) {
    closeFd(fd);
    return Readable.from([]);
  }
  return createReadStream('', {
    fd,
    autoClose: true,
    emitClose: true,
    start: 0,
    end: size - 1,
  });
}

export function openGlobalFile(root: string, path: string): OpenedPath {
  const parts = validateRelativePath(path, false);
  return openRelativeParts(resolve(root), parts, false);
}

export function closeOpenedFile(file: OpenedPath): void {
  closeFd(file.fd);
}

export function readOpenedText(file: OpenedPath): string {
  return readText(file.fd, file.path, file.stats);
}

export function fileLimits(): {
  maxListingEntries: number;
  maxTextBytes: number;
  maxDownloadBytes: number;
  maxPdfBytes: number;
} {
  return {
    maxListingEntries: MAX_LISTING_ENTRIES,
    maxTextBytes: MAX_TEXT_BYTES,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    maxPdfBytes: MAX_PDF_BYTES,
  };
}
