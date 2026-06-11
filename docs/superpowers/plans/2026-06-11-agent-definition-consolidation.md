# Agent Definition Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `projects/agents/` (filesystem YAML) the single source of truth for agent definitions; delete the SQLite `named_agents` table and `config/agents.json`.

**Architecture:** Today agent definitions live in three places that drift: the `named_agents` SQLite table (operative store, CRUD via `createNamedAgentStore`), `config/agents.json` (mirror written on every mutation + boot seed), and `projects/**/agents/*.yaml` (scanned by `ProjectRegistry`, dual-written by API routes). We replace the DB-backed store with a YAML-backed facade (`createYamlNamedAgentStore`) that keeps the existing `NamedAgentStore` interface shape (mutations become async) and wraps `ProjectRegistry` (reads) + `AgentYamlStore` (writes). Agent `id` becomes the agent `name`. We also introduce the directory-per-agent layout (`agents/<name>/agent.yaml`) that the upcoming memory feature needs, while keeping flat-file support for per-project agents. The telegram bot stops querying `named_agents` and scans the filesystem instead. Finally, migration 025 drops the table and `config/agents.json` is deleted.

**Tech Stack:** TypeScript ESM, Zod, js-yaml, Fastify, Vitest (temp dirs via `mkdtempSync`).

**Spec:** `docs/superpowers/specs/2026-06-11-consolidated-orchestration-design.md` §1 (Consolidation & data model).

**Key decisions (locked):**
- `NamedAgent.id === NamedAgent.name` (filesystem has no separate id). Old UUID ids in historical task rows simply stop resolving — acceptable runtime state, single-user system.
- `suiteIds` always returns `[]` from the new store (deprecated; `AgentYamlSchema` has no such field). The agent-resolver's default/all path still works (`skills: []` + `isDefault` → capability library ALL).
- `createdAt`/`updatedAt` derive from file `birthtime`/`mtime`.
- Events `agent:config:created/updated/deleted` keep their payload shape and gain `filePath` so the config-committer can git-commit the YAML file instead of `agents.json`.
- Scanner and yaml-store support BOTH layouts: flat `agents/<name>.yaml` (legacy, per-project agents keep it) and `agents/<name>/agent.yaml` (new). The four global agents are migrated to the directory layout in this plan.
- Mutations on the store are async (`Promise`); reads stay sync (registry snapshot in memory).

**Conventions reminders:** `.ts` extensions in imports; `explicit-function-return-type` and `max-params: 3` are errors in src (tests relaxed); `no-console`; no chained shell commands — run one at a time; `npm run check` gate at the end. Pre-existing failures exist in unrelated packages (template-scheduler, config-history, web lint) — do not try to fix those; compare against the same failures before your change.

---

### Task 1: Directory-per-agent layout support (schema, scanner, yaml-store)

**Files:**
- Modify: `packages/shared/src/project/schemas.ts:42` (relax `description`)
- Modify: `packages/core/src/project-registry/project-scanner.ts:26-49` (`loadAgentYamls`)
- Modify: `packages/core/src/project-registry/agent-yaml-store.ts` (new layout writes, layout-aware update/delete)
- Test: `packages/core/src/__tests__/agent-dir-layout.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/agent-dir-layout.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProjects } from '../project-registry/project-scanner.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import type { AgentYaml } from '@raven/shared';

const FLAT_AGENT = `name: flat-agent
displayName: Flat Agent
description: Lives as a flat yaml file
skills: []
model: sonnet
maxTurns: 20
`;

const DIR_AGENT = `name: dir-agent
displayName: Dir Agent
description: Lives in a directory
skills: []
model: sonnet
maxTurns: 20
`;

describe('directory-per-agent layout', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-agentdir-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  describe('project-scanner', () => {
    it('loads agents from both flat files and <name>/agent.yaml directories', async () => {
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);
      mkdirSync(join(projectsDir, 'agents', 'dir-agent'), { recursive: true });
      writeFileSync(join(projectsDir, 'agents', 'dir-agent', 'agent.yaml'), DIR_AGENT);

      const index = await scanProjects(projectsDir);
      const global = index.projects.get('_global');
      const names = (global?.agents ?? []).map((a) => a.name).sort();

      expect(names).toEqual(['dir-agent', 'flat-agent']);
    });

    it('ignores agent directories without agent.yaml (e.g. only memory/)', async () => {
      mkdirSync(join(projectsDir, 'agents', 'broken-agent', 'memory'), { recursive: true });

      const index = await scanProjects(projectsDir);
      const global = index.projects.get('_global');

      expect(global?.agents ?? []).toEqual([]);
    });
  });

  describe('agent-yaml-store', () => {
    const store = createAgentYamlStore();
    const agent: AgentYaml = {
      name: 'new-agent',
      displayName: 'New Agent',
      description: 'Created by store',
      isDefault: false,
      skills: [],
      model: 'sonnet',
      maxTurns: 20,
    } as AgentYaml;

    it('creates agents in the directory layout', async () => {
      await store.createAgent(projectsDir, agent);
      expect(existsSync(join(projectsDir, 'agents', 'new-agent', 'agent.yaml'))).toBe(true);
    });

    it('updates an agent stored in the directory layout', async () => {
      await store.createAgent(projectsDir, agent);
      const updated = await store.updateAgent(projectsDir, 'new-agent', {
        description: 'Updated',
      });
      expect(updated.description).toBe('Updated');
      const content = readFileSync(
        join(projectsDir, 'agents', 'new-agent', 'agent.yaml'),
        'utf-8',
      );
      expect(content).toContain('Updated');
    });

    it('updates a legacy flat-file agent in place', async () => {
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);
      const updated = await store.updateAgent(projectsDir, 'flat-agent', {
        description: 'Flat updated',
      });
      expect(updated.description).toBe('Flat updated');
      expect(existsSync(join(projectsDir, 'agents', 'flat-agent.yaml'))).toBe(true);
    });

    it('deletes agents in either layout', async () => {
      await store.createAgent(projectsDir, agent);
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);

      await store.deleteAgent(projectsDir, 'new-agent');
      await store.deleteAgent(projectsDir, 'flat-agent');

      expect(existsSync(join(projectsDir, 'agents', 'new-agent'))).toBe(false);
      expect(existsSync(join(projectsDir, 'agents', 'flat-agent.yaml'))).toBe(false);
    });

    it('accepts an empty description (default)', async () => {
      await store.createAgent(projectsDir, {
        ...agent,
        name: 'no-desc',
        description: '',
      } as AgentYaml);
      expect(existsSync(join(projectsDir, 'agents', 'no-desc', 'agent.yaml'))).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/agent-dir-layout.test.ts`
