import crypto from 'node:crypto';
import type { ProjectDataSource, CreateDataSourceInput } from '@raven/shared';
import { getDb } from '../db/database.ts';

interface DataSourceRow {
  id: string;
  project_id: string;
  uri: string;
  label: string;
  description: string | null;
  source_type: string;
  created_at: string;
  updated_at: string;
}

function rowToDataSource(row: DataSourceRow): ProjectDataSource {
  return {
    id: row.id,
    projectId: row.project_id,
    uri: row.uri,
    label: row.label,
    description: row.description ?? undefined,
    sourceType: row.source_type as ProjectDataSource['sourceType'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDataSource(
  projectId: string,
  input: CreateDataSourceInput,
): ProjectDataSource {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO project_data_sources (id, project_id, uri, label, description, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.uri,
    input.label,
    input.description ?? null,
    input.sourceType,
    now,
    now,
  );

  return {
    id,
    projectId,
    uri: input.uri,
    label: input.label,
    description: input.description,
    sourceType: input.sourceType,
    createdAt: now,
    updatedAt: now,
  };
}

export function getDataSources(projectId: string): ProjectDataSource[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM project_data_sources WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as DataSourceRow[];
  return rows.map(rowToDataSource);
}

export function getDataSource(id: string): ProjectDataSource | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM project_data_sources WHERE id = ?').get(id) as
    | DataSourceRow
    | undefined;
  return row ? rowToDataSource(row) : undefined;
}

export function updateDataSource(id: string, input: Partial<CreateDataSourceInput>): void {
  const db = getDb();
  const now = new Date().toISOString();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (input.uri !== undefined) {
    fields.push('uri = ?');
    values.push(input.uri);
  }
  if (input.label !== undefined) {
    fields.push('label = ?');
    values.push(input.label);
  }
  if (input.description !== undefined) {
    fields.push('description = ?');
    values.push(input.description);
  }
  if (input.sourceType !== undefined) {
    fields.push('source_type = ?');
    values.push(input.sourceType);
  }

  values.push(id);
  db.prepare(`UPDATE project_data_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteDataSource(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM project_data_sources WHERE id = ?').run(id);
}

export function buildProjectDataSourcesContext(projectId: string): string | undefined {
  const sources = getDataSources(projectId);
  if (sources.length === 0) return undefined;

  const lines = sources.map((s) => {
    let line = `- **${s.label}** (${s.sourceType}): ${s.uri}`;
    if (s.description) {
      line += `\n  ${s.description}`;
    }
    return line;
  });

  return lines.join('\n');
}
