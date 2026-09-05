import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient, type Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore, type KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { knowledgeRevision } from '../knowledge-engine/knowledge-revision.ts';

describe('file-owned knowledge merge', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let root: string;
  let knowledgeDir: string;
  let store: KnowledgeStore;

  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').start();
    neo4j = createNeo4jClient({
      uri: container.getBoltUri(),
      user: 'neo4j',
      password: container.getPassword(),
    });
    await neo4j.ensureSchema();
  }, 120_000);

  afterAll(async () => {
    if (neo4j) await neo4j.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await neo4j.run('MATCH (n) DETACH DELETE n');
    root = mkdtempSync(join(tmpdir(), 'raven-knowledge-merge-'));
    knowledgeDir = join(root, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    store = createKnowledgeStore({ neo4j, knowledgeDir });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a new source and preserves durable relationship properties', async () => {
    const first = await store.insert({ title: 'First', content: 'one', tags: ['alpha'] });
    const second = await store.insert({ title: 'Second', content: 'two', tags: ['beta'] });
    const external = await store.insert({ title: 'External', content: 'three', tags: [] });
    await neo4j.run(
      `MATCH (a:Bubble {id: $a}), (b:Bubble {id: $b}), (e:Bubble {id: $e})
       CREATE (p:Project {id: 'project-merge'})
       CREATE (d:Domain {name: 'merge-domain'})
       CREATE (c:Cluster {id: 'merge-cluster'})
       CREATE (a)-[:BELONGS_TO_PROJECT {linkedBy: 'human', createdAt: '2026-01-01'}]->(p)
       CREATE (b)-[:BELONGS_TO_PROJECT {linkedBy: 'agent', createdAt: '2026-01-02'}]->(p)
       CREATE (a)-[:IN_DOMAIN {annotation: 'curated'}]->(d)
       CREATE (b)-[:IN_CLUSTER]->(c)
       CREATE (e)-[:LINKS_TO {id: 'incoming', relationshipType: 'supports', confidence: 0.9,
         autoSuggested: false, status: 'accepted', createdAt: '2026-01-01', custom: 'keep'}]->(a)
       CREATE (b)-[:LINKS_TO {id: 'outgoing', relationshipType: 'related', confidence: 0.4,
         autoSuggested: true, status: 'suggested', createdAt: '2026-01-02', custom: 'keep'}]->(e)`,
      { a: first.id, b: second.id, e: external.id },
    );
    const result = await store.mergeOwned({
      sources: [
        {
          id: first.id,
          revision: knowledgeRevision({
            title: first.title,
            content: first.content,
            tags: first.tags,
          }),
        },
        {
          id: second.id,
          revision: knowledgeRevision({
            title: second.title,
            content: second.content,
            tags: second.tags,
          }),
        },
      ],
      title: 'Merged',
      content: 'combined',
    });

    expect(result.title).toBe('Merged');
    expect(result.tags).toEqual(['alpha', 'beta']);
    expect(existsSync(join(knowledgeDir, result.filePath))).toBe(true);
    expect(readFileSync(join(knowledgeDir, result.filePath), 'utf8')).toContain('combined');
    expect(await store.getById(first.id, { trackAccess: false })).toBeUndefined();
    expect(await store.getById(second.id, { trackAccess: false })).toBeUndefined();
    expect(
      await neo4j.query(
        `MATCH (source:Bubble)-[r:LINKS_TO]->(target:Bubble)
         WHERE target.id = $targetId RETURN source.id AS source, properties(r) AS props`,
        { targetId: result.id },
      ),
    ).toEqual([
      {
        source: external.id,
        props: expect.objectContaining({ id: 'incoming', custom: 'keep' }),
      },
    ]);
    expect(
      await neo4j.query(
        `MATCH (source:Bubble)-[r:LINKS_TO]->(target:Bubble)
         WHERE source.id = $targetId RETURN target.id AS target, properties(r) AS props`,
        { targetId: result.id },
      ),
    ).toEqual([
      {
        target: external.id,
        props: expect.objectContaining({ id: 'outgoing', custom: 'keep' }),
      },
    ]);
    const projectEdges = await neo4j.query(
      `MATCH (b:Bubble {id: $id})-[r:BELONGS_TO_PROJECT]->(p)
       RETURN p.id AS projectId, properties(r) AS props`,
      { id: result.id },
    );
    expect(projectEdges).toHaveLength(2);
    expect(projectEdges).toEqual(
      expect.arrayContaining([
        { projectId: 'project-merge', props: expect.objectContaining({ linkedBy: 'human' }) },
        { projectId: 'project-merge', props: expect.objectContaining({ linkedBy: 'agent' }) },
      ]),
    );
    expect(
      await neo4j.query(
        `MATCH (b:Bubble {id: $id})-[r:IN_DOMAIN]->(d)
         RETURN d.name AS name, properties(r) AS props`,
        { id: result.id },
      ),
    ).toEqual([{ name: 'merge-domain', props: { annotation: 'curated' } }]);
    expect(
      await neo4j.query(
        `MATCH (b:Bubble {id: $id})-[:IN_CLUSTER]->(c)
         RETURN c.id AS id`,
        { id: result.id },
      ),
    ).toEqual([{ id: 'merge-cluster' }]);
  });

  it('rejects a source revision changed while synthesis was in flight', async () => {
    const source = await store.insert({ title: 'Original', content: 'before', tags: [] });
    await store.update(source.id, { content: 'after' });
    const other = await store.insert({ title: 'Other', content: 'other', tags: [] });
    await expect(
      store.mergeOwned({
        sources: [
          {
            id: source.id,
            revision: knowledgeRevision({ title: 'Original', content: 'before', tags: [] }),
          },
          {
            id: other.id,
            revision: knowledgeRevision({ title: 'Other', content: 'other', tags: [] }),
          },
        ],
        title: 'Merged',
        content: 'stale result',
      }),
    ).rejects.toThrow('changed');
    expect(await neo4j.query('MATCH (b:Bubble) RETURN count(b) AS count')).toEqual([{ count: 2 }]);
  });
});