Expected: FAIL — scanner doesn't see `dir-agent`; store creates `agents/new-agent.yaml` (flat) so the directory-layout assertions fail; empty description fails Zod `min(1)`.

- [ ] **Step 3: Relax the description schema**

In `packages/shared/src/project/schemas.ts` line 42, change:

```ts
  description: z.string().min(1),
```

to:

```ts
  description: z.string().default(''),
```

- [ ] **Step 4: Extend the scanner**

In `packages/core/src/project-registry/project-scanner.ts`, replace `loadAgentYamls` (lines 26-49) with:

```ts
async function loadAgentYamls(agentsDir: string): Promise<AgentYaml[]> {
  const agents: AgentYaml[] = [];
  let candidates: string[];
  try {
    const dirEntries = await readdir(agentsDir, { withFileTypes: true });
    candidates = [];
    for (const entry of dirEntries) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        candidates.push(entry.name);
      } else if (entry.isDirectory()) {
        // Directory-per-agent layout: agents/<name>/agent.yaml
        candidates.push(join(entry.name, 'agent.yaml'));
      }
    }
  } catch {
    return agents;
  }

  for (const name of candidates) {
    try {
      const content = await readFile(join(agentsDir, name), 'utf-8');
      const raw = yamlLoad(content);
      const parsed = AgentYamlSchema.parse(raw);
      agents.push(parsed);
    } catch {
      // Flat files that fail are invalid; directories without agent.yaml are
      // silently skipped (they may hold only memory/ or other agent data).
      if (!name.endsWith(`${'/'}agent.yaml`)) {
        log.warn(`Skipping invalid agent YAML: ${name}`);
      }
    }
  }
  return agents;
}
```

- [ ] **Step 5: Update the yaml-store**

Replace the body of `packages/core/src/project-registry/agent-yaml-store.ts` with:

```ts
import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';
const { dump, load: yamlLoad } = yaml;

import { createLogger, AgentYamlSchema } from '@raven/shared';
import type { AgentYaml } from '@raven/shared';

const log = createLogger('agent-yaml-store');

export interface AgentYamlStore {
  createAgent(projectPath: string, agent: AgentYaml): Promise<string>;
  updateAgent(
    projectPath: string,
    agentName: string,
    updates: Partial<AgentYaml>,
  ): Promise<AgentYaml>;
  deleteAgent(projectPath: string, agentName: string): Promise<void>;
  resolveAgentFile(projectPath: string, agentName: string): string;
}

const LINE_WIDTH = 120;

export function createAgentYamlStore(): AgentYamlStore {
  const store: AgentYamlStore = {
    /** Resolve an agent's YAML path: directory layout preferred, flat legacy fallback. */
    resolveAgentFile(projectPath: string, agentName: string): string {
      const dirLayout = join(projectPath, 'agents', agentName, 'agent.yaml');
      if (existsSync(dirLayout)) return dirLayout;
      return join(projectPath, 'agents', `${agentName}.yaml`);
    },

    /** Create a new agent in the directory-per-agent layout. Returns the file path. */
    async createAgent(projectPath: string, agent: AgentYaml): Promise<string> {
      const validated = AgentYamlSchema.parse(agent);
      const agentDir = join(projectPath, 'agents', validated.name);
      await mkdir(agentDir, { recursive: true });
      const filePath = join(agentDir, 'agent.yaml');
      const content = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, content, 'utf-8');
      log.info(`Created agent YAML: ${validated.name} at ${filePath}`);
      return filePath;
    },

    async updateAgent(
      projectPath: string,
      agentName: string,
      updates: Partial<AgentYaml>,
    ): Promise<AgentYaml> {
      const filePath = store.resolveAgentFile(projectPath, agentName);
      const content = await readFile(filePath, 'utf-8');
      const existing = yamlLoad(content) as Record<string, unknown>;
      const merged = { ...existing, ...updates, name: agentName };
      const validated = AgentYamlSchema.parse(merged);
      const out = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, out, 'utf-8');
      log.info(`Updated agent YAML: ${agentName} at ${filePath}`);
      return validated;
    },

    async deleteAgent(projectPath: string, agentName: string): Promise<void> {
      const dirLayout = join(projectPath, 'agents', agentName);
      if (existsSync(join(dirLayout, 'agent.yaml'))) {
        await rm(dirLayout, { recursive: true });
        log.info(`Deleted agent directory: ${agentName} at ${dirLayout}`);
        return;
      }
      const flatPath = join(projectPath, 'agents', `${agentName}.yaml`);
      await unlink(flatPath);
      log.info(`Deleted agent YAML: ${agentName} at ${flatPath}`);
    },
  };
  return store;
}
```

Note `createAgent` now returns the file path (used by Task 2) — check callers: `packages/core/src/scaffolding/scaffolding-api.ts` and `packages/core/src/api/routes/agents.ts` call it without using the return value, so the signature change is compatible. Verify with:

Run: `grep -rn "agentYamlStore.createAgent\|\.createAgent(" packages/core/src --include="*.ts" | grep -v __tests__ | grep -v named-agent`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/__tests__/agent-dir-layout.test.ts`
Expected: PASS (7 tests).

Run: `npx vitest run packages/core/src/__tests__/ 2>&1 | tail -5` — confirm no NEW failures vs. the known pre-existing ones (template-scheduler, config-history, template-integration, task-execution-engine, sse, knowledge-ingestion).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/schemas.ts packages/core/src/project-registry/project-scanner.ts packages/core/src/project-registry/agent-yaml-store.ts packages/core/src/__tests__/agent-dir-layout.test.ts
git commit -m "feat(agents): support directory-per-agent layout in scanner and yaml store"
```

---

### Task 2: YAML-backed NamedAgentStore facade

**Files:**
- Create: `packages/core/src/agent-registry/yaml-named-agent-store.ts`
- Test: `packages/core/src/__tests__/yaml-named-agent-store.test.ts` (new)

The facade keeps the consumer-facing `NamedAgentStore` shape but is backed by YAML files. Reads come from the in-memory `ProjectRegistry` snapshot; mutations write via `AgentYamlStore` then reload the registry.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/yaml-named-agent-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  createYamlNamedAgentStore,
  type NamedAgentStore,
} from '../agent-registry/yaml-named-agent-store.ts';

const RAVEN_YAML = `name: raven
displayName: Raven
description: Default assistant
isDefault: true
skills: []
model: sonnet
maxTurns: 20
`;

function makeMockEventBus() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    emit: vi.fn((event: any) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
    events,
  };
}

