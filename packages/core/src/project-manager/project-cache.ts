import type Database from 'better-sqlite3';
import {
  HTTP_STATUS,
  META_PROJECT_ID,
  type Project,
  type ProjectMetadata,
  type ProjectNode,
} from '@raven/shared';
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

/**
 * Project settings come from the current definition.  The cache contributes
 * operational timestamps only; absent metadata never inherits a stale SQL
 * setting.  Plain context.md files use their stable registry path as ID.
 */
type FileProjectSettings = Pick<
  Project,
  'id' | 'name' | 'description' | 'skills' | 'systemPrompt' | 'systemAccess'
>;

function valueOr<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return value;
}

function fileProjectSettings(node: ProjectNode): FileProjectSettings {
  if (node.isMeta) {
    const metadata = node.metadata;
    if (!metadata) {
      return {
        id: META_PROJECT_ID,
        name: 'Raven System',
        description: undefined,
        skills: [],
        systemPrompt: undefined,
        systemAccess: 'read-write',
      };
    }
    return {
      id: META_PROJECT_ID,
      name: valueOr(metadata.displayName, 'Raven System'),
      description: metadata.description,
      skills: valueOr(metadata.skills, []),
      systemPrompt: metadata.systemPrompt,
      systemAccess: valueOr(metadata.systemAccess, 'read-write'),
    };
  }

  const metadata = node.metadata;
  if (!metadata) {
    return {
      id: node.id,
      name: node.name,
      description: undefined,
      skills: [],
      systemPrompt: undefined,
      systemAccess: 'none',
    };
  }

  return {
    id: valueOr(metadata.id, node.id),
    name: valueOr(metadata.displayName, node.name),
    description: metadata.description,
    skills: valueOr(metadata.skills, []),
    systemPrompt: metadata.systemPrompt,
    systemAccess: valueOr(metadata.systemAccess, 'none'),
  };
}

function assertSystemDefinitionIdentity(node: ProjectNode): void {
  if (!node.isMeta) return;
  const id = node.metadata?.id;
  if (id !== undefined && id !== META_PROJECT_ID) {
    throw new ProjectMutationError(`System identity cannot belong to ${node.id}`);
  }
}

function assertMatchingIdentity(
  node: ProjectNode,
  settings: FileProjectSettings,
  existing?: Project,
): void {
  assertSystemDefinitionIdentity(node);
  if (existing && settings.id !== existing.id) {
    throw new ProjectMutationError(`Project identity conflicts at ${node.id}`);
  }
}

export function projectFromNode(node: ProjectNode, existing?: Project): Project {
  const now = Date.now();
  const settings = fileProjectSettings(node);
  assertMatchingIdentity(node, settings, existing);
  return {
    ...settings,
    fsPath: node.id,
    isMeta: node.isMeta,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

export function projectReferences(db: Database.Database, id: string): string[] {
  const tables = ['sessions', 'events', 'knowledge_rejections'];
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
