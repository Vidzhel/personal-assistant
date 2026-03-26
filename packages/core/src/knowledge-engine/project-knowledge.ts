import { createLogger } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { ProjectKnowledgeLink } from '@raven/shared';
import { getDb } from '../db/database.ts';

const log = createLogger('project-knowledge');

/**
 * Sync project nodes from SQLite to Neo4j.
 * Uses MERGE to create/update lightweight Project nodes (id, name).
 * Called at boot and when projects are created/updated.
 */
export async function syncProjectNodes(neo4j: Neo4jClient): Promise<void> {
  const db = getDb();
  const projects = db.prepare('SELECT id, name FROM projects').all() as Array<{
    id: string;
    name: string;
  }>;

  for (const project of projects) {
    try {
      await neo4j.run(`MERGE (p:Project {id: $id}) SET p.name = $name`, {
        id: project.id,
        name: project.name,
      });
    } catch (err) {
      log.warn(`Failed to sync project node ${project.id}: ${err}`);
    }
  }

  log.info(`Synced ${projects.length} project nodes to Neo4j`);
}

interface LinkBubbleInput {
  neo4j: Neo4jClient;
  projectId: string;
  bubbleId: string;
  linkedBy?: string;
}

export async function linkBubbleToProject(input: LinkBubbleInput): Promise<ProjectKnowledgeLink> {
  const now = new Date().toISOString();
  await input.neo4j.run(
    `MATCH (b:Bubble {id: $bubbleId})
     MERGE (p:Project {id: $projectId})
     MERGE (b)-[r:BELONGS_TO_PROJECT]->(p)
     SET r.linkedBy = $linkedBy, r.createdAt = $createdAt`,
    {
      bubbleId: input.bubbleId,
      projectId: input.projectId,
      linkedBy: input.linkedBy ?? null,
      createdAt: now,
    },
  );
  return {
    projectId: input.projectId,
    bubbleId: input.bubbleId,
    linkedBy: input.linkedBy,
    createdAt: now,
  };
}

export async function unlinkBubbleFromProject(
  neo4j: Neo4jClient,
  projectId: string,
  bubbleId: string,
): Promise<void> {
  await neo4j.run(
    `MATCH (b:Bubble {id: $bubbleId})-[r:BELONGS_TO_PROJECT]->(p:Project {id: $projectId})
     DELETE r`,
    { bubbleId, projectId },
  );
}

interface LinkedBubbleRow {
  bubbleId: string;
  title: string;
  contentPreview: string;
  tags: string[];
  source: string;
  linkedBy: string | null;
  createdAt: string;
}

export async function getProjectKnowledgeLinks(
  neo4j: Neo4jClient,
  projectId: string,
): Promise<LinkedBubbleRow[]> {
  return neo4j.query<LinkedBubbleRow>(
    `MATCH (b:Bubble)-[r:BELONGS_TO_PROJECT]->(p:Project {id: $projectId})
     RETURN b.id AS bubbleId, b.title AS title, b.contentPreview AS contentPreview,
            b.tags AS tags, b.source AS source, r.linkedBy AS linkedBy, r.createdAt AS createdAt
     ORDER BY r.createdAt DESC`,
    { projectId },
  );
}

export async function getProjectsForBubble(
  neo4j: Neo4jClient,
  bubbleId: string,
): Promise<string[]> {
  const rows = await neo4j.query<{ projectId: string }>(
    `MATCH (b:Bubble {id: $bubbleId})-[:BELONGS_TO_PROJECT]->(p:Project)
     RETURN p.id AS projectId`,
    { bubbleId },
  );
  return rows.map((r) => r.projectId);
}