describe('YamlNamedAgentStore', () => {
  let projectsDir: string;
  let store: NamedAgentStore;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-yamlstore-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectsDir, 'agents', 'raven', 'agent.yaml'), RAVEN_YAML);

    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    eventBus = makeMockEventBus();
    store = createYamlNamedAgentStore({
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: eventBus as any,
    });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('lists agents from the filesystem with id === name', () => {
    const agents = store.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('raven');
    expect(agents[0].name).toBe('raven');
    expect(agents[0].isDefault).toBe(true);
    expect(agents[0].suiteIds).toEqual([]);
  });

  it('returns the default agent', () => {
    expect(store.getDefaultAgent().name).toBe('raven');
  });

  it('creates an agent as <name>/agent.yaml and emits created event', async () => {
    const agent = await store.createAgent({
      name: 'researcher',
      description: 'Research things',
      suiteIds: [],
      skills: ['web-search'],
    });

    expect(agent.id).toBe('researcher');
    expect(agent.skills).toEqual(['web-search']);
    expect(existsSync(join(projectsDir, 'agents', 'researcher', 'agent.yaml'))).toBe(true);
    expect(store.getAgentByName('researcher')?.description).toBe('Research things');

    const created = eventBus.events.find((e) => e.type === 'agent:config:created');
    expect(created).toBeDefined();
    expect(created!.payload.name).toBe('researcher');
    expect(created!.payload.filePath).toContain('researcher');
  });

  it('rejects duplicate names', async () => {
    await expect(
      store.createAgent({ name: 'raven', suiteIds: [], skills: [] }),
    ).rejects.toThrow(/already exists/);
  });

  it('updates fields and persists to YAML', async () => {
    await store.createAgent({ name: 'temp-agent', suiteIds: [], skills: [] });
    const updated = await store.updateAgent('temp-agent', {
      description: 'New desc',
      model: 'haiku',
      maxTurns: 5,
    });
    expect(updated.description).toBe('New desc');
    expect(updated.model).toBe('haiku');
    expect(updated.maxTurns).toBe(5);
    expect(store.getAgent('temp-agent')?.model).toBe('haiku');
  });

  it('renames an agent (new file created, old removed, id follows name)', async () => {
    await store.createAgent({ name: 'old-name', suiteIds: [], skills: [] });
    const renamed = await store.updateAgent('old-name', { name: 'new-name' });
    expect(renamed.id).toBe('new-name');
    expect(store.getAgent('old-name')).toBeUndefined();
    expect(store.getAgent('new-name')).toBeDefined();
    expect(existsSync(join(projectsDir, 'agents', 'new-name', 'agent.yaml'))).toBe(true);
    expect(existsSync(join(projectsDir, 'agents', 'old-name'))).toBe(false);
  });

  it('refuses to rename or delete the default agent', async () => {
    await expect(store.updateAgent('raven', { name: 'corvid' })).rejects.toThrow(
      /Cannot rename/,
    );
    await expect(store.deleteAgent('raven')).rejects.toThrow(/Cannot delete/);
  });

  it('deletes a non-default agent and emits deleted event', async () => {
    await store.createAgent({ name: 'doomed', suiteIds: [], skills: [] });
    await store.deleteAgent('doomed');
    expect(store.getAgent('doomed')).toBeUndefined();
    expect(eventBus.events.some((e) => e.type === 'agent:config:deleted')).toBe(true);
  });

  it('throws on update/delete of unknown agent', async () => {
    await expect(store.updateAgent('ghost', { description: 'x' })).rejects.toThrow(
      /not found/,
    );
    await expect(store.deleteAgent('ghost')).rejects.toThrow(/not found/);
  });

  it('sees agents from sub-projects (flat layout)', async () => {
    mkdirSync(join(projectsDir, 'proj-x', 'agents'), { recursive: true });
    writeFileSync(join(projectsDir, 'proj-x', 'context.md'), '# X\n');
    writeFileSync(
      join(projectsDir, 'proj-x', 'agents', 'sub-agent.yaml'),
      `name: sub-agent\ndisplayName: Sub\ndescription: In a project\nskills: []\nmodel: sonnet\nmaxTurns: 20\n`,
    );
    // Re-create the store after adding files (fresh registry load)
    const reg = new ProjectRegistry();
    // eslint-disable-next-line no-async-promise-executor
    return new Promise<void>(async (resolve) => {
      await reg.load(projectsDir);
      const s2 = createYamlNamedAgentStore({
        projectRegistry: reg,
        agentYamlStore: createAgentYamlStore(),
        projectsDir,
        eventBus: eventBus as any,
      });
      expect(s2.getAgentByName('sub-agent')).toBeDefined();
      resolve();
    });
  });
});
```

(In the last test, the async-promise wrapper is unnecessary complexity — write it as a plain `async` test body instead:)

```ts
  it('sees agents from sub-projects (flat layout)', async () => {
    mkdirSync(join(projectsDir, 'proj-x', 'agents'), { recursive: true });
    writeFileSync(join(projectsDir, 'proj-x', 'context.md'), '# X\n');
    writeFileSync(
      join(projectsDir, 'proj-x', 'agents', 'sub-agent.yaml'),
      `name: sub-agent\ndisplayName: Sub\ndescription: In a project\nskills: []\nmodel: sonnet\nmaxTurns: 20\n`,
    );
    const reg = new ProjectRegistry();
    await reg.load(projectsDir);
    const s2 = createYamlNamedAgentStore({
      projectRegistry: reg,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: eventBus as any,
    });
    expect(s2.getAgentByName('sub-agent')).toBeDefined();
  });
```

Use the plain version.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/yaml-named-agent-store.test.ts`
Expected: FAIL — module `yaml-named-agent-store.ts` does not exist.

- [ ] **Step 3: Implement the facade**

Create `packages/core/src/agent-registry/yaml-named-agent-store.ts`:

