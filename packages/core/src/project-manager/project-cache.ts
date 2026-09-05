import type Database from 'better-sqlite3';
import { HTTP_STATUS, type Project, type ProjectMetadata, type ProjectNode } from '@raven/shared';
import { ProjectMutationError } from './project-mutation.ts';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  skills: string;
  system_prompt: string | null;
  system_access: Project['systemAccess'];
  is_meta: number;
  fs_path: string | null;
  created_at: number;
  updated_at: number;
}

export function parseProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    skills: JSON.parse(row.skills) as string[],
    systemPrompt: row.system_prompt ?? undefined,
    systemAccess: row.system_access ?? 'none',
    isMeta: row.is_meta === 1,
    fsPath: row.fs_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProjectRow(db: Database.Database, id: string): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw new ProjectMutationError('Project not found', HTTP_STATUS.NOT_FOUND);
  return row;
}

export function projectMetadata(project: Project): ProjectMetadata {
  return {
    version: 1,
    id: project.id,
    displayName: project.name,
    description: project.description,
    skills: project.skills,
    systemPrompt: project.systemPrompt,
    systemAccess: project.systemAccess ?? 'none',
  };
}

export function saveProjectRow(db: Database.Database, project: Project): void {
  db.prepare(
    `INSERT INTO projects
    (id, name, description, skills, system_prompt, system_access, is_meta, fs_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
    skills=excluded.skills, system_prompt=excluded.system_prompt, system_access=excluded.system_access,
    fs_path=excluded.fs_path, updated_at=excluded.updated_at`,
  ).run(
    project.id,
    project.name,
    project.description ?? null,
    JSON.stringify(project.skills),
    project.systemPrompt ?? null,
    project.systemAccess ?? 'none',
    project.isMeta ? 1 : 0,
    project.fsPath ?? null,
    project.createdAt,
    project.updatedAt,
  );
}

/** Merge only fields actually stored in the file; legacy inferred defaults have no authority. */
export function projectFromNode(node: ProjectNode, existing: Project): Project {
  const metadata = node.metadata;
  if (!metadata) return { ...existing, fsPath: node.id };
  if (metadata.id && metadata.id !== existing.id) {
    throw new ProjectMutationError(`Project identity conflicts at ${node.id}`);
  }
  return {
    ...existing,
    fsPath: node.id,
    name: metadata.displayName ?? existing.name,
    description: metadata.description ?? existing.description,
    skills: metadata.skills ?? existing.skills,
    systemPrompt: metadata.systemPrompt ?? existing.systemPrompt,
    systemAccess: metadata.systemAccess ?? existing.systemAccess,
  };
}

export function projectReferences(db: Database.Database, id: string): string[] {
  const tables = [
    'sessions',
    'agent_tasks',
    'tasks',
    'task_trees',
    'project_data_sources',
    'events',
    'knowledge_rejections',
  ];
  const references = tables.filter((table) =>
    db.prepare(`SELECT 1 FROM ${table} WHERE project_id = ? LIMIT 1`).get(id),
  );
  if (
    db.prepare("SELECT 1 FROM telegram_topics WHERE scope = 'project' AND key = ? LIMIT 1").get(id)
  ) {
    references.push('telegram_topics');
  }
  return references;
}
