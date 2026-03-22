import { META_PROJECT_ID, type Project } from '@raven/shared';
import { getDb } from '../db/database.ts';

export { META_PROJECT_ID };

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  skills: string;
  system_prompt: string | null;
  system_access: string;
  is_meta: number;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    skills: JSON.parse(row.skills) as string[],
    systemPrompt: row.system_prompt ?? undefined,
    systemAccess: row.system_access as Project['systemAccess'],
    isMeta: row.is_meta === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMetaProject(): Project {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE is_meta = 1').get() as
    | ProjectRow
    | undefined;
  if (!row) {
    throw new Error('Meta-project not found in database — migration 017 may not have run');
  }
  return rowToProject(row);
}

export function isMetaProject(projectId: string): boolean {
  return projectId === META_PROJECT_ID;
}