```ts
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createLogger,
  generateId,
  type EventBusInterface,
  type NamedAgent,
  type NamedAgentCreateInput,
  type NamedAgentUpdateInput,
  type AgentYaml,
} from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';

const log = createLogger('yaml-named-agent-store');

export interface NamedAgentStore {
  createAgent: (
    input: NamedAgentCreateInput,
    options?: { projectScope?: string },
  ) => Promise<NamedAgent>;
  updateAgent: (id: string, input: NamedAgentUpdateInput) => Promise<NamedAgent>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => NamedAgent | undefined;
  getAgentByName: (name: string) => NamedAgent | undefined;
  getDefaultAgent: () => NamedAgent;
  listAgents: () => NamedAgent[];
}

interface AgentLocation {
  yaml: AgentYaml;
  projectPath: string;
  filePath: string;
}

interface StoreDeps {
  projectRegistry: ProjectRegistry;
  agentYamlStore: AgentYamlStore;
  projectsDir: string;
  eventBus: EventBusInterface;
}

function resolveFilePath(projectPath: string, name: string): string {
  const dirLayout = join(projectPath, 'agents', name, 'agent.yaml');
  if (existsSync(dirLayout)) return dirLayout;
  return join(projectPath, 'agents', `${name}.yaml`);
}

function yamlToNamedAgent(loc: AgentLocation): NamedAgent {
  let createdAt = new Date(0).toISOString();
  let updatedAt = createdAt;
  try {
    const st = statSync(loc.filePath);
    createdAt = st.birthtime.toISOString();
    updatedAt = st.mtime.toISOString();
  } catch {
    // File may be mid-move; timestamps are informational only
  }
  return {
    id: loc.yaml.name,
    name: loc.yaml.name,
    description: loc.yaml.description === '' ? null : loc.yaml.description,
    instructions: loc.yaml.instructions ?? null,
    suiteIds: [], // deprecated — YAML agents have no suite bindings
    skills: loc.yaml.skills,
    model: loc.yaml.model,
    maxTurns: loc.yaml.maxTurns,
    isDefault: loc.yaml.isDefault,
    createdAt,
    updatedAt,
  };
}

function inputToYaml(input: NamedAgentCreateInput): AgentYaml {
  return {
    name: input.name,
    displayName: input.name,
    description: input.description ?? '',
    isDefault: false,
    skills: input.skills,
    ...(input.instructions !== undefined && { instructions: input.instructions }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.maxTurns !== undefined && { maxTurns: input.maxTurns }),
    ...(input.bash !== undefined && { bash: input.bash }),
  } as AgentYaml;
}

function updateInputToYamlPatch(input: NamedAgentUpdateInput): Partial<AgentYaml> {
  const patch: Partial<AgentYaml> = {};
  if (input.description !== undefined) patch.description = input.description ?? '';
  if (input.instructions !== undefined) patch.instructions = input.instructions ?? '';
  if (input.skills !== undefined) patch.skills = input.skills;
  if (input.model !== undefined && input.model !== null) patch.model = input.model;
  if (input.maxTurns !== undefined && input.maxTurns !== null) patch.maxTurns = input.maxTurns;
  if (input.bash !== undefined) patch.bash = input.bash;
  return patch;
}

// eslint-disable-next-line max-lines-per-function -- factory initializing all store methods
export function createYamlNamedAgentStore(deps: StoreDeps): NamedAgentStore {
  const { projectRegistry, agentYamlStore, projectsDir, eventBus } = deps;

  function collectLocations(): Map<string, AgentLocation> {
    const locations = new Map<string, AgentLocation>();
    const nodes = [];
    try {
      nodes.push(projectRegistry.getGlobal());
    } catch {
      // Registry not loaded yet — empty store
    }
    nodes.push(...projectRegistry.listProjects());

    for (const node of nodes) {
      for (const agentYaml of node.agents) {
        if (locations.has(agentYaml.name)) continue; // global wins on name conflict
        locations.set(agentYaml.name, {
          yaml: agentYaml,
          projectPath: node.path,
          filePath: resolveFilePath(node.path, agentYaml.name),
        });
      }
    }
    return locations;
  }

  function getLocation(idOrName: string): AgentLocation | undefined {
    return collectLocations().get(idOrName);
  }

  function emitEvent(
    type: 'agent:config:created' | 'agent:config:updated' | 'agent:config:deleted',
    agent: NamedAgent,
    filePath: string,
    extra?: Record<string, unknown>,
  ): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'named-agent-store',
      type,
      payload: {
        agentId: agent.id,
        name: agent.name,
        suiteIds: agent.suiteIds,
        skills: agent.skills,
        filePath,
        ...extra,
      },
    });
  }

  const store: NamedAgentStore = {
    getAgent(id: string): NamedAgent | undefined {
      const loc = getLocation(id);
      return loc ? yamlToNamedAgent(loc) : undefined;
    },

    getAgentByName(name: string): NamedAgent | undefined {
      return store.getAgent(name);
    },

    getDefaultAgent(): NamedAgent {
      for (const loc of collectLocations().values()) {
        if (loc.yaml.isDefault) return yamlToNamedAgent(loc);
      }
      throw new Error('No default agent configured');
    },

    listAgents(): NamedAgent[] {
      const agents = [...collectLocations().values()].map(yamlToNamedAgent);
      agents.sort((a, b) =>
        a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1,
      );
      return agents;
    },

    async createAgent(
      input: NamedAgentCreateInput,
      options?: { projectScope?: string },
    ): Promise<NamedAgent> {
      if (getLocation(input.name)) {
        throw new Error(`Agent name already exists: ${input.name}`);
      }
      const targetDir = options?.projectScope
        ? resolve(projectsDir, options.projectScope)
        : projectsDir;
      const filePath = await agentYamlStore.createAgent(targetDir, inputToYaml(input));
      await projectRegistry.load(projectsDir);

      const loc = getLocation(input.name);
      if (!loc) throw new Error(`Agent creation failed to register: ${input.name}`);
      const agent = yamlToNamedAgent(loc);
      log.info(`Named agent created: ${agent.name}`);
      emitEvent('agent:config:created', agent, filePath);
      return agent;
    },

    async updateAgent(id: string, input: NamedAgentUpdateInput): Promise<NamedAgent> {
      const loc = getLocation(id);
      if (!loc) throw new Error(`Named agent not found: ${id}`);

      const isRename = input.name !== undefined && input.name !== loc.yaml.name;
      if (isRename && loc.yaml.isDefault) {
        throw new Error('Cannot rename the default agent');
      }
      if (isRename && getLocation(input.name as string)) {
        throw new Error(`Agent name already exists: ${input.name}`);
      }

      const patch = updateInputToYamlPatch(input);

      if (isRename) {
        const newName = input.name as string;
        const mergedYaml = {
          ...loc.yaml,
          ...patch,
          name: newName,
          displayName: newName,
        } as AgentYaml;
        const filePath = await agentYamlStore.createAgent(loc.projectPath, mergedYaml);
        await agentYamlStore.deleteAgent(loc.projectPath, loc.yaml.name);
        await projectRegistry.load(projectsDir);
        const newLoc = getLocation(newName);
        if (!newLoc) throw new Error(`Agent rename failed to register: ${newName}`);
        const agent = yamlToNamedAgent(newLoc);
        log.info(`Named agent renamed: ${id} → ${newName}`);
        emitEvent('agent:config:updated', agent, filePath, { changes: Object.keys(input) });
        return agent;
      }

      await agentYamlStore.updateAgent(loc.projectPath, loc.yaml.name, patch);
      await projectRegistry.load(projectsDir);
      const updatedLoc = getLocation(id);
      if (!updatedLoc) throw new Error(`Agent update failed to register: ${id}`);
      const agent = yamlToNamedAgent(updatedLoc);
      log.info(`Named agent updated: ${agent.name} [${Object.keys(input).join(', ')}]`);
      emitEvent('agent:config:updated', agent, updatedLoc.filePath, {
        changes: Object.keys(input),
      });
      return agent;
    },

    async deleteAgent(id: string): Promise<void> {
      const loc = getLocation(id);
      if (!loc) throw new Error(`Named agent not found: ${id}`);
      if (loc.yaml.isDefault) throw new Error('Cannot delete the default agent');

      const agent = yamlToNamedAgent(loc);
      await agentYamlStore.deleteAgent(loc.projectPath, loc.yaml.name);
      await projectRegistry.load(projectsDir);
      log.info(`Named agent deleted: ${agent.name}`);
      emitEvent('agent:config:deleted', agent, loc.filePath);
    },
  };

  return store;
}
```

