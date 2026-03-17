import { join } from 'node:path';
import { Integer as neo4jInteger } from 'neo4j-driver';
import {
  generateId,
  createLogger,
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
import type { Neo4jClient } from './neo4j-client.ts';

const log = createLogger('knowledge-store');

const PREVIEW_LENGTH = 200;
const DEFAULT_LIMIT = 50;

export interface KnowledgeStore {
  insert: (input: CreateKnowledgeBubble) => Promise<KnowledgeBubble>;
  update: (id: string, input: UpdateKnowledgeBubble) => Promise<KnowledgeBubble | undefined>;
  remove: (id: string) => Promise<boolean>;
  getById: (id: string) => Promise<KnowledgeBubble | undefined>;
  getContentPreview: (bubbleId: string) => Promise<string | undefined>;
  list: (query: KnowledgeQuery) => Promise<KnowledgeBubbleSummary[]>;
  search: (query: string, limit: number, offset: number) => Promise<KnowledgeBubbleSummary[]>;
  getAllTags: () => Promise<Array<{ tag: string; count: number }>>;
  reindexAll: () => Promise<{ indexed: number; errors: string[] }>;
}

function contentPreview(content: string): string {
  return content.slice(0, PREVIEW_LENGTH);
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

interface BubbleNode {
  id: string;
  title: string;
  filePath: string;
  contentPreview: string | null;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  permanence: string;
  createdAt: string;
  updatedAt: string;
}

interface TagResult {
  tag: string;
  count: number;
}

function nodeToBubbleSummary(
  node: BubbleNode,
  tags: string[],
  domains: string[],
): KnowledgeBubbleSummary {
  return {
    id: node.id,
    title: node.title,
    contentPreview: node.contentPreview ?? '',
    filePath: node.filePath,
    source: node.source,
    sourceFile: node.sourceFile ?? null,
    sourceUrl: node.sourceUrl ?? null,
    tags,
    domains,
    permanence: (node.permanence ?? 'normal') as Permanence,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes all knowledge store methods
export function createKnowledgeStore(deps: {
  neo4j: Neo4jClient;
  knowledgeDir: string;
}): KnowledgeStore {
  const { neo4j, knowledgeDir } = deps;

  // eslint-disable-next-line max-lines-per-function -- CRUD with source file/URL field mapping
  async function insertBubble(input: CreateKnowledgeBubble): Promise<KnowledgeBubble> {
    const id = generateId();
    const now = new Date().toISOString();
    const slug = slugify(input.title);
    const fileName = resolveFilename(knowledgeDir, slug);
    const source = input.source ?? null;
    const sourceFile = input.sourceFile ?? null;
    const sourceUrl = input.sourceUrl ?? null;
    const permanence = input.permanence ?? 'normal';
    const tags = input.tags;
    const meta = buildFrontmatter({
      id,
      title: input.title,
      tags,
      source,
      sourceFile,
      sourceUrl,
      createdAt: now,
      updatedAt: now,
    });

    writeBubbleFile(join(knowledgeDir, fileName), meta, input.content);

    try {
      await neo4j.withTransaction(async (tx) => {
        // Create Bubble node
        await tx.run(
          `CREATE (b:Bubble {
            id: $id, title: $title, filePath: $filePath,
            contentPreview: $contentPreview, source: $source,
            sourceFile: $sourceFile, sourceUrl: $sourceUrl,
            permanence: $permanence, createdAt: $createdAt, updatedAt: $updatedAt
          })`,
          {
            id,
            title: input.title,
            filePath: fileName,
            contentPreview: contentPreview(input.content),
            source,
            sourceFile,
            sourceUrl,
            permanence,
            createdAt: now,
            updatedAt: now,
          },
        );

        // Create tags and link
        for (const tag of tags) {
          await tx.run(
            `MERGE (t:Tag {name: $tag})
             WITH t
             MATCH (b:Bubble {id: $bubbleId})
             CREATE (b)-[:HAS_TAG]->(t)`,
            { tag, bubbleId: id },
          );
        }
      });
    } catch (err) {
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
      tags,
      domains: [],
      permanence,
      createdAt: now,
      updatedAt: now,
    };
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- CRUD update with source file/URL field mapping
  async function updateBubble(
    id: string,
    input: UpdateKnowledgeBubble,
  ): Promise<KnowledgeBubble | undefined> {
    const existing = await neo4j.queryOne<BubbleNode>(
      `MATCH (b:Bubble {id: $id}) RETURN b {.*} AS node`,
      { id },
    );
    if (!existing) return undefined;
    const node = (existing as unknown as { node: BubbleNode }).node;

    const file = readBubbleFile(join(knowledgeDir, node.filePath));
    const title = input.title ?? node.title;
    const content = input.content ?? file.content;
    const source = input.source !== undefined ? input.source : node.source;
    const sourceFile =
      input.sourceFile !== undefined ? input.sourceFile : (node.sourceFile ?? null);
    const sourceUrl = input.sourceUrl !== undefined ? input.sourceUrl : (node.sourceUrl ?? null);
    const now = new Date().toISOString();

    // Get current tags from Neo4j
    const tagRows = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $id})-[:HAS_TAG]->(t:Tag) RETURN t.name AS name`,
      { id },
    );
    const currentTags = tagRows.map((r) => r.name);
    const tags = input.tags ?? currentTags;

    let fileName = node.filePath;
    if (input.title && input.title !== node.title) {
      deleteBubbleFile(join(knowledgeDir, node.filePath));
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
      createdAt: node.createdAt,
      updatedAt: now,
    });
    writeBubbleFile(join(knowledgeDir, fileName), meta, content);

    await neo4j.withTransaction(async (tx) => {
      // Update Bubble node
      await tx.run(
        `MATCH (b:Bubble {id: $id})
         SET b.title = $title, b.filePath = $filePath,
             b.contentPreview = $contentPreview, b.source = $source,
             b.sourceFile = $sourceFile, b.sourceUrl = $sourceUrl,
             b.updatedAt = $updatedAt`,
        {
          id,
          title,
          filePath: fileName,
          contentPreview: contentPreview(content),
          source,
          sourceFile,
          sourceUrl,
          updatedAt: now,
        },
      );

      // Replace tags
      await tx.run(`MATCH (b:Bubble {id: $id})-[r:HAS_TAG]->() DELETE r`, { id });
      for (const tag of tags) {
        await tx.run(
          `MERGE (t:Tag {name: $tag})
           WITH t
           MATCH (b:Bubble {id: $bubbleId})
           CREATE (b)-[:HAS_TAG]->(t)`,
          { tag, bubbleId: id },
        );
      }
    });

    // Get domains
    const domainRows = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $id})-[:IN_DOMAIN]->(d:Domain) RETURN d.name AS name`,
      { id },
    );

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
      domains: domainRows.map((r) => r.name),
      permanence: (node.permanence ?? 'normal') as Permanence,
      createdAt: node.createdAt,
      updatedAt: now,
    };
  }

  async function removeBubble(id: string): Promise<boolean> {
    const existing = await neo4j.queryOne<{ filePath: string }>(
      `MATCH (b:Bubble {id: $id}) RETURN b.filePath AS filePath`,
      { id },
    );
    if (!existing) return false;

    await neo4j.run(`MATCH (b:Bubble {id: $id}) DETACH DELETE b`, { id });
    deleteBubbleFile(join(knowledgeDir, existing.filePath));

    log.info(`Knowledge bubble deleted: ${id} (${existing.filePath})`);
    return true;
  }

  async function getById(id: string): Promise<KnowledgeBubble | undefined> {
    const row = await neo4j.queryOne<{ filePath: string; node: BubbleNode }>(
      `MATCH (b:Bubble {id: $id}) RETURN b {.*} AS node, b.filePath AS filePath`,
      { id },
    );
    if (!row) return undefined;
    const node = row.node;

    const file = readBubbleFile(join(knowledgeDir, node.filePath));
    const tagRows = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $id})-[:HAS_TAG]->(t:Tag) RETURN t.name AS name`,
      { id },
    );
    const domainRows = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $id})-[:IN_DOMAIN]->(d:Domain) RETURN d.name AS name`,
      { id },
    );

    return {
      id: node.id,
      title: node.title,
      content: file.content,
      filePath: node.filePath,
      source: node.source,
      sourceFile: node.sourceFile ?? null,
      sourceUrl: node.sourceUrl ?? null,
      tags: tagRows.map((r) => r.name),
      domains: domainRows.map((r) => r.name),
      permanence: (node.permanence ?? 'normal') as Permanence,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }

  async function getContentPreview(bubbleId: string): Promise<string | undefined> {
    const row = await neo4j.queryOne<{ contentPreview: string | null }>(
      `MATCH (b:Bubble {id: $id}) RETURN b.contentPreview AS contentPreview`,
      { id: bubbleId },
    );
    return row?.contentPreview ?? undefined;
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- query building with multiple optional filters
  async function listBubbles(query: KnowledgeQuery): Promise<KnowledgeBubbleSummary[]> {
    if (query.q) {
      return searchBubbles(query.q, query.limit ?? DEFAULT_LIMIT, query.offset ?? 0);
    }

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    const matchClauses: string[] = ['MATCH (b:Bubble)'];

    if (query.tag) {
      matchClauses[0] = 'MATCH (b:Bubble)-[:HAS_TAG]->(t:Tag {name: $tag})';
      params.tag = query.tag;
    }
    if (query.domain) {
      matchClauses.push('MATCH (b)-[:IN_DOMAIN]->(d:Domain {name: $domain})');
      params.domain = query.domain;
    }
    const matchClause = matchClauses.join('\n');
    if (query.source) {
      conditions.push('b.source = $source');
      params.source = query.source;
    }
    if (query.sourceFile) {
      conditions.push('b.sourceFile = $sourceFile');
      params.sourceFile = query.sourceFile;
    }
    if (query.sourceUrl) {
      conditions.push('b.sourceUrl = $sourceUrl');
      params.sourceUrl = query.sourceUrl;
    }
    if (query.permanence) {
      conditions.push('b.permanence = $permanence');
      params.permanence = query.permanence;
    }
    if (query.createdAfter) {
      conditions.push('b.createdAt >= $createdAfter');
      params.createdAfter = query.createdAfter;
    }
    if (query.createdBefore) {
      conditions.push('b.createdAt <= $createdBefore');
      params.createdBefore = query.createdBefore;
    }
    if (query.updatedAfter) {
      conditions.push('b.updatedAt >= $updatedAfter');
      params.updatedAfter = query.updatedAfter;
    }
    if (query.updatedBefore) {
      conditions.push('b.updatedAt <= $updatedBefore');
      params.updatedBefore = query.updatedBefore;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    params.limit = neo4jInt(limit);
    params.offset = neo4jInt(offset);

    const cypher = `${matchClause}
      ${whereClause}
      WITH b ORDER BY b.updatedAt DESC SKIP $offset LIMIT $limit
      OPTIONAL MATCH (b)-[:HAS_TAG]->(tag:Tag)
      OPTIONAL MATCH (b)-[:IN_DOMAIN]->(dom:Domain)
      RETURN b {.*} AS node,
             collect(DISTINCT tag.name) AS tags,
             collect(DISTINCT dom.name) AS domains`;

    const rows = await neo4j.query<{ node: BubbleNode; tags: string[]; domains: string[] }>(
      cypher,
      params,
    );
    return rows.map((r) => nodeToBubbleSummary(r.node, r.tags, r.domains));
  }

  async function searchBubbles(
    query: string,
    limit: number,
    offset: number,
  ): Promise<KnowledgeBubbleSummary[]> {
    if (!query.trim()) return [];

    // Escape lucene special characters for full-text search
    const escaped = query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

    const cypher = `CALL db.index.fulltext.queryNodes('bubble_fulltext', $query)
      YIELD node AS b, score
      SKIP $offset LIMIT $limit
      OPTIONAL MATCH (b)-[:HAS_TAG]->(tag:Tag)
      OPTIONAL MATCH (b)-[:IN_DOMAIN]->(dom:Domain)
      RETURN b {.*} AS node,
             collect(DISTINCT tag.name) AS tags,
             collect(DISTINCT dom.name) AS domains`;

    const rows = await neo4j.query<{ node: BubbleNode; tags: string[]; domains: string[] }>(
      cypher,
      { query: escaped, limit: neo4jInt(limit), offset: neo4jInt(offset) },
    );
    return rows.map((r) => nodeToBubbleSummary(r.node, r.tags, r.domains));
  }

  async function getAllTags(): Promise<Array<{ tag: string; count: number }>> {
    return neo4j.query<TagResult>(
      `MATCH (t:Tag)<-[:HAS_TAG]-(b:Bubble)
       RETURN t.name AS tag, count(b) AS count
       ORDER BY count DESC`,
    );
  }

  // eslint-disable-next-line max-lines-per-function -- reindex iterates files with multiple fallback paths
  async function reindexAll(): Promise<{ indexed: number; errors: string[] }> {
    const files = listMarkdownFiles(knowledgeDir);
    const errors: string[] = [];

    // Clear all Bubble nodes (preserves Tag/Domain/Cluster nodes)
    await neo4j.run('MATCH (b:Bubble) DETACH DELETE b');

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

        const id = meta.id;
        const title = meta.title ?? fileName.replace('.md', '');
        const now = new Date().toISOString();

        await neo4j.withTransaction(async (tx) => {
          await tx.run(
            `CREATE (b:Bubble {
              id: $id, title: $title, filePath: $filePath,
              contentPreview: $contentPreview, source: $source,
              sourceFile: $sourceFile, sourceUrl: $sourceUrl,
              permanence: $permanence, createdAt: $createdAt, updatedAt: $updatedAt
            })`,
            {
              id,
              title,
              filePath: fileName,
              contentPreview: contentPreview(parsed.content),
              source: meta.source ?? null,
              sourceFile: meta.source_file ?? null,
              sourceUrl: meta.source_url ?? null,
              permanence: 'normal',
              createdAt: meta.created_at ?? now,
              updatedAt: meta.updated_at ?? now,
            },
          );

          for (const tag of meta.tags ?? []) {
            await tx.run(
              `MERGE (t:Tag {name: $tag})
               WITH t
               MATCH (b:Bubble {id: $bubbleId})
               CREATE (b)-[:HAS_TAG]->(t)`,
              { tag, bubbleId: id },
            );
          }
        });

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
    getContentPreview,
    list: listBubbles,
    search: searchBubbles,
    getAllTags,
    reindexAll,
  };
}

/** Helper to convert JS number to Neo4j Integer for SKIP/LIMIT */
function neo4jInt(n: number): neo4jInteger {
  return neo4jInteger.fromNumber(n);
}
