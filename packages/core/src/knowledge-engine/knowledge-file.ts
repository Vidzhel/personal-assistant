import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

const SLUG_MAX_LENGTH = 100;

export interface BubbleFrontmatter {
  id: string;
  title?: string;
  tags?: string[];
  source: string | null;
  source_file: string | null;
  source_url: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ParsedBubbleFile {
  meta: BubbleFrontmatter;
  content: string;
}

export const BubbleFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).nullish(),
    tags: z
      .array(z.string())
      .nullish()
      .transform((value) => value ?? []),
    source: z.string().nullable().optional().default(null),
    source_file: z.string().nullable().optional().default(null),
    source_url: z.string().nullable().optional().default(null),
    created_at: z
      .union([z.string().min(1), z.date().transform((date) => date.toISOString())])
      .optional(),
    updated_at: z
      .union([z.string().min(1), z.date().transform((date) => date.toISOString())])
      .optional(),
  })
  .loose();

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertKnowledgeRoot(knowledgeDir: string): string {
  const root = resolve(knowledgeDir);
  const stat = statOrUndefined(root);
  if (!stat) throw new Error(`Knowledge directory does not exist: ${root}`);
  if (stat.isSymbolicLink() || realpathSync(root) !== root || !stat.isDirectory()) {
    throw new Error(`Knowledge directory must be a real directory: ${root}`);
  }
  return root;
}

function assertSafeFileName(fileName: string): void {
  if (
    isAbsolute(fileName) ||
    fileName.includes('\0') ||
    fileName.includes('\\') ||
    fileName.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe knowledge file path: ${fileName}`);
  }
}

export function resolveKnowledgePath(knowledgeDir: string, fileName: string): string {
  assertSafeFileName(fileName);
  const root = assertKnowledgeRoot(knowledgeDir);
  const path = resolve(root, fileName);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Knowledge file path escapes knowledge directory: ${fileName}`);
  }
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    const stat = statOrUndefined(current);
    if (stat?.isSymbolicLink())
      throw new Error(`Knowledge path must not contain symlinks: ${current}`);
  }
  return path;
}

function assertRegularFile(path: string, label: string): void {
  const stat = statOrUndefined(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function flushDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path: string): void {
  const parts = resolve(path).split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = current === '/' ? `/${part}` : join(current, part);
    const stat = statOrUndefined(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Knowledge directory component is unsafe: ${current}`);
      }
    } else {
      mkdirSync(current);
      flushDirectory(dirname(current));
    }
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
}

export function resolveFilename(knowledgeDir: string, slug: string, excludeId?: string): string {
  const root = assertKnowledgeRoot(knowledgeDir);
  let candidate = `${slug}.md`;
  let counter = 2;
  while (true) {
    const path = resolveKnowledgePath(root, candidate);
    const stat = statOrUndefined(path);
    if (!stat) return candidate;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Knowledge path must be a regular file: ${path}`);
    }
    const existing = safeReadBubbleFile(path);
    if (existing && excludeId && existing.meta.id === excludeId) return candidate;
    candidate = `${slug}-${counter}.md`;
    counter += 1;
  }
}

export function parseMarkdownFile(raw: string): ParsedBubbleFile {
  const { data, content } = matter(raw);
  return {
    meta: data as BubbleFrontmatter,
    content: content.trim(),
  };
}

export function serializeMarkdownFile(meta: BubbleFrontmatter, content: string): string {
  return matter.stringify(content, meta);
}

function atomicReplace(path: string, bytes: string): void {
  ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    flushDirectory(dirname(path));
  } finally {
    if (statOrUndefined(temporary)) unlinkSync(temporary);
  }
}

export function atomicWriteKnowledgeText(
  knowledgeDir: string,
  fileName: string,
  bytes: string,
): void {
  atomicReplace(resolveKnowledgePath(knowledgeDir, fileName), bytes);
}