Note: `NamedAgentCreateInput` must include `bash` — verify with `grep -n "NamedAgentCreateInput" packages/shared/src/types/agents.ts`. The Zod schema already has `bash: BashAccessSchema.optional()`. If the inferred type lacks it, no change needed (it's inferred). Also verify `AgentYaml` is exported from `@raven/shared` (it is, via `packages/shared/src/types/project-fs.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/__tests__/yaml-named-agent-store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-registry/yaml-named-agent-store.ts packages/core/src/__tests__/yaml-named-agent-store.test.ts
git commit -m "feat(agents): add YAML-backed named agent store facade"
```

---

### Task 3: Rewire all consumers, delete legacy store and agents.json

This task is the atomic switch. After it, nothing imports `named-agent-store.ts` and `config/agents.json` is gone.

**Files:**
- Modify: `packages/core/src/index.ts` (~lines 216-229: store construction; config-committer)
- Modify: `packages/core/src/agent-registry/config-committer.ts` (commit `payload.filePath`)
- Modify: `packages/core/src/api/routes/agents.ts` (drop dual-write helpers, await mutations)
- Modify: `packages/core/src/api/server.ts` (type import; drop removed route deps)
- Modify: `packages/core/src/orchestrator/orchestrator.ts:25` (type import path)
- Modify: `packages/core/src/mcp-server/types.ts:6` (type import path)
- Modify: `packages/core/src/mcp-server/tools/system.ts` (await mutations)
- Modify: `suites/_orchestrator/services/config-applier.ts` (async agent methods)
- Delete: `packages/core/src/agent-registry/named-agent-store.ts`
- Delete: `packages/core/src/__tests__/named-agent-store.test.ts`
- Delete: `config/agents.json`
- Move: `projects/agents/*.yaml` → `projects/agents/<name>/agent.yaml`
- Rewrite test: `packages/core/src/__tests__/agents-api.test.ts`
- Touch tests: `packages/core/src/__tests__/mcp-server/tools/system.test.ts`, `suites/_orchestrator/__tests__/config-management.test.ts` (async mocks)

- [ ] **Step 1: Migrate the global agent files to the directory layout**

Run each command separately:

```bash
mkdir -p projects/agents/raven projects/agents/_agent-builder projects/agents/_evaluator projects/agents/_quality-reviewer
```
```bash
git mv projects/agents/raven.yaml projects/agents/raven/agent.yaml
```
```bash
git mv projects/agents/_agent-builder.yaml projects/agents/_agent-builder/agent.yaml
```
```bash
git mv projects/agents/_evaluator.yaml projects/agents/_evaluator/agent.yaml
```
```bash
git mv projects/agents/_quality-reviewer.yaml projects/agents/_quality-reviewer/agent.yaml
```

Leave per-project agents (`projects/system/agents/system-admin.yaml`, `projects/<uuid>/agents/e2e-agent.yaml`) in flat layout — supported.

- [ ] **Step 2: Update config-committer**

Replace the handler body in `packages/core/src/agent-registry/config-committer.ts`. The deps lose `configFilePath`; the file to commit comes from the event payload:

```ts
import { createLogger, gitAutoCommit, type RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('config-committer');

export interface ConfigCommitter {
  start: () => void;
}

export function createConfigCommitter(deps: { eventBus: EventBus }): ConfigCommitter {
  const { eventBus } = deps;

  return {
    start(): void {
      const handler = (event: RavenEvent): void => {
        if (
          event.type !== 'agent:config:created' &&
          event.type !== 'agent:config:updated' &&
          event.type !== 'agent:config:deleted'
        ) {
          return;
        }

        const payload = event.payload as { name: string; filePath?: string };
        if (!payload.filePath) return;
        gitAutoCommit([payload.filePath], `chore: update agent config — ${payload.name}`).catch(
          (err: unknown) => {
            log.warn(`Git auto-commit failed: ${err}`);
          },
        );
      };

      for (const eventType of [
        'agent:config:created',
        'agent:config:updated',
        'agent:config:deleted',
      ] as const) {
        eventBus.on(eventType, handler);
      }

      log.info('Config committer listening for agent config changes');
    },
  };
}
```

- [ ] **Step 3: Rewire index.ts**

In `packages/core/src/index.ts`:

Change import line 35 from:
```ts
import { createNamedAgentStore } from './agent-registry/named-agent-store.ts';
```
to:
```ts
import { createYamlNamedAgentStore } from './agent-registry/yaml-named-agent-store.ts';
```

Replace the 7f block (lines ~216-229):
```ts
  // 7f. Init named agent registry
  const namedAgentStore = createNamedAgentStore({
    db: dbInterface,
    eventBus: baseContext.eventBus,
    configDir: configDir,
  });
  namedAgentStore.loadFromConfigFile();
  const agentResolver = createAgentResolver({ capabilityLibrary, suiteRegistry });
  const configCommitter = createConfigCommitter({
    eventBus,
    configFilePath: resolve(configDir, 'agents.json'),
  });
  configCommitter.start();
```
with:
```ts
  // 7f. Init named agent registry (filesystem YAML is the source of truth)
  const namedAgentStore = createYamlNamedAgentStore({
    projectRegistry,
    agentYamlStore,
    projectsDir,
    eventBus: baseContext.eventBus,
  });
  const agentResolver = createAgentResolver({ capabilityLibrary, suiteRegistry });
  const configCommitter = createConfigCommitter({ eventBus });
  configCommitter.start();
```

`projectRegistry`, `agentYamlStore`, and `projectsDir` are all created earlier in boot (lines ~150-160), so they're in scope. Everything else in index.ts (line ~320 `getAgent`, passing `namedAgentStore` to Orchestrator and API server) stays unchanged.

- [ ] **Step 4: Update type-import sites**

In each of these files, change the import:
```ts
import type { NamedAgentStore } from '../agent-registry/named-agent-store.ts';
```
to:
```ts
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
```
- `packages/core/src/orchestrator/orchestrator.ts:25`
- `packages/core/src/api/server.ts:48`
- `packages/core/src/api/routes/agents.ts:11` (path is `../../agent-registry/...`)
- `packages/core/src/mcp-server/types.ts:6`

- [ ] **Step 5: Simplify routes/agents.ts**

Rewrite `packages/core/src/api/routes/agents.ts`: delete `syncYamlCreate`, `syncYamlUpdate`, `syncYamlDelete`, `findAgentInRegistry`; drop `agentYamlStore`/`projectRegistry`/`projectsDir` from `AgentRouteDeps`; `await` the store mutations; pass `projectScope` through to `createAgent`. Full replacement:

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  NamedAgentCreateInputSchema,
  NamedAgentUpdateInputSchema,
} from '@raven/shared';
import type { NamedAgentStore } from '../../agent-registry/yaml-named-agent-store.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';
import type { SuiteRegistry } from '../../suite-registry/suite-registry.ts';
import type { TaskStore } from '../../task-manager/task-store.ts';

const HTTP_STATUS = { OK_CREATED: 201, BAD_REQUEST: 400, NOT_FOUND: 404 } as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const TaskHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AgentRouteDeps {
  namedAgentStore: NamedAgentStore;
  agentManager: AgentManager;
  suiteRegistry: SuiteRegistry;
  taskStore?: TaskStore;
}

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { namedAgentStore, agentManager, suiteRegistry, taskStore } = deps;

  function getActiveAgentIds(): Set<string> {
    const activeTasks = agentManager.getActiveTasks();
    const ids = new Set<string>();
    for (const task of [...activeTasks.running, ...activeTasks.queued]) {
      if (task.namedAgentId) ids.add(task.namedAgentId);
    }
    return ids;
  }

  function enrichSuiteInfo(suiteIds: string[]): Array<{ name: string; displayName: string }> {
    return suiteIds
      .map((name) => {
        const suite = suiteRegistry.getSuite(name);
        return suite ? { name, displayName: suite.manifest.displayName } : null;
      })
      .filter((s): s is { name: string; displayName: string } => s !== null);
  }

  // GET /api/agents — list all named agents with enrichment
  app.get('/api/agents', async () => {
    const agents = namedAgentStore.listAgents();
    const activeIds = getActiveAgentIds();

    return agents.map((agent) => {
      let completedCount = 0;
      let inProgressCount = 0;
      if (taskStore) {
        completedCount = taskStore.queryTasks({
          assignedAgentId: agent.id,
          status: 'completed',
        }).length;
        inProgressCount = taskStore.queryTasks({
          assignedAgentId: agent.id,
          status: 'in_progress',
        }).length;
      }

      return {
        ...agent,
        suites: enrichSuiteInfo(agent.suiteIds),
        isActive: activeIds.has(agent.id),
        taskCounts: { completed: completedCount, inProgress: inProgressCount },
      };
    });
  });

  // GET /api/agents/:id — full agent detail
  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = namedAgentStore.getAgent(id);
    if (!agent) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Agent not found' });
    }

    const activeIds = getActiveAgentIds();

    return {
      ...agent,
      suites: enrichSuiteInfo(agent.suiteIds),
      isActive: activeIds.has(agent.id),
    };
  });

  // POST /api/agents — create named agent
  app.post('/api/agents', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const projectScope = typeof body.projectScope === 'string' ? body.projectScope : undefined;

    const result = NamedAgentCreateInputSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid agent input',
        details: result.error.issues,
      });
    }

    try {
      const agent = await namedAgentStore.createAgent(result.data, { projectScope });
      return reply.status(HTTP_STATUS.OK_CREATED).send(agent);
    } catch (err) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message });
    }
  });

  // PATCH /api/agents/:id — update agent fields
  app.patch('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = NamedAgentUpdateInputSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid update input',
        details: result.error.issues,
      });
    }

    try {
      return await namedAgentStore.updateAgent(id, result.data);
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST;
      return reply.status(status).send({ error: msg });
    }
  });

  // DELETE /api/agents/:id — delete agent (400 if default)
  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await namedAgentStore.deleteAgent(id);
      return { success: true };
    } catch (err) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message });
    }
  });

  // GET /api/agents/:id/tasks — paginated task history
  app.get('/api/agents/:id/tasks', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = namedAgentStore.getAgent(id);
    if (!agent) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Agent not found' });
    }

    const result = TaskHistoryQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid query parameters' });
    }

    if (!taskStore) {
      return [];
    }

    return taskStore.queryTasks({
      assignedAgentId: id,
      limit: result.data.limit,
      offset: result.data.offset,
      includeArchived: true,
    });
  });
}
```

Then find where `server.ts` calls `registerAgentRoutes` and remove the now-gone deps:

Run: `grep -n "registerAgentRoutes" packages/core/src/api/server.ts`

Update that call to pass only `{ namedAgentStore, agentManager, suiteRegistry, taskStore }` (keep whatever names server.ts uses for those). Note: `agentYamlStore`, `projectRegistry`, `projectsDir` likely remain in `server.ts` deps for OTHER routes (scaffolding/projects) — only remove them from the `registerAgentRoutes` call, not from the server interface.

- [ ] **Step 6: Await mutations in MCP system tools**

In `packages/core/src/mcp-server/tools/system.ts`:
- `create_agent` handler: `const agent = await deps.namedAgentStore.createAgent({ ... });`
- `update_agent` handler: `await deps.namedAgentStore.updateAgent(agentId, updates);`

Both handlers are already `async` — just add `await`.

- [ ] **Step 7: Async agent methods in config-applier**

In `suites/_orchestrator/services/config-applier.ts`:

Change the structural dep type:
```ts
  namedAgentStore: {
    createAgent: (input: { name: string; description?: string; instructions?: string; suiteIds: string[] }) => Promise<{ id: string; name: string }>;
    updateAgent: (id: string, input: { name?: string; description?: string; instructions?: string; suiteIds?: string[] }) => Promise<{ id: string; name: string }>;
    deleteAgent: (id: string) => Promise<void>;
    getAgentByName: (name: string) => { id: string; name: string } | undefined;
  };
```

Then in the agent-change function (the one containing `deps.namedAgentStore.createAgent(...)` around line 246): make it `async` (returning `Promise<ApplyResult>`), add `await` to the `createAgent`, `updateAgent`, `deleteAgent` calls, and `await` its call-site(s) within the file (search: `grep -n "applyAgentChange" suites/_orchestrator/services/config-applier.ts` — the dispatcher may already be async; if not, make the chain async up to the exported entry point and `await` at its callers found via `grep -rn "applyConfigChange\|applyAgentChange" suites/_orchestrator/ --include="*.ts" | grep -v __tests__`).

In `suites/_orchestrator/__tests__/config-management.test.ts`, update the namedAgentStore mocks: any `vi.fn(() => ({...}))` for create/update/delete becomes `vi.fn(async () => ({...}))` so the types line up (find them with `grep -n "createAgent\|updateAgent\|deleteAgent" suites/_orchestrator/__tests__/config-management.test.ts`).

- [ ] **Step 8: Delete the legacy store, its test, and agents.json**

```bash
git rm packages/core/src/agent-registry/named-agent-store.ts
```
```bash
git rm packages/core/src/__tests__/named-agent-store.test.ts
```
```bash
git rm config/agents.json
```

Verify nothing references the old module anymore:

Run: `grep -rn "named-agent-store" packages/ suites/ --include="*.ts" | grep -v dist`
Expected: no matches (the new store logs under the same `named-agent-store` source string in events, which is fine — that's a string, not an import).

- [ ] **Step 9: Rewrite agents-api.test.ts**

Replace `packages/core/src/__tests__/agents-api.test.ts` entirely:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  createYamlNamedAgentStore,
  type NamedAgentStore,
} from '../agent-registry/yaml-named-agent-store.ts';
import { registerAgentRoutes } from '../api/routes/agents.ts';

const RAVEN_YAML = `name: raven
displayName: Raven
description: Default assistant
isDefault: true
skills: []
model: sonnet
maxTurns: 20
`;

function makeMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeMockAgentManager() {
  return {
    getActiveTasks: vi.fn(() => ({ running: [], queued: [] })),
  } as any;
}

function makeMockSuiteRegistry() {
  return {
    getSuite: vi.fn(() => null),
    getAllSuites: vi.fn(() => []),
    getEnabledSuiteNames: vi.fn(() => []),
    collectMcpServers: vi.fn(() => ({})),
    collectAgentDefinitions: vi.fn(() => ({})),
  } as any;
}

describe('Agents API', () => {
  let projectsDir: string;
  let app: FastifyInstance;
  let store: NamedAgentStore;

  beforeAll(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-agentsapi-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectsDir, 'agents', 'raven', 'agent.yaml'), RAVEN_YAML);

    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    store = createYamlNamedAgentStore({
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: makeMockEventBus() as any,
    });

    app = Fastify({ logger: false });
    registerAgentRoutes(app, {
      namedAgentStore: store,
      agentManager: makeMockAgentManager(),
      suiteRegistry: makeMockSuiteRegistry(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(projectsDir, { recursive: true, force: true });
  });

  describe('GET /api/agents', () => {
    it('returns list of agents', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('isActive');
      expect(body[0]).toHaveProperty('taskCounts');
    });
  });

  describe('POST /api/agents', () => {
    it('creates a new agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'api-test', description: 'API test agent', suiteIds: [] },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('api-test');
      expect(body.id).toBe('api-test');
      expect(body.description).toBe('API test agent');
    });

    it('rejects duplicate agent names', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'raven', suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('already exists');
    });

    it('validates kebab-case name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Invalid Name', suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns agent by id (= name)', async () => {
      const created = await store.createAgent({ name: 'get-api-test', suiteIds: [], skills: [] });
      const res = await app.inject({ method: 'GET', url: `/api/agents/${created.id}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('get-api-test');
    });

    it('returns 404 for nonexistent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/agents/:id', () => {
    it('updates agent fields', async () => {
      const created = await store.createAgent({ name: 'patch-test', suiteIds: [], skills: [] });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.id}`,
        payload: { description: 'Updated via API' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.description).toBe('Updated via API');
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/agents/nonexistent',
        payload: { description: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes a non-default agent', async () => {
      const created = await store.createAgent({
        name: 'delete-api-test',
        suiteIds: [],
        skills: [],
      });
      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
      expect(res.statusCode).toBe(200);
      expect(store.getAgent(created.id)).toBeUndefined();
    });

    it('returns 400 when trying to delete default agent', async () => {
      const defaultAgent = store.getDefaultAgent();
      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${defaultAgent.id}` });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/agents/:id/tasks', () => {
    it('returns empty array when no task store', async () => {
      const created = await store.createAgent({
        name: 'tasks-api-test',
        suiteIds: [],
        skills: [],
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${created.id}/tasks`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents/nonexistent/tasks' });
      expect(res.statusCode).toBe(404);
    });
  });
});
```

- [ ] **Step 10: Fix the system tools test if needed**

Run: `npx vitest run packages/core/src/__tests__/mcp-server/tools/system.test.ts`

If it fails because mocks return plain objects where the tool now awaits: awaiting a non-promise is fine at runtime; failures would only come from changed expectations. Inspect failures and update mock `createAgent`/`updateAgent` to `vi.fn(async () => ...)` where the test asserts on returned values.

- [ ] **Step 11: Run the affected test files**

Run each separately:
```bash
npx vitest run packages/core/src/__tests__/agents-api.test.ts
```
```bash
npx vitest run packages/core/src/__tests__/yaml-named-agent-store.test.ts
```
```bash
npx vitest run packages/core/src/__tests__/mcp-server/tools/system.test.ts
```
```bash
npx vitest run suites/_orchestrator/__tests__/config-management.test.ts
```
Expected: all PASS.

Type-check the workspace:
```bash
npm run build -w packages/shared -w packages/core
```
Expected: clean compile.

- [ ] **Step 12: Commit**

```bash
git add -A packages/core/src packages/shared/src suites/_orchestrator projects/agents
```
```bash
git commit -m "refactor(agents)!: filesystem YAML is the sole agent definition store

- replace DB-backed named-agent-store with YAML-backed facade (id = name)
- delete config/agents.json and the dual-write sync helpers in routes
- config-committer commits agent YAML paths from event payloads
- migrate global agents to directory-per-agent layout"
```

---

### Task 4: Telegram bootstrap from filesystem + drop named_agents table

**Files:**
- Modify: `suites/notifications/services/telegram-bot.ts` (bootstrap block ~lines 871-890; add fs helper)
- Create: `migrations/025-drop-named-agents.sql`
- Modify: `suites/notifications/__tests__/helpers/test-db.ts` (remove named_agents stub)
- Modify: `suites/notifications/__tests__/telegram-bot.test.ts` (bootstrap test uses fs fixtures)

- [ ] **Step 1: Write/adjust the failing tests**

In `suites/notifications/__tests__/telegram-bot.test.ts`, replace the test `'bootstrap does not re-create topics that are already persisted'` with this pair (inside `describe('topic persistence')`). They need `projectRoot` in the service context pointing at a temp dir with agent fixtures:

```ts
  it('bootstrap creates topics for filesystem agents, skipping _system agents', async () => {
    const { createTestDb } = await import('./helpers/test-db.ts');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const projectRoot = mkdtempSync(join(tmpdir(), 'raven-tg-boot-'));
    mkdirSync(join(projectRoot, 'projects', 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectRoot, 'projects', 'agents', 'raven', 'agent.yaml'), 'name: raven\n');
    mkdirSync(join(projectRoot, 'projects', 'agents', '_evaluator'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'projects', 'agents', '_evaluator', 'agent.yaml'),
      'name: _evaluator\n',
    );

    const db = createTestDb();
    await loadService();
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      db,
      config: {},
      projectRoot,
    });

    await vi.waitFor(() => {
      expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateForumTopic).toHaveBeenCalledWith('-1001234567890', 'Agent: Raven');
  });

  it('bootstrap does not re-create topics that are already persisted', async () => {
    const { createTestDb } = await import('./helpers/test-db.ts');
    const { saveStoredTopic } = await import('../services/topic-store.ts');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const projectRoot = mkdtempSync(join(tmpdir(), 'raven-tg-boot2-'));
    mkdirSync(join(projectRoot, 'projects', 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectRoot, 'projects', 'agents', 'raven', 'agent.yaml'), 'name: raven\n');

    const db = createTestDb();
    saveStoredTopic(db, { scope: 'agent', key: 'raven', groupId: '-1001234567890' }, 42);

    await loadService();
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      db,
      config: {},
      projectRoot,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCreateForumTopic).not.toHaveBeenCalled();
  });
```

IMPORTANT: the test file mocks `node:fs` with `importOriginal` (done in the previous plan) — `mkdtempSync`/`mkdirSync`/`writeFileSync` come through the partial mock. Check the current `vi.mock('node:fs', ...)` block passes through original functions for anything not explicitly mocked; if `mkdirSync`/`writeFileSync`/`mkdtempSync`/`readdirSync` are not passed through, extend the mock factory to spread `importOriginal()` results first:

```ts
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
  };
});
```

CAUTION: `existsSync` is mocked to return `false` by default and the new bot helper uses `readdirSync` (real) + the dir-layout check uses `existsSync` (mocked!). To avoid fighting the mock, implement the bot helper WITHOUT `existsSync` — use `readdirSync(join(agentsDir, e.name))` inside a try/catch instead (see Step 3).

Also in `suites/notifications/__tests__/helpers/test-db.ts`, delete the line:
```ts
  raw.exec('CREATE TABLE IF NOT EXISTS named_agents (name TEXT PRIMARY KEY)');
```
and remove the comment line above it referencing named_agents.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: the first new test FAILS (bot still queries the now-absent `named_agents` table — the old bootstrap logs a warning and creates nothing). The second may pass vacuously; that's fine — it pins the regression.

- [ ] **Step 3: Implement the filesystem bootstrap**

In `suites/notifications/services/telegram-bot.ts`:

Add `readdirSync` to the existing `node:fs` import (line 2):
```ts
import { existsSync, statSync, readdirSync } from 'node:fs';
```

Add near the topic-management section (above `ensureAllAgentTopics`):

```ts
// Agent names come from the filesystem (projects/agents/) — the single source
// of truth for agent definitions. Supports both flat <name>.yaml files and
// directory-per-agent <name>/agent.yaml layouts. System agents (_-prefixed)
// never get Telegram topics.
export function listAgentNamesFromFs(projectRoot: string | undefined): string[] {
  if (!projectRoot) return [];
  const agentsDir = join(projectRoot, 'projects', 'agents');
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      names.push(entry.name.replace(/\.ya?ml$/, ''));
    } else if (entry.isDirectory()) {
      try {
        const inner = readdirSync(join(agentsDir, entry.name));
        if (inner.includes('agent.yaml')) names.push(entry.name);
      } catch {
        // unreadable dir — skip
      }
    }
  }
  return names.filter((n) => !n.startsWith('_'));
}
```

(`join` is already imported from `node:path` at the top of the file.)

Then replace the bootstrap block (currently ~lines 871-884):

```ts
    // Bootstrap agent topics from DB and listen for new agent creation
    if (operatingMode === 'group' && dbRef) {
      try {
        const rows = dbRef.all<{ name: string }>('SELECT name FROM named_agents');
        const agentNames = rows.map((r) => r.name);
        if (agentNames.length > 0) {
          ensureAllAgentTopics(agentNames).catch((err: unknown) => {
            logger.warn(`Failed to bootstrap agent topics: ${err}`);
          });
        }
      } catch (err) {
        logger.warn(`Failed to query named agents for topic bootstrap: ${err}`);
      }
```

with:

```ts
    // Bootstrap agent topics from the filesystem and listen for new agent creation
    if (operatingMode === 'group') {
      const agentNames = listAgentNamesFromFs(context.projectRoot);
      if (agentNames.length > 0) {
        ensureAllAgentTopics(agentNames).catch((err: unknown) => {
          logger.warn(`Failed to bootstrap agent topics: ${err}`);
        });
      }
```

Note the enclosing `if` no longer requires `dbRef` — but the `agent:config:created` / `project:created` / `project:deleted` listeners that follow in the same block must stay registered; keep them inside this `if (operatingMode === 'group')` block unchanged.

- [ ] **Step 4: Create the drop migration**

Create `migrations/025-drop-named-agents.sql`:

```sql
DROP TABLE IF EXISTS named_agents;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: PASS (all tests, including the two new/updated bootstrap tests).

Also confirm nothing else references the dropped table:

Run: `grep -rn "named_agents" packages/ suites/ --include="*.ts" | grep -v dist | grep -v __tests__`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add suites/notifications/services/telegram-bot.ts suites/notifications/__tests__/telegram-bot.test.ts suites/notifications/__tests__/helpers/test-db.ts migrations/025-drop-named-agents.sql
git commit -m "refactor(telegram)!: bootstrap agent topics from filesystem, drop named_agents table"
```

---

### Task 5: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: same failure set as before this plan (template-scheduler, config-history, template-integration, task-execution-engine, sse, knowledge-ingestion are pre-existing) — zero NEW failures. All agent/telegram/project-registry tests green.

- [ ] **Step 2: Lint/format gate**

Run: `npm run check`
If Prettier flags the new files: `npm run format`, re-run, amend.
Compare ESLint errors against master baseline — the changed files must contribute zero new errors.

- [ ] **Step 3: Build**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean.

- [ ] **Step 4: Boot smoke test**

Run: `RAVEN_PORT=4001 timeout 20 node packages/core/dist/index.js 2>&1 | head -40`
Expected: boot log shows `Named agent registry initialized` (or the new log line), migration `025-drop-named-agents` runs, no crash. (TickTick/Telegram MCP warnings are normal without env.)

Then: `curl -s http://localhost:4001/api/agents` is unavailable after timeout kills the process — instead run the boot in background if a live check is needed, or accept the log-based check.

- [ ] **Step 5: Push**

```bash
git push
```
