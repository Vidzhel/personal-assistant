import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  createLogger,
  generateId,
  type DatabaseInterface,
  type EventBusInterface,
  type NamedAgent,
  type NamedAgentCreateInput,
  type NamedAgentUpdateInput,
} from '@raven/shared';

const log = createLogger('named-agent-store');

interface NamedAgentRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  suite_ids: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function safeParseSuiteIds(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function rowToAgent(row: NamedAgentRow): NamedAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    suiteIds: safeParseSuiteIds(row.suite_ids),
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NamedAgentStore {
  createAgent: (input: NamedAgentCreateInput) => NamedAgent;
  updateAgent: (id: string, input: NamedAgentUpdateInput) => NamedAgent;
  deleteAgent: (id: string) => void;
  getAgent: (id: string) => NamedAgent | undefined;
  getAgentByName: (name: string) => NamedAgent | undefined;
  getDefaultAgent: () => NamedAgent;
  listAgents: () => NamedAgent[];
  syncToConfigFile: () => void;
  loadFromConfigFile: () => void;
}

// eslint-disable-next-line max-lines-per-function -- factory initializing all store methods
export function createNamedAgentStore(deps: {
  db: DatabaseInterface;
  eventBus: EventBusInterface;
  configDir: string;
}): NamedAgentStore {
  const { db, eventBus } = deps;
  const configFilePath = resolve(deps.configDir, 'agents.json');

  function emitEvent(
    type: 'agent:config:created' | 'agent:config:updated' | 'agent:config:deleted',
    agent: NamedAgent,
    extra?: Record<string, unknown>,
  ): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'named-agent-store',
      type,
      payload: { agentId: agent.id, name: agent.name, suiteIds: agent.suiteIds, ...extra },
    });
  }

  const store: NamedAgentStore = {
    createAgent(input: NamedAgentCreateInput): NamedAgent {
      const id = generateId();
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO named_agents (id, name, description, instructions, suite_ids, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        input.name,
        input.description ?? null,
        input.instructions ?? null,
        JSON.stringify(input.suiteIds),
        now,
        now,
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed after INSERT
      const agent = store.getAgent(id)!;
      log.info(`Named agent created: ${agent.name} (${agent.id})`);
      emitEvent('agent:config:created', agent);
      store.syncToConfigFile();
      return agent;
    },

    updateAgent(id: string, input: NamedAgentUpdateInput): NamedAgent {
      const existing = store.getAgent(id);
      if (!existing) throw new Error(`Named agent not found: ${id}`);
      if (existing.isDefault && input.name !== undefined && input.name !== existing.name) {
        throw new Error('Cannot rename the default agent');
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const changes: string[] = [];

      if (input.name !== undefined) {
        sets.push('name = ?');
        params.push(input.name);
        changes.push('name');
      }
      if (input.description !== undefined) {
        sets.push('description = ?');
        params.push(input.description);
        changes.push('description');
      }
      if (input.instructions !== undefined) {
        sets.push('instructions = ?');
        params.push(input.instructions);
        changes.push('instructions');
      }
      if (input.suiteIds !== undefined) {
        sets.push('suite_ids = ?');
        params.push(JSON.stringify(input.suiteIds));
        changes.push('suiteIds');
      }

      if (sets.length === 0) return existing;

      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      db.run(`UPDATE named_agents SET ${sets.join(', ')} WHERE id = ?`, ...params);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed after INSERT
      const agent = store.getAgent(id)!;
      log.info(`Named agent updated: ${agent.name} [${changes.join(', ')}]`);
      emitEvent('agent:config:updated', agent, { changes });
      store.syncToConfigFile();
      return agent;
    },

    deleteAgent(id: string): void {
      const existing = store.getAgent(id);
      if (!existing) throw new Error(`Named agent not found: ${id}`);
      if (existing.isDefault) throw new Error('Cannot delete the default agent');

      db.run('DELETE FROM named_agents WHERE id = ?', id);
      log.info(`Named agent deleted: ${existing.name} (${id})`);
      emitEvent('agent:config:deleted', existing);
      store.syncToConfigFile();
    },

    getAgent(id: string): NamedAgent | undefined {
      const row = db.get<NamedAgentRow>('SELECT * FROM named_agents WHERE id = ?', id);
      return row ? rowToAgent(row) : undefined;
    },

    getAgentByName(name: string): NamedAgent | undefined {
      const row = db.get<NamedAgentRow>('SELECT * FROM named_agents WHERE name = ?', name);
      return row ? rowToAgent(row) : undefined;
    },

    getDefaultAgent(): NamedAgent {
      const row = db.get<NamedAgentRow>('SELECT * FROM named_agents WHERE is_default = 1 LIMIT 1');
      if (!row) throw new Error('No default agent configured');
      return rowToAgent(row);
    },

    listAgents(): NamedAgent[] {
      const rows = db.all<NamedAgentRow>(
        'SELECT * FROM named_agents ORDER BY is_default DESC, name ASC',
      );
      return rows.map(rowToAgent);
    },

    syncToConfigFile(): void {
      const agents = store.listAgents();
      const config = agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        suite_ids: a.suiteIds,
        is_default: a.isDefault,
      }));
      writeFileSync(configFilePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    },

    loadFromConfigFile(): void {
      if (!existsSync(configFilePath)) {
        log.info('No agents.json found — using DB state');
        return;
      }

      const existingCount = db.get<{ count: number }>('SELECT COUNT(*) as count FROM named_agents');
      if (existingCount && existingCount.count > 0) {
        log.info(`DB already has ${existingCount.count} agents — skipping config file seed`);
        return;
      }

      const entries = parseConfigFile(configFilePath);
      if (!entries) return;

      seedAgentsFromConfig(entries, db);
    },
  };

  return store;
}

const ConfigEntrySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
  suite_ids: z.array(z.string()).optional(),
  is_default: z.union([z.boolean(), z.number()]).optional(),
});

type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

function parseConfigFile(filePath: string): ConfigEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    log.warn(`Failed to parse agents.json: ${err}`);
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    log.warn('agents.json is not an array — skipping');
    return undefined;
  }

  const entries: ConfigEntry[] = [];
  for (const raw of parsed) {
    const result = ConfigEntrySchema.safeParse(raw);
    if (!result.success) {
      log.warn(`Skipping invalid agent entry in agents.json: ${result.error.message}`);
      continue;
    }
    entries.push(result.data);
  }
  return entries;
}

function seedAgentsFromConfig(entries: ConfigEntry[], db: DatabaseInterface): void {
  const now = new Date().toISOString();
  for (const entry of entries) {
    const id = entry.id ?? generateId();
    db.run(
      `INSERT OR IGNORE INTO named_agents (id, name, description, instructions, suite_ids, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.name,
      entry.description ?? null,
      entry.instructions ?? null,
      JSON.stringify(entry.suite_ids ?? []),
      entry.is_default ? 1 : 0,
      now,
      now,
    );
  }
  log.info(`Loaded ${entries.length} agents from config file`);
}
