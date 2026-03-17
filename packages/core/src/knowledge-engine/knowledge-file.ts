import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

const SLUG_MAX_LENGTH = 100;

export interface BubbleFrontmatter {
  id: string;
  title: string;
  tags: string[];
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedBubbleFile {
  meta: BubbleFrontmatter;
  content: string;
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
  let candidate = `${slug}.md`;
  let counter = 2;
  while (existsSync(join(knowledgeDir, candidate))) {
    const existing = safeReadBubbleFile(join(knowledgeDir, candidate));
    if (existing && excludeId && existing.meta.id === excludeId) {
      return candidate;
    }
    candidate = `${slug}-${counter}.md`;
    counter++;
  }
  return candidate;
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

export function writeBubbleFile(filePath: string, meta: BubbleFrontmatter, content: string): void {
  writeFileSync(filePath, serializeMarkdownFile(meta, content), 'utf-8');
}

export function readBubbleFile(filePath: string): ParsedBubbleFile {
  const raw = readFileSync(filePath, 'utf-8');
  return parseMarkdownFile(raw);
}

function safeReadBubbleFile(filePath: string): ParsedBubbleFile | undefined {
  try {
    return readBubbleFile(filePath);
  } catch {
    return undefined;
  }
}

export function deleteBubbleFile(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export function listMarkdownFiles(knowledgeDir: string): string[] {
  if (!existsSync(knowledgeDir)) return [];
  return readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'));
}
