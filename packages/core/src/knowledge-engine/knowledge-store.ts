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
  deleteOwnedBubbleFile,
  readOwnedBubbleFile,
  writeOwnedBubbleFile,
  type BubbleFrontmatter,
} from './knowledge-file.ts';
import { knowledgeRevision } from './knowledge-revision.ts';
import {
  readPendingKnowledgeDeletions,
  removePendingKnowledgeDeletion,
  writePendingKnowledgeDeletion,
} from './knowledge-deletions.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import { reindexKnowledgeFiles } from './knowledge-reindex.ts';
import {
  reconcileKnowledgeFiles,
  type KnowledgeReconciliationReport,
} from './knowledge-reconciliation.ts';

const log = createLogger('knowledge-store');

const PREVIEW_LENGTH = 200;
const DEFAULT_LIMIT = 50;

export interface KnowledgeStore {
  insert: (input: CreateKnowledgeBubble) => Promise<KnowledgeBubble>;
  update: (id: string, input: UpdateKnowledgeBubble) => Promise<KnowledgeBubble | undefined>;
  remove: (id: string) => Promise<boolean>;
  getById: (
    id: string,
    options?: { trackAccess?: boolean },
  ) => Promise<KnowledgeBubble | undefined>;
  getContentPreview: (bubbleId: string) => Promise<string | undefined>;
  list: (query: KnowledgeQuery) => Promise<KnowledgeBubbleSummary[]>;
  search: (query: string, limit: number, offset: number) => Promise<KnowledgeBubbleSummary[]>;
  getAllTags: () => Promise<Array<{ tag: string; count: number }>>;
  reindexAll: () => Promise<{ indexed: number; errors: string[]; changedIds: string[] }>;
  reconcile: () => Promise<KnowledgeReconciliationReport>;
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
  lastAccessedAt: string | null;
}

interface TagResult {
  tag: string;
  count: number;
}

function findPendingDeletion(
  knowledgeDir: string,
  id: string,
): ReturnType<typeof readPendingKnowledgeDeletions>[number] | undefined {
  return readPendingKnowledgeDeletions(knowledgeDir).find((item) => item.id === id);
}

function prepareDeletion(options: {
  knowledgeDir: string;
  id: string;
  existing: { filePath: string } | undefined;
  pending: ReturnType<typeof findPendingDeletion>;
}): ReturnType<typeof findPendingDeletion> {
  if (options.pending !== undefined) {
    if (options.existing !== undefined && options.pending.filePath !== options.existing.filePath) {
      throw new Error(`Pending deletion path conflicts with graph for ${options.id}`);
    }
    return options.pending;
  }
  if (options.existing === undefined) return undefined;
  const file = readOwnedBubbleFile(options.knowledgeDir, options.existing.filePath, options.id);
  const intent = {
    id: options.id,
    filePath: options.existing.filePath,
    fileHash: file.hash,
  };
  writePendingKnowledgeDeletion(options.knowledgeDir, intent);
  return intent;
}

function assertPendingFileUnchanged(options: {
  knowledgeDir: string;
  existing: { filePath: string } | undefined;
  pending: ReturnType<typeof findPendingDeletion>;
  id: string;
}): void {
  if (options.pending === undefined || options.existing === undefined) return;
  const current = readOwnedBubbleFile(options.knowledgeDir, options.existing.filePath, options.id);
  if (current.hash !== options.pending.fileHash) {
    throw new Error(`Knowledge file changed before deletion: ${options.existing.filePath}`);
  }
}

