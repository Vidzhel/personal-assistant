import { readFileSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { extname, basename, resolve, relative } from 'node:path';
import { createLogger } from '@raven/shared';

const log = createLogger('content-extractor');

const MAX_FILE_SIZE_BYTES = 52_428_800; // 50MB
const URL_FETCH_TIMEOUT_MS = 30_000;
const MAX_URL_CONTENT_BYTES = 512_000;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.ts',
  '.js',
  '.py',
  '.log',
  '.toml',
  '.ini',
  '.cfg',
  '.rst',
  '.tex',
  '.env',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export type FileCategory = 'pdf' | 'text' | 'unsupported';

export function detectFileType(filePath: string): FileCategory {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateFileAccess(filePath: string): void {
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE_BYTES})`);
  }
}

async function extractPdf(filePath: string): Promise<string> {
  const { extractText } = await import('unpdf');
  const buffer = readFileSync(filePath);
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  const text = result.text ?? '';
  if (!text.trim()) {
    throw new Error('PDF extraction returned empty content');
  }
  return text;
}

function extractTextFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) {
    return stripHtml(content);
  }
  return content;
}

export async function extractFromFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  validateFileAccess(filePath);

  const category = detectFileType(filePath);
  switch (category) {
    case 'pdf':
      return extractPdf(filePath);
    case 'text':
      return extractTextFile(filePath);
    case 'unsupported':
      throw new Error(`Unsupported file type: ${extname(filePath).toLowerCase()}`);
  }
}

export async function extractFromUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`URL fetch failed: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('text/html');
    const content = isHtml ? stripHtml(text) : text;
    return content.slice(0, MAX_URL_CONTENT_BYTES);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`URL fetch timed out after ${URL_FETCH_TIMEOUT_MS}ms: ${url}`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function copyToMediaDir(params: { sourcePath: string; mediaDir: string }): string {
  const { sourcePath, mediaDir } = params;
  const resolvedSource = resolve(sourcePath);
  const resolvedMedia = resolve(mediaDir);

  if (resolvedSource.startsWith(resolvedMedia)) {
    const relPath = relative(resolve(mediaDir, '..', '..'), resolvedSource);
    log.info(`File already in media dir, skipping copy: ${relPath}`);
    return relPath;
  }

  const originalName = basename(sourcePath);
  let targetPath = resolve(mediaDir, originalName);

  if (existsSync(targetPath)) {
    const timestampedName = `${Date.now()}-${originalName}`;
    targetPath = resolve(mediaDir, timestampedName);
  }

  copyFileSync(resolvedSource, targetPath);
  const relPath = relative(resolve(mediaDir, '..', '..'), targetPath);
  log.info(`Copied file to media dir: ${relPath}`);
  return relPath;
}
