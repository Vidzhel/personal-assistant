import neo4j, {
  type Driver,
  type Session,
  type ManagedTransaction,
  type Record as Neo4jRecord,
  type QueryResult,
  Integer,
} from 'neo4j-driver';
import { createLogger } from '@raven/shared';

const log = createLogger('neo4j-client');

const EMBEDDING_DIMENSIONS = 384;

export interface Neo4jClient {
  run: (cypher: string, params?: Record<string, unknown>) => Promise<QueryResult>;
  query: <T>(cypher: string, params?: Record<string, unknown>) => Promise<T[]>;
  queryOne: <T>(cypher: string, params?: Record<string, unknown>) => Promise<T | undefined>;
  withTransaction: <T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
    mode?: 'read' | 'write',
  ) => Promise<T>;
  ensureSchema: () => Promise<void>;
  close: () => Promise<void>;
}

function convertRecord(record: Neo4jRecord): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of record.keys) {
    obj[key as string] = convertValue(record.get(key as string));
  }
  return obj;
}

function convertValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Integer.isInteger(value)) return (value as typeof Integer.prototype).toNumber();
  if (typeof value === 'object' && value !== null && 'properties' in value) {
    // Neo4j Node or Relationship
    const node = value as { properties: Record<string, unknown> };
    return convertProperties(node.properties);
  }
  if (Array.isArray(value)) return value.map(convertValue);
  return value;
}

function convertProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    result[key] = convertValue(val);
  }
  return result;
}

interface Neo4jClientDeps {
  uri: string;
  user: string;
  password: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function for Neo4j client
export function createNeo4jClient(deps: Neo4jClientDeps): Neo4jClient {
  const driver: Driver = neo4j.driver(deps.uri, neo4j.auth.basic(deps.user, deps.password));

  async function run(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const session: Session = driver.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  async function query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await run(cypher, params);
    return result.records.map((r) => convertRecord(r) as T);
  }

  async function queryOne<T>(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<T | undefined> {
    const results = await query<T>(cypher, params);
    return results[0];
  }

  async function withTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
    mode: 'read' | 'write' = 'write',
  ): Promise<T> {
    const session: Session = driver.session();
    try {
      if (mode === 'read') {
        return await session.executeRead(fn);
      }
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  async function ensureSchema(): Promise<void> {
    const statements = [
      // Unique constraints
      'CREATE CONSTRAINT bubble_id IF NOT EXISTS FOR (b:Bubble) REQUIRE b.id IS UNIQUE',
      'CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE',
      'CREATE CONSTRAINT domain_name IF NOT EXISTS FOR (d:Domain) REQUIRE d.name IS UNIQUE',
      'CREATE CONSTRAINT cluster_id IF NOT EXISTS FOR (c:Cluster) REQUIRE c.id IS UNIQUE',

      // Range indexes on Bubble properties
      'CREATE INDEX bubble_updated_at IF NOT EXISTS FOR (b:Bubble) ON (b.updatedAt)',
      'CREATE INDEX bubble_created_at IF NOT EXISTS FOR (b:Bubble) ON (b.createdAt)',
      'CREATE INDEX bubble_permanence IF NOT EXISTS FOR (b:Bubble) ON (b.permanence)',
      'CREATE INDEX bubble_source IF NOT EXISTS FOR (b:Bubble) ON (b.source)',
      'CREATE INDEX bubble_source_file IF NOT EXISTS FOR (b:Bubble) ON (b.sourceFile)',
      'CREATE INDEX bubble_source_url IF NOT EXISTS FOR (b:Bubble) ON (b.sourceUrl)',

      // Full-text index on title + contentPreview
      `CREATE FULLTEXT INDEX bubble_fulltext IF NOT EXISTS FOR (b:Bubble) ON EACH [b.title, b.contentPreview]`,

      // Vector index for embeddings (384-dim cosine)
      `CREATE VECTOR INDEX bubble_embedding IF NOT EXISTS FOR (b:Bubble) ON (b.embedding)
       OPTIONS {indexConfig: {
         \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS},
         \`vector.similarity_function\`: 'cosine'
       }}`,

      // Story 6.4: Chunk node constraint and vector index
      'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE',
      `CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS FOR (c:Chunk) ON (c.embedding)
       OPTIONS {indexConfig: {
         \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS},
         \`vector.similarity_function\`: 'cosine'
       }}`,
    ];

    for (const stmt of statements) {
      try {
        await run(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Ignore "already exists" errors for idempotency
        if (!msg.includes('already exists') && !msg.includes('equivalent')) {
          log.warn(`Schema statement warning: ${msg}`);
        }
      }
    }

    // Story 6.6: Backfill lastAccessedAt for existing bubbles without it
    try {
      await run(
        `MATCH (b:Bubble) WHERE b.lastAccessedAt IS NULL SET b.lastAccessedAt = b.updatedAt`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lastAccessedAt backfill warning: ${msg}`);
    }

    log.info('Neo4j schema ensured (constraints, indexes, vector index)');
  }

  async function close(): Promise<void> {
    await driver.close();
    log.info('Neo4j driver closed');
  }

  return {
    run,
    query,
    queryOne,
    withTransaction,
    ensureSchema,
    close,
  };
}