async function resolveAccessTimestamp(options: {
  neo4j: Neo4jClient;
  id: string;
  node: BubbleNode;
  trackAccess: boolean;
}): Promise<string | null> {
  if (!options.trackAccess) return options.node.lastAccessedAt ?? null;
  const now = new Date().toISOString();
  await options.neo4j.run(`MATCH (b:Bubble {id: $id}) SET b.lastAccessedAt = $now`, {
    id: options.id,
    now,
  });
  return now;
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
  signal?: AbortSignal;
}): KnowledgeStore {
  const { neo4j, knowledgeDir } = deps;
  let mutationTail = Promise.resolve();
  function queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(() => {
      assertActive();
      return operation();
    });
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const assertActive = (): void => deps.signal?.throwIfAborted();
  function readOwnedFile(fileName: string, id: string): ReturnType<typeof readOwnedBubbleFile> {
    return readOwnedBubbleFile(knowledgeDir, fileName, id);
  }

  // eslint-disable-next-line max-lines-per-function -- CRUD with source file/URL field mapping
  async function insertBubble(input: CreateKnowledgeBubble): Promise<KnowledgeBubble> {
    assertActive();
    const id = generateId();
    const now = new Date().toISOString();
    const slug = slugify(input.title) || id;
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

    writeOwnedBubbleFile({
      knowledgeDir,
      fileName,
      meta,
      content: input.content,
      expectedHash: null,
    });

    await neo4j.withTransaction(async (tx) => {
      // Create Bubble node
      await tx.run(
        `CREATE (b:Bubble {
            id: $id, title: $title, filePath: $filePath,
            contentPreview: $contentPreview, source: $source,
            sourceFile: $sourceFile, sourceUrl: $sourceUrl,
            permanence: $permanence, createdAt: $createdAt, updatedAt: $updatedAt,
            sourceRevision: $sourceRevision,
            lastAccessedAt: $lastAccessedAt
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
          sourceRevision: knowledgeRevision({ title: input.title, content: input.content, tags }),
          lastAccessedAt: now,
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
      lastAccessedAt: now,
    };
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- CRUD update with source file/URL field mapping
  async function updateBubble(
    id: string,
    input: UpdateKnowledgeBubble,
  ): Promise<KnowledgeBubble | undefined> {
    assertActive();
    if (findPendingDeletion(knowledgeDir, id) !== undefined) {
      throw new Error(`Knowledge bubble ${id} has a pending deletion`);
    }
    const existing = await neo4j.queryOne<BubbleNode>(
      `MATCH (b:Bubble {id: $id}) RETURN b {.*} AS node`,
      { id },
    );
    assertActive();
    if (!existing) return undefined;
    const node = (existing as unknown as { node: BubbleNode }).node;

    const file = readOwnedFile(node.filePath, id);
    const title = input.title ?? file.parsed.meta.title ?? node.title;
    const content = input.content ?? file.parsed.content;
    const source = input.source !== undefined ? input.source : (file.parsed.meta.source ?? null);
    const sourceFile =
      input.sourceFile !== undefined ? input.sourceFile : (file.parsed.meta.source_file ?? null);
    const sourceUrl =
      input.sourceUrl !== undefined ? input.sourceUrl : (file.parsed.meta.source_url ?? null);
    const now = new Date().toISOString();

    const currentTags = file.parsed.meta.tags ?? [];
    const tags = input.tags ?? currentTags;

    let fileName = node.filePath;
    if (input.title && input.title !== (file.parsed.meta.title ?? node.title)) {
      const slug = slugify(input.title) || id;
      fileName = resolveFilename(knowledgeDir, slug, id);
    }

    const meta = {
      ...file.parsed.meta,
      ...buildFrontmatter({
        id,
        title,
        tags,
        source,
        sourceFile,
        sourceUrl,
        createdAt: file.parsed.meta.created_at ?? node.createdAt,
        updatedAt: now,
      }),
    };
    const sourceRevision = knowledgeRevision({ title, content, tags });
    writeOwnedBubbleFile({
      knowledgeDir,
      fileName,
      meta,
      content,
      expectedHash: fileName === node.filePath ? file.hash : null,
    });

    await neo4j.withTransaction(async (tx) => {
      // Update Bubble node
      await tx.run(
        `MATCH (b:Bubble {id: $id})
         SET b.title = $title, b.filePath = $filePath,
             b.contentPreview = $contentPreview, b.source = $source,
             b.sourceFile = $sourceFile, b.sourceUrl = $sourceUrl,
             b.updatedAt = $updatedAt, b.sourceRevision = $sourceRevision`,
        {
          id,
          title,
          filePath: fileName,
          contentPreview: contentPreview(content),
          source,
          sourceFile,
          sourceUrl,
          updatedAt: now,
          sourceRevision,
        },
      );

      // Remove only relationships to tags no longer owned by the file.
      await tx.run(
        `MATCH (b:Bubble {id: $id})-[r:HAS_TAG]->(t:Tag)
         WHERE NOT t.name IN $tags DELETE r`,
        { id, tags },
      );
      for (const tag of tags) {
        await tx.run(
          `MERGE (t:Tag {name: $tag})
           WITH t
           MATCH (b:Bubble {id: $bubbleId})
           MERGE (b)-[:HAS_TAG]->(t)`,
          { tag, bubbleId: id },
        );
      }
    });

    assertActive();
    if (fileName !== node.filePath) {
      deleteOwnedBubbleFile(knowledgeDir, node.filePath, file.hash);
    }

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
      createdAt: meta.created_at ?? node.createdAt,
      updatedAt: now,
      lastAccessedAt: node.lastAccessedAt ?? now,
    };
  }

  async function removeBubble(id: string): Promise<boolean> {
    assertActive();
    const existing = await neo4j.queryOne<{ filePath: string }>(
      `MATCH (b:Bubble {id: $id}) RETURN b.filePath AS filePath`,
      { id },
    );
    assertActive();
    const pending = findPendingDeletion(knowledgeDir, id);
    if (!existing && !pending) return false;
    const deletion = prepareDeletion({ knowledgeDir, id, existing, pending });
    if (deletion === undefined) return false;
    // Re-read immediately before the graph transaction so an editor change
    // cannot turn this intent into an unsafe deletion.
    assertPendingFileUnchanged({ knowledgeDir, existing, pending: deletion, id });

    if (existing) {
      await neo4j.withTransaction(async (tx) => {
        await tx.run(`MATCH (b:Bubble {id: $id})-[:HAS_CHUNK]->(c:Chunk) DETACH DELETE c`, { id });
        await tx.run(`MATCH (b:Bubble {id: $id}) DETACH DELETE b`, { id });
      });
      assertActive();
    }
    deleteOwnedBubbleFile(knowledgeDir, deletion.filePath, deletion.fileHash);
    removePendingKnowledgeDeletion(knowledgeDir, id);

    log.info(`Knowledge bubble deleted: ${id} (${deletion.filePath})`);
    return true;
  }

  async function getById(
    id: string,
    options: { trackAccess?: boolean } = {},
  ): Promise<KnowledgeBubble | undefined> {
    const row = await neo4j.queryOne<{ filePath: string; node: BubbleNode }>(
      `MATCH (b:Bubble {id: $id}) RETURN b {.*} AS node, b.filePath AS filePath`,
      { id },
    );
    if (!row) return undefined;
    const node = row.node;
    const file = readOwnedFile(node.filePath, id);

    // Bump lastAccessedAt on read (access tracking for stale detection)
    const now = await resolveAccessTimestamp({
      neo4j,
      id,
      node,
      trackAccess: options.trackAccess !== false,
    });
    const domainRows = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $id})-[:IN_DOMAIN]->(d:Domain) RETURN d.name AS name`,
      { id },
    );

    return {
      id: node.id,
      title: file.parsed.meta.title ?? node.title,
      content: file.parsed.content,
      filePath: node.filePath,
      source: file.parsed.meta.source,
      sourceFile: file.parsed.meta.source_file ?? null,
      sourceUrl: file.parsed.meta.source_url ?? null,
      tags: file.parsed.meta.tags ?? [],
      domains: domainRows.map((r) => r.name),
      permanence: (node.permanence ?? 'normal') as Permanence,
      createdAt: file.parsed.meta.created_at ?? node.createdAt,
      updatedAt: file.parsed.meta.updated_at ?? node.updatedAt,
      lastAccessedAt: now,
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

  return {
    insert: (input) => queueMutation(() => insertBubble(input)),
    update: (id, input) => queueMutation(() => updateBubble(id, input)),
    remove: (id) => queueMutation(() => removeBubble(id)),
    getById,
    getContentPreview,
    list: listBubbles,
    search: searchBubbles,
    getAllTags,
    reindexAll: () =>
      queueMutation(() => reindexKnowledgeFiles({ neo4j, knowledgeDir, signal: deps.signal })),
    reconcile: () => queueMutation(() => reconcileKnowledgeFiles({ neo4j, knowledgeDir })),
  };
}

/** Helper to convert JS number to Neo4j Integer for SKIP/LIMIT */
function neo4jInt(n: number): neo4jInteger {
  return neo4jInteger.fromNumber(n);
}