function writeBubbleFileWithOptions(options: {
  filePath: string;
  meta: BubbleFrontmatter;
  content: string;
  expectedHash?: string | null;
}): void {
  const bytes = serializeMarkdownFile(options.meta, options.content);
  if (options.expectedHash !== undefined) {
    const stat = statOrUndefined(options.filePath);
    if (options.expectedHash === null) {
      if (stat) throw new Error(`Knowledge destination already exists: ${options.filePath}`);
    } else {
      assertRegularFile(options.filePath, 'Knowledge source file');
    }
    if (
      options.expectedHash !== null &&
      sha256(readFileSync(options.filePath, 'utf8')) !== options.expectedHash
    ) {
      throw new Error(`Knowledge file changed while being updated: ${options.filePath}`);
    }
  }
  atomicReplace(options.filePath, bytes);
}

export function writeBubbleFile(filePath: string, meta: BubbleFrontmatter, content: string): void {
  writeBubbleFileWithOptions({ filePath, meta, content });
}

export function writeOwnedBubbleFile(options: {
  knowledgeDir: string;
  fileName: string;
  meta: BubbleFrontmatter;
  content: string;
  expectedHash?: string | null;
}): string {
  const path = resolveKnowledgePath(options.knowledgeDir, options.fileName);
  writeBubbleFileWithOptions({
    filePath: path,
    meta: options.meta,
    content: options.content,
    expectedHash: options.expectedHash,
  });
  return path;
}

export function readBubbleFile(filePath: string): ParsedBubbleFile {
  assertRegularFile(filePath, 'Knowledge file');
  return parseMarkdownFile(readFileSync(filePath, 'utf8'));
}

function safeReadBubbleFile(filePath: string): ParsedBubbleFile | undefined {
  try {
    return readBubbleFile(filePath);
  } catch {
    return undefined;
  }
}

export function readOwnedBubbleFile(
  knowledgeDir: string,
  fileName: string,
  id: string,
): { path: string; bytes: string; parsed: ParsedBubbleFile; hash: string } {
  const path = resolveKnowledgePath(knowledgeDir, fileName);
  assertRegularFile(path, 'Knowledge file');
  const bytes = readFileSync(path, 'utf8');
  const parsed = parseMarkdownFile(bytes);
  const validated = BubbleFrontmatterSchema.parse(parsed.meta);
  const meta: BubbleFrontmatter = {
    ...validated,
    title: validated.title ?? basename(fileName, '.md'),
    tags: validated.tags ?? [],
  };
  if (meta.id !== id) {
    throw new Error(`Knowledge file identity mismatch for ${id}: ${fileName}`);
  }
  return { path, bytes, parsed: { meta, content: parsed.content }, hash: sha256(bytes) };
}

export function deleteOwnedBubbleFile(
  knowledgeDir: string,
  fileName: string,
  expectedHash: string,
): boolean {
  const path = resolveKnowledgePath(knowledgeDir, fileName);
  const stat = statOrUndefined(path);
  if (!stat) return false;
  assertRegularFile(path, 'Knowledge file');
  if (sha256(readFileSync(path, 'utf8')) !== expectedHash) {
    throw new Error(`Knowledge file changed before deletion: ${fileName}`);
  }
  unlinkSync(path);
  flushDirectory(dirname(path));
  return true;
}

export function deleteBubbleFile(filePath: string): void {
  const stat = statOrUndefined(filePath);
  if (!stat) return;
  assertRegularFile(filePath, 'Knowledge file');
  unlinkSync(filePath);
  flushDirectory(dirname(filePath));
}

export function listMarkdownFiles(knowledgeDir: string): string[] {
  const candidate = resolve(knowledgeDir);
  if (!statOrUndefined(candidate)) return [];
  const root = assertKnowledgeRoot(candidate);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.md'))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Knowledge path must be a regular file: ${join(root, entry.name)}`);
      }
      resolveKnowledgePath(root, entry.name);
      return entry.name;
    });
}
