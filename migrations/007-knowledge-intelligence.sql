-- Embeddings
CREATE TABLE knowledge_embeddings (
  bubble_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-small-en-v1.5',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permanence + domain support on knowledge_index
ALTER TABLE knowledge_index ADD COLUMN permanence TEXT NOT NULL DEFAULT 'normal';
CREATE INDEX idx_knowledge_permanence ON knowledge_index(permanence);

-- Multi-domain assignment (junction table)
CREATE TABLE knowledge_bubble_domains (
  bubble_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  PRIMARY KEY (bubble_id, domain)
);
CREATE INDEX idx_bubble_domains_domain ON knowledge_bubble_domains(domain);

-- Hierarchical tag tree
CREATE TABLE knowledge_tag_tree (
  tag TEXT PRIMARY KEY,
  parent_tag TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  domain TEXT
);
CREATE INDEX idx_tag_tree_parent ON knowledge_tag_tree(parent_tag);
CREATE INDEX idx_tag_tree_domain ON knowledge_tag_tree(domain);

-- Inter-bubble links
CREATE TABLE knowledge_links (
  id TEXT PRIMARY KEY,
  source_bubble_id TEXT NOT NULL,
  target_bubble_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'related',
  confidence REAL,
  auto_suggested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_bubble_id, target_bubble_id)
);
CREATE INDEX idx_knowledge_links_source ON knowledge_links(source_bubble_id);
CREATE INDEX idx_knowledge_links_target ON knowledge_links(target_bubble_id);
CREATE INDEX idx_knowledge_links_status ON knowledge_links(status);

-- Clusters
CREATE TABLE knowledge_clusters (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES knowledge_clusters(id) ON DELETE CASCADE,
  bubble_id TEXT NOT NULL,
  PRIMARY KEY (cluster_id, bubble_id)
);
CREATE INDEX idx_cluster_members_bubble ON knowledge_cluster_members(bubble_id);

-- Merge suggestions
CREATE TABLE knowledge_merge_suggestions (
  id TEXT PRIMARY KEY,
  bubble_id_1 TEXT NOT NULL,
  bubble_id_2 TEXT NOT NULL,
  overlap_reason TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_merge_suggestions_status ON knowledge_merge_suggestions(status);
