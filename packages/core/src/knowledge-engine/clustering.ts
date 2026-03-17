import {
  generateId,
  createLogger,
  type DatabaseInterface,
  type RavenEvent,
  type KnowledgeDomain,
  type KnowledgeLink,
  type KnowledgeCluster,
  type KnowledgeMergeSuggestion,
  type TagTreeNode,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import { cosineSimilarity } from './embeddings.ts';

const log = createLogger('clustering');

const LINK_SIMILARITY_THRESHOLD = 0.7;
const MERGE_SIMILARITY_THRESHOLD = 0.9;
const CLUSTER_SIMILARITY_THRESHOLD = 0.6;
const HUB_LINK_THRESHOLD = 10;
const HUB_SPLIT_GROUP_THRESHOLD = 0.5;
const TAG_SPARSE_THRESHOLD = 2;
const TOP_K_SIMILAR = 5;
const TOP_K_LINK_SUGGESTIONS = 5;
const TAG_SIMILARITY_THRESHOLD = 0.3;
const SYNTH_LINK_CONFIDENCE = 0.8;
const COSINE_PRECISION = 3;

interface TagRow {
  tag: string;
}

interface TagTreeRow {
  tag: string;
  parent_tag: string | null;
  level: number;
  domain: string | null;
}

interface LinkRow {
  id: string;
  source_bubble_id: string;
  target_bubble_id: string;
  relationship_type: string;
  confidence: number | null;
  auto_suggested: number;
  status: string;
  created_at: string;
}

interface ClusterRow {
  id: string;
  label: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface ClusterCountRow extends ClusterRow {
  member_count: number;
}

interface MergeRow {
  id: string;
  bubble_id_1: string;
  bubble_id_2: string;
  overlap_reason: string | null;
  confidence: number | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface BubbleCountRow {
  bubble_id: string;
  link_count: number;
}

interface DomainCountRow {
  domain: string;
  count: number;
}

export interface ClusteringEngine {
  classifyDomains: (bubble: {
    id: string;
    tags: string[];
    title: string;
    content: string;
  }) => string[];
  assignDomains: (bubbleId: string, domains: string[]) => void;
  getDomains: () => Array<{ name: string; bubbleCount: number }>;
  getTagTree: () => TagTreeNode[];
  placeTagInTree: (tag: string, bubbleId: string) => void;
  rebalanceTagTree: () => { merged: number; restructured: number };
  suggestLinks: (bubbleId: string) => KnowledgeLink[];
  getLinksForBubble: (bubbleId: string) => KnowledgeLink[];
  createLink: (link: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
  }) => KnowledgeLink;
  resolveLink: (linkId: string, action: 'accept' | 'dismiss') => boolean;
  detectHubs: () => Array<{ bubbleId: string; linkCount: number }>;
  splitHub: (hubBubbleId: string) => Promise<void>;
  runClustering: () => Promise<{ clusterCount: number; clusteredBubbles: number }>;
  getClusters: () => KnowledgeCluster[];
  getClusterMembers: (clusterId: string) => string[];
  deleteCluster: (clusterId: string) => boolean;
  detectMerges: () => { mergeCount: number };
  getMergeSuggestions: (status?: string) => KnowledgeMergeSuggestion[];
  resolveMerge: (mergeId: string, resolution: 'accept' | 'dismiss') => boolean;
  suggestTags: (
    bubbleId: string,
  ) => Array<{ tag: string; confidence: number; parentTag: string | null }>;
  start: () => void;
}

interface ClusteringDeps {
  db: DatabaseInterface;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  domainConfig: KnowledgeDomain[];
}

function linkRowToLink(row: LinkRow): KnowledgeLink {
  return {
    id: row.id,
    sourceBubbleId: row.source_bubble_id,
    targetBubbleId: row.target_bubble_id,
    relationshipType: row.relationship_type,
    confidence: row.confidence,
    autoSuggested: row.auto_suggested === 1,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mergeRowToSuggestion(row: MergeRow): KnowledgeMergeSuggestion {
  return {
    id: row.id,
    bubbleId1: row.bubble_id_1,
    bubbleId2: row.bubble_id_2,
    overlapReason: row.overlap_reason,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// eslint-disable-next-line max-lines-per-function -- factory function for clustering engine
export function createClusteringEngine(deps: ClusteringDeps): ClusteringEngine {
  const { db, eventBus, embeddingEngine, domainConfig } = deps;

  // --- Domain classification ---
  function classifyDomains(bubble: {
    id: string;
    tags: string[];
    title: string;
    content: string;
  }): string[] {
    const matched: string[] = [];
    const lowerContent = (bubble.title + ' ' + bubble.content).toLowerCase();

    for (const domain of domainConfig) {
      const tagMatch = bubble.tags.some((t) => domain.rules.tags.includes(t.toLowerCase()));
      const keywordMatch = domain.rules.keywords.some((kw) =>
        lowerContent.includes(kw.toLowerCase()),
      );
      if (tagMatch || keywordMatch) {
        matched.push(domain.name);
      }
    }
    return matched;
  }

  function assignDomains(bubbleId: string, domains: string[]): void {
    db.run('DELETE FROM knowledge_bubble_domains WHERE bubble_id = ?', bubbleId);
    for (const domain of domains) {
      db.run(
        'INSERT OR IGNORE INTO knowledge_bubble_domains (bubble_id, domain) VALUES (?, ?)',
        bubbleId,
        domain,
      );
    }
  }

  function getDomains(): Array<{ name: string; bubbleCount: number }> {
    const rows = db.all<DomainCountRow>(
      'SELECT domain, COUNT(*) as count FROM knowledge_bubble_domains GROUP BY domain ORDER BY count DESC',
    );
    return domainConfig.map((d) => ({
      name: d.name,
      bubbleCount: rows.find((r) => r.domain === d.name)?.count ?? 0,
    }));
  }

  // --- Hierarchical tag tree ---
  function getTagTree(): TagTreeNode[] {
    const rows = db.all<TagTreeRow>('SELECT * FROM knowledge_tag_tree ORDER BY level ASC, tag ASC');
    const nodeMap = new Map<string, TagTreeNode>();
    const roots: TagTreeNode[] = [];

    for (const row of rows) {
      const node: TagTreeNode = {
        tag: row.tag,
        parentTag: row.parent_tag,
        level: row.level,
        domain: row.domain,
        children: [],
      };
      nodeMap.set(row.tag, node);
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
  function placeTagInTree(tag: string, bubbleId: string): void {
    const existing = db.get<TagTreeRow>('SELECT * FROM knowledge_tag_tree WHERE tag = ?', tag);
    if (existing) return; // already in tree

    // Check if tag matches a domain name → level 0
    const matchedDomain = domainConfig.find((d) => d.name === tag.toLowerCase());
    if (matchedDomain) {
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, NULL, 0, ?)',
        tag,
        tag,
      );
      return;
    }

    // Check if tag content matches a domain before trying embedding similarity
    const domainMatch = domainConfig.find((d) => d.rules.tags.includes(tag.toLowerCase()));
    if (domainMatch) {
      // Ensure domain is in tree
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, NULL, 0, ?)',
        domainMatch.name,
        domainMatch.name,
      );
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, ?, 1, ?)',
        tag,
        domainMatch.name,
        domainMatch.name,
      );
      return;
    }

    // Find most similar existing tag by embedding of associated bubbles
    const bubbleEmbedding = embeddingEngine.getEmbedding(bubbleId);
    if (!bubbleEmbedding) {
      // No embedding yet — place as orphan
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, NULL, 1, NULL)',
        tag,
      );
      return;
    }

    // Find tags with similar bubbles
    const allTreeTags = db.all<TagTreeRow>('SELECT * FROM knowledge_tag_tree');
    let bestParent: string | null = null;
    let bestSim = -1;
    let bestLevel = 0;
    let bestDomain: string | null = null;

    for (const treeTag of allTreeTags) {
      // Get bubbles with this tag
      const tagBubbles = db.all<TagRow>(
        'SELECT DISTINCT bubble_id as tag FROM knowledge_tags WHERE tag = ?',
        treeTag.tag,
      );
      for (const tb of tagBubbles) {
        const tbEmb = embeddingEngine.getEmbedding(tb.tag);
        if (!tbEmb) continue;
        const sim = cosineSimilarity(bubbleEmbedding, tbEmb);
        if (sim > bestSim) {
          bestSim = sim;
          bestParent = treeTag.parent_tag ?? treeTag.tag;
          bestLevel = treeTag.level + 1;
          bestDomain = treeTag.domain;
        }
      }
    }

    if (bestParent && bestSim > TAG_SIMILARITY_THRESHOLD) {
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, ?, ?, ?)',
        tag,
        bestParent,
        bestLevel,
        bestDomain,
      );
    } else {
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, NULL, 1, NULL)',
        tag,
      );
    }
  }

  function rebalanceTagTree(): { merged: number; restructured: number } {
    let merged = 0;
    const restructured = 0;

    // Find sparse leaf tags
    const leafTags = db.all<TagTreeRow>(
      `SELECT tt.* FROM knowledge_tag_tree tt
       WHERE NOT EXISTS (SELECT 1 FROM knowledge_tag_tree c WHERE c.parent_tag = tt.tag)`,
    );

    for (const leaf of leafTags) {
      const bubbleCount = db.all<TagRow>(
        'SELECT DISTINCT bubble_id as tag FROM knowledge_tags WHERE tag = ?',
        leaf.tag,
      ).length;

      if (bubbleCount < TAG_SPARSE_THRESHOLD && leaf.parent_tag) {
        // Merge into parent: retag bubbles
        const bubbles = db.all<{ bubble_id: string }>(
          'SELECT bubble_id FROM knowledge_tags WHERE tag = ?',
          leaf.tag,
        );
        for (const b of bubbles) {
          db.run(
            'INSERT OR IGNORE INTO knowledge_tags (bubble_id, tag) VALUES (?, ?)',
            b.bubble_id,
            leaf.parent_tag,
          );
        }
        db.run('DELETE FROM knowledge_tags WHERE tag = ?', leaf.tag);
        db.run('DELETE FROM knowledge_tag_tree WHERE tag = ?', leaf.tag);
        merged++;
      }
    }

    log.info(`Tag tree rebalanced: ${merged} merged, ${restructured} restructured`);
    return { merged, restructured };
  }

  // --- Inter-bubble linking ---
  function suggestLinks(bubbleId: string): KnowledgeLink[] {
    const embedding = embeddingEngine.getEmbedding(bubbleId);
    if (!embedding) return [];

    const similar = embeddingEngine.findSimilar(embedding, {
      limit: TOP_K_LINK_SUGGESTIONS,
      threshold: LINK_SIMILARITY_THRESHOLD,
      excludeIds: [bubbleId],
    });

    const links: KnowledgeLink[] = [];
    for (const s of similar) {
      // Check if link already exists
      const existing = db.get<LinkRow>(
        `SELECT * FROM knowledge_links WHERE
         (source_bubble_id = ? AND target_bubble_id = ?) OR
         (source_bubble_id = ? AND target_bubble_id = ?)`,
        bubbleId,
        s.bubbleId,
        s.bubbleId,
        bubbleId,
      );
      if (existing) continue;

      const link = createLinkInternal({
        sourceBubbleId: bubbleId,
        targetBubbleId: s.bubbleId,
        relationshipType: 'related',
        confidence: s.similarity,
        autoSuggested: true,
        status: 'suggested',
      });
      links.push(link);
    }
    return links;
  }

  function createLinkInternal(params: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
    autoSuggested: boolean;
    status: string;
  }): KnowledgeLink {
    const id = generateId();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO knowledge_links (id, source_bubble_id, target_bubble_id, relationship_type, confidence, auto_suggested, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.sourceBubbleId,
      params.targetBubbleId,
      params.relationshipType,
      params.confidence ?? null,
      params.autoSuggested ? 1 : 0,
      params.status,
      now,
    );
    return {
      id,
      sourceBubbleId: params.sourceBubbleId,
      targetBubbleId: params.targetBubbleId,
      relationshipType: params.relationshipType,
      confidence: params.confidence ?? null,
      autoSuggested: params.autoSuggested,
      status: params.status,
      createdAt: now,
    };
  }

  function createLink(params: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
  }): KnowledgeLink {
    return createLinkInternal({
      ...params,
      autoSuggested: false,
      status: 'accepted',
    });
  }

  function getLinksForBubble(bubbleId: string): KnowledgeLink[] {
    const rows = db.all<LinkRow>(
      `SELECT * FROM knowledge_links WHERE source_bubble_id = ? OR target_bubble_id = ?`,
      bubbleId,
      bubbleId,
    );
    return rows.map(linkRowToLink);
  }

  function resolveLink(linkId: string, action: 'accept' | 'dismiss'): boolean {
    const newStatus = action === 'accept' ? 'accepted' : 'dismissed';
    const row = db.get<LinkRow>('SELECT * FROM knowledge_links WHERE id = ?', linkId);
    if (!row) return false;
    db.run('UPDATE knowledge_links SET status = ? WHERE id = ?', newStatus, linkId);
    return true;
  }

  // --- Hub detection and splitting ---
  function detectHubs(): Array<{ bubbleId: string; linkCount: number }> {
    const rows = db.all<BubbleCountRow>(
      `SELECT source_bubble_id as bubble_id, COUNT(*) as link_count FROM (
         SELECT source_bubble_id FROM knowledge_links WHERE status = 'accepted'
         UNION ALL
         SELECT target_bubble_id FROM knowledge_links WHERE status = 'accepted'
       ) GROUP BY bubble_id HAVING link_count >= ?`,
      HUB_LINK_THRESHOLD,
    );
    return rows.map((r) => ({ bubbleId: r.bubble_id, linkCount: r.link_count }));
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- hub splitting is an inherently complex multi-step operation
  async function splitHub(hubBubbleId: string): Promise<void> {
    const links = getLinksForBubble(hubBubbleId).filter((l) => l.status === 'accepted');
    const linkedIds = new Set<string>();
    for (const link of links) {
      if (link.sourceBubbleId !== hubBubbleId) linkedIds.add(link.sourceBubbleId);
      if (link.targetBubbleId !== hubBubbleId) linkedIds.add(link.targetBubbleId);
    }

    if (linkedIds.size < HUB_LINK_THRESHOLD) return;

    // Cluster linked bubbles by embedding similarity
    const bubbleEmbeddings: Array<{ id: string; embedding: Float32Array }> = [];
    for (const id of linkedIds) {
      const emb = embeddingEngine.getEmbedding(id);
      if (emb) bubbleEmbeddings.push({ id, embedding: emb });
    }

    const groups = agglomerativeCluster(bubbleEmbeddings, HUB_SPLIT_GROUP_THRESHOLD);

    for (const group of groups) {
      if (group.length < 2) continue;

      // Create synthesis bubble via agent task request
      const synthId = generateId();

      // Collect tags from group members
      const groupTags = new Set<string>();
      for (const memberId of group) {
        const tags = db
          .all<TagRow>('SELECT tag FROM knowledge_tags WHERE bubble_id = ?', memberId)
          .map((r) => r.tag);
        for (const t of tags) groupTags.add(t);
      }

      // Request LLM for synthesis content via agent task
      const taskId = generateId();
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'agent:task:request',
        payload: {
          taskId,
          prompt: `Generate a brief synthesis title and summary for a knowledge hub group. The hub bubble ID is ${hubBubbleId}. Group member IDs: ${group.join(', ')}. Tags: ${[...groupTags].join(', ')}. Return JSON: {"title": "...", "summary": "..."}`,
          skillName: 'knowledge-synthesis',
          mcpServers: {},
          priority: 'low',
        },
      } as RavenEvent);

      // Create synthesis link entries (don't wait for LLM)
      createLinkInternal({
        sourceBubbleId: synthId,
        targetBubbleId: hubBubbleId,
        relationshipType: 'derived-from',
        confidence: 1.0,
        autoSuggested: true,
        status: 'accepted',
      });

      for (const memberId of group) {
        // Link member to synthesis
        createLinkInternal({
          sourceBubbleId: memberId,
          targetBubbleId: synthId,
          relationshipType: 'related',
          confidence: SYNTH_LINK_CONFIDENCE,
          autoSuggested: true,
          status: 'accepted',
        });
        // Remove old direct link from hub to member
        db.run(
          `DELETE FROM knowledge_links WHERE
           (source_bubble_id = ? AND target_bubble_id = ?) OR
           (source_bubble_id = ? AND target_bubble_id = ?)`,
          hubBubbleId,
          memberId,
          memberId,
          hubBubbleId,
        );
      }

      log.info(
        `Hub split: created synthesis ${synthId} for ${group.length} members from hub ${hubBubbleId}`,
      );
    }
  }

  // --- Clustering ---
  // eslint-disable-next-line max-lines-per-function -- clustering pipeline with DB + LLM steps
  async function runClustering(): Promise<{
    clusterCount: number;
    clusteredBubbles: number;
  }> {
    const allEmbeddings = embeddingEngine.getAllEmbeddings();
    if (allEmbeddings.length === 0) return { clusterCount: 0, clusteredBubbles: 0 };

    const groups = agglomerativeCluster(
      allEmbeddings.map((e) => ({ id: e.bubbleId, embedding: e.embedding })),
      CLUSTER_SIMILARITY_THRESHOLD,
    );

    // Clear existing clusters (idempotent)
    db.run('DELETE FROM knowledge_cluster_members');
    db.run('DELETE FROM knowledge_clusters');

    let clusteredBubbles = 0;
    const now = new Date().toISOString();

    for (const group of groups) {
      if (group.length < 2) continue;

      const clusterId = generateId();
      const label = `Cluster (${group.length} items)`;

      db.run(
        'INSERT INTO knowledge_clusters (id, label, description, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
        clusterId,
        label,
        now,
        now,
      );

      for (const bubbleId of group) {
        db.run(
          'INSERT INTO knowledge_cluster_members (cluster_id, bubble_id) VALUES (?, ?)',
          clusterId,
          bubbleId,
        );
      }
      clusteredBubbles += group.length;

      // Request LLM for cluster label
      const taskId = generateId();
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'agent:task:request',
        payload: {
          taskId,
          prompt: `Generate a concise label for a knowledge cluster containing ${group.length} items. Bubble IDs: ${group.join(', ')}. Return JSON: {"label": "...", "description": "..."}`,
          skillName: 'knowledge-clustering',
          mcpServers: {},
          priority: 'low',
        },
      } as RavenEvent);
    }

    const clusterCount = groups.filter((g) => g.length >= 2).length;
    log.info(`Clustering complete: ${clusterCount} clusters, ${clusteredBubbles} bubbles`);
    return { clusterCount, clusteredBubbles };
  }

  function getClusters(): KnowledgeCluster[] {
    const rows = db.all<ClusterCountRow>(
      `SELECT c.*, COUNT(m.bubble_id) as member_count
       FROM knowledge_clusters c
       LEFT JOIN knowledge_cluster_members m ON c.id = m.cluster_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      description: r.description,
      memberCount: r.member_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  function getClusterMembers(clusterId: string): string[] {
    return db
      .all<{
        bubble_id: string;
      }>('SELECT bubble_id FROM knowledge_cluster_members WHERE cluster_id = ?', clusterId)
      .map((r) => r.bubble_id);
  }

  function deleteCluster(clusterId: string): boolean {
    const existing = db.get<ClusterRow>('SELECT * FROM knowledge_clusters WHERE id = ?', clusterId);
    if (!existing) return false;
    db.run('DELETE FROM knowledge_clusters WHERE id = ?', clusterId);
    return true;
  }

  // --- Merge detection ---
  function detectMerges(): { mergeCount: number } {
    const allEmbeddings = embeddingEngine.getAllEmbeddings();
    let mergeCount = 0;

    for (let i = 0; i < allEmbeddings.length; i++) {
      for (let j = i + 1; j < allEmbeddings.length; j++) {
        const sim = cosineSimilarity(allEmbeddings[i].embedding, allEmbeddings[j].embedding);
        if (sim > MERGE_SIMILARITY_THRESHOLD) {
          // Check if already suggested
          const existing = db.get<MergeRow>(
            `SELECT * FROM knowledge_merge_suggestions WHERE
             (bubble_id_1 = ? AND bubble_id_2 = ?) OR (bubble_id_1 = ? AND bubble_id_2 = ?)`,
            allEmbeddings[i].bubbleId,
            allEmbeddings[j].bubbleId,
            allEmbeddings[j].bubbleId,
            allEmbeddings[i].bubbleId,
          );
          if (existing) continue;

          const id = generateId();
          db.run(
            `INSERT INTO knowledge_merge_suggestions (id, bubble_id_1, bubble_id_2, overlap_reason, confidence, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
            id,
            allEmbeddings[i].bubbleId,
            allEmbeddings[j].bubbleId,
            `Cosine similarity: ${sim.toFixed(COSINE_PRECISION)}`,
            sim,
          );
          mergeCount++;
        }
      }
    }

    if (mergeCount > 0) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'knowledge:merge:detected',
        payload: { mergeCount },
      } as RavenEvent);
    }

    log.info(`Merge detection: ${mergeCount} new suggestions`);
    return { mergeCount };
  }

  function getMergeSuggestions(status?: string): KnowledgeMergeSuggestion[] {
    const sql = status
      ? 'SELECT * FROM knowledge_merge_suggestions WHERE status = ? ORDER BY confidence DESC'
      : 'SELECT * FROM knowledge_merge_suggestions ORDER BY confidence DESC';
    const rows = status ? db.all<MergeRow>(sql, status) : db.all<MergeRow>(sql);
    return rows.map(mergeRowToSuggestion);
  }

  function resolveMerge(mergeId: string, resolution: 'accept' | 'dismiss'): boolean {
    const row = db.get<MergeRow>('SELECT * FROM knowledge_merge_suggestions WHERE id = ?', mergeId);
    if (!row) return false;
    const newStatus = resolution === 'accept' ? 'accepted' : 'dismissed';
    db.run(
      "UPDATE knowledge_merge_suggestions SET status = ?, resolved_at = datetime('now') WHERE id = ?",
      newStatus,
      mergeId,
    );
    return true;
  }

  // --- Auto-tag suggestions ---
  function suggestTags(
    bubbleId: string,
  ): Array<{ tag: string; confidence: number; parentTag: string | null }> {
    const embedding = embeddingEngine.getEmbedding(bubbleId);
    if (!embedding) return [];

    const similar = embeddingEngine.findSimilar(embedding, {
      limit: TOP_K_SIMILAR,
      threshold: TAG_SIMILARITY_THRESHOLD,
      excludeIds: [bubbleId],
    });

    // Collect tags from similar bubbles, weighted by similarity
    const tagScores = new Map<string, number>();
    for (const s of similar) {
      const tags = db
        .all<TagRow>('SELECT tag FROM knowledge_tags WHERE bubble_id = ?', s.bubbleId)
        .map((r) => r.tag);
      for (const tag of tags) {
        tagScores.set(tag, (tagScores.get(tag) ?? 0) + s.similarity);
      }
    }

    // Exclude tags the bubble already has
    const existingTags = new Set(
      db
        .all<TagRow>('SELECT tag FROM knowledge_tags WHERE bubble_id = ?', bubbleId)
        .map((r) => r.tag),
    );

    const suggestions: Array<{
      tag: string;
      confidence: number;
      parentTag: string | null;
    }> = [];

    for (const [tag, score] of tagScores.entries()) {
      if (existingTags.has(tag)) continue;
      const treeEntry = db.get<TagTreeRow>('SELECT * FROM knowledge_tag_tree WHERE tag = ?', tag);
      suggestions.push({
        tag,
        confidence: Math.min(score / similar.length, 1),
        parentTag: treeEntry?.parent_tag ?? null,
      });
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions.slice(0, TOP_K_SIMILAR);
  }

  // --- Event-driven processing chain ---
  // eslint-disable-next-line max-lines-per-function -- event chain processing runs multiple operations sequentially
  function handleEmbeddingGenerated(event: RavenEvent): void {
    if (event.type !== 'knowledge:embedding:generated') return;
    const { bubbleId } = event.payload;

    try {
      // Get bubble info for domain classification
      const indexRow = db.get<{
        id: string;
        title: string;
        content_preview: string | null;
      }>('SELECT id, title, content_preview FROM knowledge_index WHERE id = ?', bubbleId);
      if (!indexRow) return;

      const tags = db
        .all<TagRow>('SELECT tag FROM knowledge_tags WHERE bubble_id = ?', bubbleId)
        .map((r) => r.tag);

      // Classify domains
      const domains = classifyDomains({
        id: bubbleId,
        tags,
        title: indexRow.title,
        content: indexRow.content_preview ?? '',
      });
      assignDomains(bubbleId, domains);

      // Place tags in tree
      for (const tag of tags) {
        placeTagInTree(tag, bubbleId);
      }

      // Suggest links
      const linkSuggestions = suggestLinks(bubbleId);
      if (linkSuggestions.length > 0) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:links:suggested',
          payload: {
            bubbleId,
            links: linkSuggestions.map((l) => ({
              targetBubbleId: l.sourceBubbleId === bubbleId ? l.targetBubbleId : l.sourceBubbleId,
              confidence: l.confidence ?? 0,
              relationshipType: l.relationshipType,
            })),
          },
        } as RavenEvent);
      }

      // Suggest tags
      const tagSuggestions = suggestTags(bubbleId);
      if (tagSuggestions.length > 0) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:tags:suggested',
          payload: { bubbleId, suggestedTags: tagSuggestions },
        } as RavenEvent);
      }

      // Check hub status
      const hubLinks = getLinksForBubble(bubbleId).filter((l) => l.status === 'accepted');
      if (hubLinks.length >= HUB_LINK_THRESHOLD) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:hub:detected',
          payload: { bubbleId, linkCount: hubLinks.length },
        } as RavenEvent);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Error processing embedding for bubble ${bubbleId}: ${msg}`);
    }
  }

  function start(): void {
    eventBus.on('knowledge:embedding:generated', handleEmbeddingGenerated);
    // Ensure domain tags are level-0 entries
    for (const domain of domainConfig) {
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, NULL, 0, ?)',
        domain.name,
        domain.name,
      );
    }
    log.info('Clustering engine started — listening for knowledge:embedding:generated events');
  }

  return {
    classifyDomains,
    assignDomains,
    getDomains,
    getTagTree,
    placeTagInTree,
    rebalanceTagTree,
    suggestLinks,
    getLinksForBubble,
    createLink,
    resolveLink,
    detectHubs,
    splitHub,
    runClustering,
    getClusters,
    getClusterMembers,
    deleteCluster,
    detectMerges,
    getMergeSuggestions,
    resolveMerge,
    suggestTags,
    start,
  };
}

// --- Agglomerative clustering utility ---
// eslint-disable-next-line max-lines-per-function, complexity -- clustering algorithm needs the full loop
function agglomerativeCluster(
  items: Array<{ id: string; embedding: Float32Array }>,
  threshold: number,
): string[][] {
  if (items.length === 0) return [];

  // Single-link agglomerative clustering
  const clusters: Map<number, string[]> = new Map();
  const clusterCentroids: Map<number, Float32Array> = new Map();

  // Initialize: each item is its own cluster
  for (let i = 0; i < items.length; i++) {
    clusters.set(i, [items[i].id]);
    clusterCentroids.set(i, items[i].embedding);
  }

  let nextId = items.length;

  while (true) {
    const clusterIds = [...clusters.keys()];
    if (clusterIds.length <= 1) break;

    let bestI = -1;
    let bestJ = -1;
    let bestSim = -1;

    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const centA = clusterCentroids.get(clusterIds[i]);
        const centB = clusterCentroids.get(clusterIds[j]);
        if (!centA || !centB) continue;
        const sim = cosineSimilarity(centA, centB);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim < threshold) break;

    // Merge clusters
    const membersA = clusters.get(clusterIds[bestI]) ?? [];
    const membersB = clusters.get(clusterIds[bestJ]) ?? [];
    const mergedMembers = [...membersA, ...membersB];
    const centA = clusterCentroids.get(clusterIds[bestI]);
    const centB = clusterCentroids.get(clusterIds[bestJ]);
    if (!centA || !centB) break;
    const newCentroid = new Float32Array(centA.length);
    for (let k = 0; k < centA.length; k++) {
      newCentroid[k] = (centA[k] + centB[k]) / 2;
    }

    clusters.delete(clusterIds[bestI]);
    clusters.delete(clusterIds[bestJ]);
    clusterCentroids.delete(clusterIds[bestI]);
    clusterCentroids.delete(clusterIds[bestJ]);

    clusters.set(nextId, mergedMembers);
    clusterCentroids.set(nextId, newCentroid);
    nextId++;
  }

  return [...clusters.values()];
}
