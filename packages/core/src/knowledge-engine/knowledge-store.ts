import { join } from 'node:path';
import {
  generateId,
  createLogger,
  type DatabaseInterface,
  type KnowledgeBubble,
  type KnowledgeBubbleSummary,
  type CreateKnowledgeBubble,
  type UpdateKnowledgeBubble,
  type KnowledgeQuery,
  type Permanence,
} from '@raven/shared';
import {
  slugify,
  resolveFilename,
  writeBubbleFile,
  readBubbleFile,
  deleteBubbleFile,
  listMarkdownFiles,
  type BubbleFrontmatter,
} from './knowledge-file.ts';

const log = createLogger('knowledge-store');

const PREVIEW_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const FTS_SPECIAL_CHARS = /["*{}:^()]/g;
const FTS_BOOLEAN_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/gi;

export interface KnowledgeStore {
  insert: (input: CreateKnowledgeBubble) => KnowledgeBubble;
  update: (id: string, input: UpdateKnowledgeBubble) => KnowledgeBubble | undefined;
  remove: (id: string) => boolean;
  getById: (id: string) => KnowledgeBubble | undefined;
  list: (query: KnowledgeQuery) => KnowledgeBubbleSummary[];
  search: (query: string, limit: number, offset: number) => KnowledgeBubbleSummary[];
  getAllTags: () => Array<{ tag: string; count: number }>;
  reindexAll: () => { indexed: number; errors: string[] };
}

interface IndexRow {
  id: string;
  title: string;
  file_path: string;
  content_preview: string | null;
  source: string | null;
  source_file: string | null;
  source_url: string | null;
  permanence: string;
  created_at: string;
  updated_at: string;
}

interface DomainRow {
  domain: string;
}

interface TagRow {
  tag: string;
}

interface TagCountRow {
  tag: string;
  count: number;
}

interface FtsRow {
  bubble_id: string;
}

function contentPreview(content: string): string {
  return content.slice(0, PREVIEW_LENGTH);
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(FTS_SPECIAL_CHARS, ' ').replace(FTS_BOOLEAN_OPERATORS, ' ').trim();
}

interface FrontmatterInput {
  id: string;
  title: string;
  tags: string[];
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function buildFrontmatter(input: FrontmatterInput): BubbleFrontmatter {
  return {
    id: input.id,
    title: input.title,
    tags: input.tags,
    source: input.source,
    source_file: input.sourceFile,
    source_url: input.sourceUrl,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

function getDomainsForBubble(db: DatabaseInterface, bubbleId: string): string[] {
  return db
    .all<DomainRow>('SELECT domain FROM knowledge_bubble_domains WHERE bubble_id = ?', bubbleId)
    .map((r) => r.domain);
}

function rowToSummary(row: IndexRow, tags: string[], domains: string[]): KnowledgeBubbleSummary {
  return {
    id: row.id,
    title: row.title,
    contentPreview: row.content_preview ?? '',
    filePath: row.file_path,
    source: row.source,
    sourceFile: row.source_file ?? null,
    sourceUrl: row.source_url ?? null,
    tags,
    domains,
    permanence: (row.permanence ?? 'normal') as Permanence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertIndexRow(db: DatabaseInterface, row: IndexRow): void {
  db.run(
    `INSERT INTO knowledge_index (id, title, file_path, content_preview, source, source_file, source_url, permanence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.title,
    row.file_path,
    row.content_preview,
    row.source,
    row.source_file,
    row.source_url,
    row.permanence,
    row.created_at,
    row.updated_at,
  );
}

function insertTags(db: DatabaseInterface, bubbleId: string, tags: string[]): void {
  for (const tag of tags) {
    db.run('INSERT INTO knowledge_tags (bubble_id, tag) VALUES (?, ?)', bubbleId, tag);
  }
}

interface FtsEntry {
  bubbleId: string;
  title: string;
  content: string;
}

function insertFts(db: DatabaseInterface, entry: FtsEntry): void {
  db.run(
    'INSERT INTO knowledge_fts (bubble_id, title, content) VALUES (?, ?, ?)',
    entry.bubbleId,
    entry.title,
    entry.content,
  );
}

function removeFts(db: DatabaseInterface, bubbleId: string): void {
  db.run('DELETE FROM knowledge_fts WHERE bubble_id = ?', bubbleId);
}

function getTagsForBubble(db: DatabaseInterface, bubbleId: string): string[] {
  return db
    .all<TagRow>('SELECT tag FROM knowledge_tags WHERE bubble_id = ?', bubbleId)
    .map((r) => r.tag);
}

interface UpdateIndexInput {
  id: string;
  title: string;
  fileName: string;
  content: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  updatedAt: string;
  tags: string[];
}

function updateIndex(db: DatabaseInterface, input: UpdateIndexInput): void {
  db.run(
    `UPDATE knowledge_index SET title = ?, file_path = ?, content_preview = ?, source = ?, source_file = ?, source_url = ?, updated_at = ? WHERE id = ?`,
    input.title,
    input.fileName,
    contentPreview(input.content),
    input.source,
    input.sourceFile,
    input.sourceUrl,
    input.updatedAt,
    input.id,
  );
  db.run('DELETE FROM knowledge_tags WHERE bubble_id = ?', input.id);
  insertTags(db, input.id, input.tags);
  removeFts(db, input.id);
  insertFts(db, { bubbleId: input.id, title: input.title, content: input.content });
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes all knowledge store methods
export function createKnowledgeStore(deps: {
  db: DatabaseInterface;
  knowledgeDir: string;
}): KnowledgeStore {
  const { db, knowledgeDir } = deps;

  // eslint-disable-next-line max-lines-per-function -- CRUD with source file/URL field mapping
  function insertBubble(input: CreateKnowledgeBubble): KnowledgeBubble {
    const id = generateId();
    const now = new Date().toISOString();
    const slug = slugify(input.title);
    const fileName = resolveFilename(knowledgeDir, slug);
    const source = input.source ?? null;
    const sourceFile = input.sourceFile ?? null;
    const sourceUrl = input.sourceUrl ?? null;
    const permanence = input.permanence ?? 'normal';
    const meta = buildFrontmatter({
      id,
      title: input.title,
      tags: input.tags,
      source,
      sourceFile,
      sourceUrl,
      createdAt: now,
      updatedAt: now,
    });

    writeBubbleFile(join(knowledgeDir, fileName), meta, input.content);

    const row: IndexRow = {
      id,
      title: input.title,
      file_path: fileName,
      content_preview: contentPreview(input.content),
      source,
      source_file: sourceFile,
      source_url: sourceUrl,
      permanence,
      created_at: now,
      updated_at: now,
    };
    db.run('BEGIN');
    try {
      insertIndexRow(db, row);
      insertTags(db, id, input.tags);
      insertFts(db, { bubbleId: id, title: input.title, content: input.content });
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      deleteBubbleFile(join(knowledgeDir, fileName));
      throw err;
    }

    log.info(`Knowledge bubble created: ${id} (${fileName})`);
    return {
      id,
      title: input.title,
      content: input.content,
      filePath: fileName,
      source,
      sourceFile,
      sourceUrl,
      tags: input.tags,
      domains: [],
      permanence,
      createdAt: now,
      updatedAt: now,
    };
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- CRUD update with source file/URL field mapping
  function updateBubble(id: string, input: UpdateKnowledgeBubble): KnowledgeBubble | undefined {
    const existing = db.get<IndexRow>('SELECT * FROM knowledge_index WHERE id = ?', id);
    if (!existing) return undefined;

    const file = readBubbleFile(join(knowledgeDir, existing.file_path));
    const title = input.title ?? existing.title;
    const content = input.content ?? file.content;
    const source = input.source !== undefined ? input.source : existing.source;
    const sourceFile =
      input.sourceFile !== undefined ? input.sourceFile : (existing.source_file ?? null);
    const sourceUrl =
      input.sourceUrl !== undefined ? input.sourceUrl : (existing.source_url ?? null);
    const tags = input.tags ?? getTagsForBubble(db, id);
    const now = new Date().toISOString();

    let fileName = existing.file_path;
    if (input.title && input.title !== existing.title) {
      deleteBubbleFile(join(knowledgeDir, existing.file_path));
      const slug = slugify(input.title);
      fileName = resolveFilename(knowledgeDir, slug, id);
    }

    const meta = buildFrontmatter({
      id,
      title,
      tags,
      source,
      sourceFile,
      sourceUrl,
      createdAt: existing.created_at,
      updatedAt: now,
    });
    writeBubbleFile(join(knowledgeDir, fileName), meta, content);

    db.run('BEGIN');
    try {
      updateIndex(db, {
        id,
        title,
        fileName,
        content,
        source,
        sourceFile,
        sourceUrl,
        updatedAt: now,
        tags,
      });
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }

    log.info(`Knowledge bubble updated: ${id} (${fileName})`);
    return {
      id,
      title,
      content,
      filePath: fileName,
      source,
      sourceFile,
      sourceUrl,
      tags,
      domains: getDomainsForBubble(db, id),
      permanence: (existing.permanence ?? 'normal') as Permanence,
      createdAt: existing.created_at,
      updatedAt: now,
    };
  }

  function removeBubble(id: string): boolean {
    const existing = db.get<IndexRow>('SELECT * FROM knowledge_index WHERE id = ?', id);
    if (!existing) return false;

    db.run('BEGIN');
    try {
      db.run('DELETE FROM knowledge_tags WHERE bubble_id = ?', id);
      removeFts(db, id);
      db.run('DELETE FROM knowledge_index WHERE id = ?', id);
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
    deleteBubbleFile(join(knowledgeDir, existing.file_path));

    log.info(`Knowledge bubble deleted: ${id} (${existing.file_path})`);
    return true;
  }

  function getById(id: string): KnowledgeBubble | undefined {
    const row = db.get<IndexRow>('SELECT * FROM knowledge_index WHERE id = ?', id);
    if (!row) return undefined;

    const file = readBubbleFile(join(knowledgeDir, row.file_path));
    const tags = getTagsForBubble(db, id);
    return {
      id: row.id,
      title: row.title,
      content: file.content,
      filePath: row.file_path,
      source: row.source,
      sourceFile: row.source_file ?? null,
      sourceUrl: row.source_url ?? null,
      tags,
      domains: getDomainsForBubble(db, id),
      permanence: (row.permanence ?? 'normal') as Permanence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // eslint-disable-next-line complexity -- query building with multiple optional filters
  function listBubbles(query: KnowledgeQuery): KnowledgeBubbleSummary[] {
    if (query.q) {
      return searchBubbles(query.q, query.limit ?? DEFAULT_LIMIT, query.offset ?? 0);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.tag) {
      conditions.push('ki.id IN (SELECT bubble_id FROM knowledge_tags WHERE tag = ?)');
      params.push(query.tag);
    }
    if (query.source) {
      conditions.push('ki.source = ?');
      params.push(query.source);
    }
    if (query.domain) {
      conditions.push('ki.id IN (SELECT bubble_id FROM knowledge_bubble_domains WHERE domain = ?)');
      params.push(query.domain);
    }
    if (query.permanence) {
      conditions.push('ki.permanence = ?');
      params.push(query.permanence);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT ki.* FROM knowledge_index ki ${whereClause} ORDER BY ki.updated_at DESC LIMIT ? OFFSET ?`;
    params.push(query.limit ?? DEFAULT_LIMIT, query.offset ?? 0);

    const rows = db.all<IndexRow>(sql, ...params);
    return rows.map((row) =>
      rowToSummary(row, getTagsForBubble(db, row.id), getDomainsForBubble(db, row.id)),
    );
  }

  function searchBubbles(query: string, limit: number, offset: number): KnowledgeBubbleSummary[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const ftsRows = db.all<FtsRow>(
      `SELECT bubble_id FROM knowledge_fts WHERE knowledge_fts MATCH '{title content}: ' || ? ORDER BY rank LIMIT ? OFFSET ?`,
      sanitized,
      limit,
      offset,
    );

    return ftsRows
      .map((fts) => {
        const row = db.get<IndexRow>('SELECT * FROM knowledge_index WHERE id = ?', fts.bubble_id);
        if (!row) return undefined;
        return rowToSummary(row, getTagsForBubble(db, row.id), getDomainsForBubble(db, row.id));
      })
      .filter((r): r is KnowledgeBubbleSummary => r !== undefined);
  }

  function getAllTags(): Array<{ tag: string; count: number }> {
    return db.all<TagCountRow>(
      'SELECT tag, COUNT(*) as count FROM knowledge_tags GROUP BY tag ORDER BY count DESC',
    );
  }

  // eslint-disable-next-line complexity -- reindex iterates files with multiple fallback paths
  function reindexAll(): { indexed: number; errors: string[] } {
    const files = listMarkdownFiles(knowledgeDir);
    const errors: string[] = [];

    db.run('DELETE FROM knowledge_fts');
    db.run('DELETE FROM knowledge_tags');
    db.run('DELETE FROM knowledge_index');

    let indexed = 0;
    for (const fileName of files) {
      try {
        const filePath = join(knowledgeDir, fileName);
        const parsed = readBubbleFile(filePath);
        const meta = parsed.meta;

        if (!meta.id) {
          meta.id = generateId();
          writeBubbleFile(filePath, meta, parsed.content);
        }

        const row: IndexRow = {
          id: meta.id,
          title: meta.title ?? fileName.replace('.md', ''),
          file_path: fileName,
          content_preview: contentPreview(parsed.content),
          source: meta.source ?? null,
          source_file: meta.source_file ?? null,
          source_url: meta.source_url ?? null,
          permanence: 'normal',
          created_at: meta.created_at ?? new Date().toISOString(),
          updated_at: meta.updated_at ?? new Date().toISOString(),
        };
        insertIndexRow(db, row);
        insertTags(db, meta.id, meta.tags ?? []);
        insertFts(db, { bubbleId: meta.id, title: row.title, content: parsed.content });
        indexed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${fileName}: ${msg}`);
        log.warn(`Failed to index knowledge file ${fileName}: ${msg}`);
      }
    }

    log.info(`Knowledge reindex complete: ${indexed} indexed, ${errors.length} errors`);
    return { indexed, errors };
  }

  return {
    insert: insertBubble,
    update: updateBubble,
    remove: removeBubble,
    getById,
    list: listBubbles,
    search: searchBubbles,
    getAllTags,
    reindexAll,
  };
}
