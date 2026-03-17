import { createLogger, type KnowledgeDomain, type TagTreeNode } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import { cosineSimilarity } from './embeddings.ts';

const log = createLogger('tag-tree');

const TAG_SPARSE_THRESHOLD = 2;
const TAG_SIMILARITY_THRESHOLD = 0.3;

export interface TagTreeEngine {
  getTagTree: () => Promise<TagTreeNode[]>;
  placeTagInTree: (tag: string, bubbleId: string) => Promise<void>;
  rebalanceTagTree: () => Promise<{ merged: number; restructured: number }>;
  ensureDomainRoots: () => Promise<void>;
}

interface TagTreeDeps {
  neo4j: Neo4jClient;
  embeddingEngine: EmbeddingEngine;
  domainConfig: KnowledgeDomain[];
}

// eslint-disable-next-line max-lines-per-function -- factory function for tag tree engine
export function createTagTreeEngine(deps: TagTreeDeps): TagTreeEngine {
  const { neo4j, embeddingEngine, domainConfig } = deps;

  async function getTagTree(): Promise<TagTreeNode[]> {
    const rows = await neo4j.query<{
      name: string;
      parentName: string | null;
      level: number;
      domain: string | null;
    }>(
      `MATCH (t:Tag)
       OPTIONAL MATCH (t)-[:CHILD_OF]->(parent:Tag)
       RETURN t.name AS name, parent.name AS parentName,
              coalesce(t.level, 0) AS level, t.domain AS domain
       ORDER BY level ASC, name ASC`,
    );

    const nodeMap = new Map<string, TagTreeNode>();
    const roots: TagTreeNode[] = [];

    for (const row of rows) {
      nodeMap.set(row.name, {
        tag: row.name,
        parentTag: row.parentName,
        level: row.level,
        domain: row.domain,
        children: [],
      });
    }

    for (const node of nodeMap.values()) {
      const parent = node.parentTag ? nodeMap.get(node.parentTag) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- tag placement needs domain + embedding similarity checks
  async function placeTagInTree(tag: string, bubbleId: string): Promise<void> {
    // Check if tag already placed in tree (has level set)
    const existing = await neo4j.queryOne<{ name: string }>(
      `MATCH (t:Tag {name: $tag}) WHERE t.level IS NOT NULL RETURN t.name AS name`,
      { tag },
    );
    if (existing) return;

    // Check if tag matches a domain name → level 0
    const matchedDomain = domainConfig.find((d) => d.name === tag.toLowerCase());
    if (matchedDomain) {
      await neo4j.run(`MERGE (t:Tag {name: $tag}) SET t.level = 0, t.domain = $tag`, { tag });
      return;
    }

    // Check if tag content matches a domain rule
    const domainMatch = domainConfig.find((d) => d.rules.tags.includes(tag.toLowerCase()));
    if (domainMatch) {
      await neo4j.run(
        `MERGE (parent:Tag {name: $domainName})
         SET parent.level = coalesce(parent.level, 0), parent.domain = $domainName
         WITH parent
         MERGE (t:Tag {name: $tag})
         SET t.level = 1, t.domain = $domainName
         MERGE (t)-[:CHILD_OF]->(parent)`,
        { domainName: domainMatch.name, tag },
      );
      return;
    }

    // Find most similar existing tag by embedding similarity
    const bubbleEmbedding = await embeddingEngine.getEmbedding(bubbleId);
    if (!bubbleEmbedding) {
      // No embedding yet — place as orphan level 1
      await neo4j.run(`MERGE (t:Tag {name: $tag}) SET t.level = coalesce(t.level, 1)`, { tag });
      return;
    }

    // Find tags with similar bubbles
    const allTreeTags = await neo4j.query<{
      tagName: string;
      parentName: string | null;
      level: number;
      domain: string | null;
    }>(
      `MATCH (t:Tag) WHERE t.level IS NOT NULL
       OPTIONAL MATCH (t)-[:CHILD_OF]->(parent:Tag)
       RETURN t.name AS tagName, parent.name AS parentName,
              coalesce(t.level, 0) AS level, t.domain AS domain`,
    );

    let bestParent: string | null = null;
    let bestSim = -1;
    let bestLevel = 0;
    let bestDomain: string | null = null;

    for (const treeTag of allTreeTags) {
      const tagBubbles = await neo4j.query<{ bubbleId: string }>(
        `MATCH (b:Bubble)-[:HAS_TAG]->(t:Tag {name: $tag})
         WHERE b.embedding IS NOT NULL
         RETURN DISTINCT b.id AS bubbleId`,
        { tag: treeTag.tagName },
      );
      for (const tb of tagBubbles) {
        const tbEmb = await embeddingEngine.getEmbedding(tb.bubbleId);
        if (!tbEmb) continue;
        const sim = cosineSimilarity(bubbleEmbedding, tbEmb);
        if (sim > bestSim) {
          bestSim = sim;
          bestParent = treeTag.parentName ?? treeTag.tagName;
          bestLevel = treeTag.level + 1;
          bestDomain = treeTag.domain;
        }
      }
    }

    if (bestParent && bestSim > TAG_SIMILARITY_THRESHOLD) {
      await neo4j.run(
        `MERGE (t:Tag {name: $tag})
         SET t.level = $level, t.domain = $domain
         WITH t
         MATCH (parent:Tag {name: $parentName})
         MERGE (t)-[:CHILD_OF]->(parent)`,
        { tag, level: bestLevel, domain: bestDomain, parentName: bestParent },
      );
    } else {
      await neo4j.run(`MERGE (t:Tag {name: $tag}) SET t.level = coalesce(t.level, 1)`, { tag });
    }
  }

  async function rebalanceTagTree(): Promise<{ merged: number; restructured: number }> {
    let merged = 0;
    const restructured = 0;

    // Find sparse leaf tags (no children, few bubbles)
    const leafTags = await neo4j.query<{
      tagName: string;
      parentName: string | null;
      bubbleCount: number;
    }>(
      `MATCH (t:Tag) WHERE t.level IS NOT NULL
       AND NOT EXISTS { MATCH (:Tag)-[:CHILD_OF]->(t) }
       OPTIONAL MATCH (t)-[:CHILD_OF]->(parent:Tag)
       OPTIONAL MATCH (b:Bubble)-[:HAS_TAG]->(t)
       RETURN t.name AS tagName, parent.name AS parentName, count(DISTINCT b) AS bubbleCount`,
    );

    for (const leaf of leafTags) {
      if (leaf.bubbleCount < TAG_SPARSE_THRESHOLD && leaf.parentName) {
        // Retag bubbles from leaf to parent
        await neo4j.run(
          `MATCH (b:Bubble)-[:HAS_TAG]->(leaf:Tag {name: $leafTag})
           MATCH (parent:Tag {name: $parentTag})
           MERGE (b)-[:HAS_TAG]->(parent)`,
          { leafTag: leaf.tagName, parentTag: leaf.parentName },
        );
        // Remove old tag relationships and CHILD_OF
        await neo4j.run(`MATCH (:Bubble)-[r:HAS_TAG]->(t:Tag {name: $tag}) DELETE r`, {
          tag: leaf.tagName,
        });
        await neo4j.run(`MATCH (t:Tag {name: $tag})-[r:CHILD_OF]->() DELETE r`, {
          tag: leaf.tagName,
        });
        // Remove level/domain from orphaned tag
        await neo4j.run(`MATCH (t:Tag {name: $tag}) REMOVE t.level, t.domain`, {
          tag: leaf.tagName,
        });
        merged++;
      }
    }

    log.info(`Tag tree rebalanced: ${merged} merged, ${restructured} restructured`);
    return { merged, restructured };
  }

  async function ensureDomainRoots(): Promise<void> {
    for (const domain of domainConfig) {
      await neo4j.run(`MERGE (t:Tag {name: $name}) SET t.level = 0, t.domain = $name`, {
        name: domain.name,
      });
    }
  }

  return { getTagTree, placeTagInTree, rebalanceTagTree, ensureDomainRoots };
}
