# Project-Centric File Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DB-stored project/agent/schedule definitions with a filesystem-based project hierarchy where everything is git-committed, inheritable, and human-readable.

**Architecture:** A `projects/` directory becomes the source of truth. Each level (global, project, sub-project) can define `context.md`, `agents/*.yaml`, `templates/*.yaml`, and `schedules/*.yaml`. The system scans the filesystem on boot, builds an index, and serves it through existing APIs. DB retains only runtime state (sessions, tasks, metrics). Agent/project CRUD writes YAML/MD files, not DB rows.

**Tech Stack:** TypeScript ESM, Zod validation, YAML parsing (js-yaml), existing patterns from Phase 1 (library-loader, capability-library)

**Key constraint:** APIs must remain backward-compatible. Dashboard should continue working throughout migration. DB tables remain but become caches rebuilt from filesystem.

---

## File Structure

### New files to create:

```
projects/                                  # Source of truth for all projects
├── context.md                             # Global context
├── agents/
│   └── raven.yaml                         # Default agent (global)
├── templates/                             # Global templates
│   ├── email-triage.yaml                  # (moved from config/task-templates/)
│   └── research.yaml
├── schedules/
│   └── global-schedules.yaml              # (moved from config/schedules.json)
│
└── system/                                # Meta-project (replaces is_meta in DB)
    ├── context.md
    └── agents/
        └── system-admin.yaml

packages/shared/src/
├── types/
│   └── project-fs.ts                      # New: filesystem project types
└── project/
    └── schemas.ts                         # New: Zod schemas for agent/template/schedule YAML

packages/core/src/
└── project-registry/
    ├── project-scanner.ts                 # New: scans projects/ directory tree
    ├── project-registry.ts                # New: indexes projects, resolves inheritance
    ├── agent-yaml-store.ts                # New: reads/writes agent YAML files
    └── project-validator.ts               # New: validates project structure
```

### Files to modify:

```
packages/core/src/agent-registry/named-agent-store.ts  — reads from YAML via agent-yaml-store
packages/core/src/agent-registry/agent-resolver.ts     — resolve project-scoped agents
packages/core/src/api/routes/agents.ts                 — CRUD writes YAML files
packages/core/src/api/routes/projects.ts               — projects from filesystem
packages/core/src/orchestrator/orchestrator.ts          — project context inheritance
packages/core/src/index.ts                             — boot with project registry
packages/core/src/scheduler/scheduler.ts               — load from project schedules
packages/shared/src/types/agents.ts                    — add project scope to NamedAgent
packages/shared/src/types/projects.ts                  — add parentProjectId, filesystem fields
```

---

### Task 1: Define Project Filesystem Types and Schemas

**Files:**
- Create: `packages/shared/src/types/project-fs.ts`
- Create: `packages/shared/src/project/schemas.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/project-schemas.test.ts`

- [ ] **Step 1: Write the failing test for agent YAML schema**

```typescript
// packages/shared/src/__tests__/project-schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  AgentYamlSchema,
  ProjectContextSchema,
  ScheduleYamlSchema,
} from '../project/schemas.ts';

describe('AgentYamlSchema', () => {
  it('validates a valid agent YAML', () => {
    const result = AgentYamlSchema.safeParse({
      name: 'calculus-assistant',
      displayName: 'Calculus Assistant',
      description: 'Helps with calculus',
      skills: ['calendar-read', 'note-taking'],
      instructions: 'You help with calculus.\nAlways show your work.',
      model: 'sonnet',
      maxTurns: 15,
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults', () => {
    const result = AgentYamlSchema.parse({
      name: 'minimal',
      displayName: 'Minimal',
      description: 'A minimal agent',
      skills: [],
    });
    expect(result.model).toBe('sonnet');
    expect(result.maxTurns).toBe(15);
    expect(result.isDefault).toBe(false);
  });

  it('validates bash access config', () => {
    const result = AgentYamlSchema.safeParse({
      name: 'file-proc',
      displayName: 'File Processor',
      description: 'Processes files',
      skills: ['pdf'],
      bash: {
        access: 'sandboxed',
        allowedCommands: ['ffmpeg *'],
        allowedPaths: ['data/files/**'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid bash access level', () => {
    const result = AgentYamlSchema.safeParse({
      name: 'bad',
      displayName: 'Bad',
      description: 'Bad',
      skills: [],
      bash: { access: 'superuser' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ScheduleYamlSchema', () => {
  it('validates a schedule', () => {
    const result = ScheduleYamlSchema.safeParse({
      name: 'morning-briefing',
      cron: '30 7 * * *',
      timezone: 'Europe/Kyiv',
      template: 'morning-briefing',
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults', () => {
    const result = ScheduleYamlSchema.parse({
      name: 'test',
      cron: '0 * * * *',
      template: 'test-template',
    });
    expect(result.timezone).toBe('UTC');
    expect(result.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/project-schemas.test.ts`
Expected: FAIL

- [ ] **Step 3: Create schemas**

```typescript
// packages/shared/src/project/schemas.ts
import { z } from 'zod';

const KebabCaseRegex = /^[a-z][a-z0-9-]*$/;

export const BashAccessSchema = z.object({
  access: z.enum(['none', 'sandboxed', 'scoped', 'full']).default('none'),
  allowedCommands: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default([]),
  requireApproval: z.enum(['per-session', 'per-command']).optional(),
});

export const ValidationConfigSchema = z.object({
  evaluator: z.boolean().default(true),
  evaluatorModel: z.enum(['haiku', 'sonnet']).default('haiku'),
  qualityReview: z.boolean().default(false),
  qualityModel: z.enum(['sonnet', 'opus']).default('sonnet'),
  qualityThreshold: z.number().int().min(1).max(5).default(3),
  maxRetries: z.number().int().min(0).default(2),
}).optional();

export const AgentYamlSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  displayName: z.string().min(1),
  description: z.string().min(1),
  isDefault: z.boolean().default(false),

  skills: z.array(z.string()).default([]),
  instructions: z.string().optional(),

  model: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  maxTurns: z.number().int().positive().default(15),

  bash: BashAccessSchema.optional(),
  validation: ValidationConfigSchema,
});

export const ScheduleYamlSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  cron: z.string().min(1),
  timezone: z.string().default('UTC'),
  template: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});

export const ProjectContextSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  systemAccess: z.enum(['none', 'read', 'read-write']).default('none'),
});
```

- [ ] **Step 4: Create types file**

```typescript
// packages/shared/src/types/project-fs.ts
import type { z } from 'zod';
import type {
  AgentYamlSchema,
  BashAccessSchema,
  ValidationConfigSchema,
  ScheduleYamlSchema,
} from '../project/schemas.ts';

export type AgentYaml = z.infer<typeof AgentYamlSchema>;
export type BashAccess = z.infer<typeof BashAccessSchema>;
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
export type ScheduleYaml = z.infer<typeof ScheduleYamlSchema>;

export interface ProjectNode {
  id: string;                        // slug derived from path (e.g., "uni-spring-2026/calculus")
  name: string;                      // directory name
  displayName?: string;              // from context.md frontmatter if present
  description?: string;              // from context.md frontmatter
  path: string;                      // absolute filesystem path
  relativePath: string;              // relative to projects/ root
  parentId: string | null;           // parent project id, null for top-level
  systemAccess: 'none' | 'read' | 'read-write';
  isMeta: boolean;                   // true for projects/system/
  contextMd: string;                 // raw context.md content
  agents: AgentYaml[];               // agents defined at THIS level
  schedules: ScheduleYaml[];         // schedules defined at THIS level
  children: string[];                // child project IDs
}

export interface ResolvedProjectContext {
  contextChain: string[];            // context.md contents from root → leaf
  agents: Map<string, AgentYaml>;    // union of all agents (deeper overrides)
  schedules: ScheduleYaml[];         // union of all schedules
}

export interface ProjectIndex {
  projects: Map<string, ProjectNode>;
  rootProjects: string[];            // top-level project IDs (no parent)
}
```

- [ ] **Step 5: Export from shared index**

Add exports to `packages/shared/src/index.ts`:
```typescript
export { AgentYamlSchema, ScheduleYamlSchema, BashAccessSchema, ValidationConfigSchema } from './project/schemas.ts';
export type { AgentYaml, BashAccess, ScheduleYaml, ProjectNode, ProjectIndex, ResolvedProjectContext } from './types/project-fs.ts';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/__tests__/project-schemas.test.ts`
Expected: PASS

- [ ] **Step 7: Build and check**

Run: `npm run build -w packages/shared && npm run check`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/project/ packages/shared/src/types/project-fs.ts packages/shared/src/__tests__/project-schemas.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add project filesystem types and Zod schemas for agent YAML, schedules"
```

---

### Task 2: Build Project Scanner

**Files:**
- Create: `packages/core/src/project-registry/project-scanner.ts`
- Test: `packages/core/src/__tests__/project-scanner.test.ts`

This module scans the `projects/` directory tree and builds a `ProjectIndex`.

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/src/__tests__/project-scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProjects } from '../project-registry/project-scanner.ts';
import { dump } from 'js-yaml';

describe('scanProjects', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'raven-proj-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(tempDir, path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  it('scans a flat project structure', async () => {
    setup({
      'context.md': '# Global context',
      'project-a/context.md': '# Project A',
    });

    const index = await scanProjects(tempDir);
    expect(index.rootProjects).toContain('project-a');
    expect(index.projects.get('project-a')).toBeDefined();
    expect(index.projects.get('project-a')!.parentId).toBeNull();
  });

  it('scans nested sub-projects', async () => {
    setup({
      'context.md': '# Global',
      'uni/context.md': '# UNI',
      'uni/calculus/context.md': '# Calculus',
      'uni/physics/context.md': '# Physics',
    });

    const index = await scanProjects(tempDir);
    expect(index.rootProjects).toContain('uni');
    const uni = index.projects.get('uni')!;
    expect(uni.children).toContain('uni/calculus');
    expect(uni.children).toContain('uni/physics');

    const calc = index.projects.get('uni/calculus')!;
    expect(calc.parentId).toBe('uni');
  });

  it('loads agent YAML files', async () => {
    setup({
      'context.md': '# Global',
      'agents/raven.yaml': dump({
        name: 'raven', displayName: 'Raven', description: 'Default',
        skills: [], isDefault: true,
      }),
    });

    const index = await scanProjects(tempDir);
    // Global agents are on the root node
    const root = index.projects.get('_global')!;
    expect(root.agents).toHaveLength(1);
    expect(root.agents[0].name).toBe('raven');
  });

  it('loads schedule YAML files', async () => {
    setup({
      'context.md': '# Global',
      'schedules/morning.yaml': dump({
        name: 'morning-briefing', cron: '30 7 * * *',
        template: 'morning-briefing',
      }),
    });

    const index = await scanProjects(tempDir);
    const root = index.projects.get('_global')!;
    expect(root.schedules).toHaveLength(1);
    expect(root.schedules[0].cron).toBe('30 7 * * *');
  });

  it('identifies system/ as meta-project', async () => {
    setup({
      'context.md': '# Global',
      'system/context.md': '# System',
    });

    const index = await scanProjects(tempDir);
    const sys = index.projects.get('system')!;
    expect(sys.isMeta).toBe(true);
  });

  it('skips directories without context.md as non-project dirs', async () => {
    setup({
      'context.md': '# Global',
      'not-a-project/some-file.txt': 'just a file',
      'real-project/context.md': '# Real',
    });

    const index = await scanProjects(tempDir);
    expect(index.projects.has('not-a-project')).toBe(false);
    expect(index.projects.has('real-project')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/project-scanner.test.ts`

- [ ] **Step 3: Implement project-scanner.ts**

```typescript
// packages/core/src/project-registry/project-scanner.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createLogger, AgentYamlSchema, ScheduleYamlSchema } from '@raven/shared';
import type { ProjectNode, ProjectIndex, AgentYaml, ScheduleYaml } from '@raven/shared';
import { load as yamlLoad } from 'js-yaml';

const logger = createLogger('project-scanner');
const META_DIR_NAME = 'system';
const GLOBAL_ID = '_global';
const SKIP_DIRS = new Set(['agents', 'templates', 'schedules', 'node_modules', '.git']);

export async function scanProjects(projectsDir: string): Promise<ProjectIndex> {
  const projects = new Map<string, ProjectNode>();
  const rootProjects: string[] = [];

  // Load global context + agents + schedules
  const globalContext = await readContextMd(projectsDir);
  const globalAgents = await loadAgentYamls(join(projectsDir, 'agents'));
  const globalSchedules = await loadScheduleYamls(join(projectsDir, 'schedules'));

  projects.set(GLOBAL_ID, {
    id: GLOBAL_ID,
    name: '_global',
    path: projectsDir,
    relativePath: '',
    parentId: null,
    systemAccess: 'none',
    isMeta: false,
    contextMd: globalContext,
    agents: globalAgents,
    schedules: globalSchedules,
    children: [],
  });

  // Scan top-level directories
  const entries = await readdir(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const dirPath = join(projectsDir, entry.name);
    if (!await hasContextMd(dirPath)) continue;

    await scanProjectDir(dirPath, projectsDir, null, entry.name, projects, rootProjects);
  }

  // Set global children
  const globalNode = projects.get(GLOBAL_ID)!;
  globalNode.children = rootProjects;

  logger.info({ projects: projects.size, rootProjects: rootProjects.length }, 'projects scanned');
  return { projects, rootProjects };
}

async function scanProjectDir(
  dirPath: string,
  projectsRoot: string,
  parentId: string | null,
  projectId: string,
  projects: Map<string, ProjectNode>,
  rootProjects: string[],
): Promise<void> {
  const contextMd = await readContextMd(dirPath);
  const agents = await loadAgentYamls(join(dirPath, 'agents'));
  const schedules = await loadScheduleYamls(join(dirPath, 'schedules'));
  const dirName = dirPath.split('/').pop()!;

  const node: ProjectNode = {
    id: projectId,
    name: dirName,
    path: dirPath,
    relativePath: relative(projectsRoot, dirPath),
    parentId,
    systemAccess: 'none',
    isMeta: dirName === META_DIR_NAME && parentId === null,
    contextMd,
    agents,
    schedules,
    children: [],
  };

  projects.set(projectId, node);
  if (parentId === null) {
    rootProjects.push(projectId);
  } else {
    const parent = projects.get(parentId);
    if (parent) parent.children.push(projectId);
  }

  // Scan children
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const childPath = join(dirPath, entry.name);
    if (!await hasContextMd(childPath)) continue;
    const childId = `${projectId}/${entry.name}`;
    await scanProjectDir(childPath, projectsRoot, projectId, childId, projects, rootProjects);
  }
}

async function readContextMd(dirPath: string): Promise<string> {
  try {
    return await readFile(join(dirPath, 'context.md'), 'utf-8');
  } catch {
    return '';
  }
}

async function hasContextMd(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(join(dirPath, 'context.md'));
    return s.isFile();
  } catch {
    return false;
  }
}

async function loadAgentYamls(agentsDir: string): Promise<AgentYaml[]> {
  const agents: AgentYaml[] = [];
  try {
    const files = await readdir(agentsDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      try {
        const content = await readFile(join(agentsDir, file), 'utf-8');
        const raw = yamlLoad(content);
        const parsed = AgentYamlSchema.parse(raw);
        agents.push(parsed);
      } catch (err) {
        logger.warn({ file, err }, 'invalid agent YAML, skipping');
      }
    }
  } catch {
    // No agents directory — fine
  }
  return agents;
}

async function loadScheduleYamls(schedulesDir: string): Promise<ScheduleYaml[]> {
  const schedules: ScheduleYaml[] = [];
  try {
    const files = await readdir(schedulesDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      try {
        const content = await readFile(join(schedulesDir, file), 'utf-8');
        const raw = yamlLoad(content);
        const parsed = ScheduleYamlSchema.parse(raw);
        schedules.push(parsed);
      } catch (err) {
        logger.warn({ file, err }, 'invalid schedule YAML, skipping');
      }
    }
  } catch {
    // No schedules directory — fine
  }
  return schedules;
}
```

- [ ] **Step 4: Run test to verify passes**

Run: `npx vitest run packages/core/src/__tests__/project-scanner.test.ts`

- [ ] **Step 5: Build and check**

Run: `npm run build && npm run check`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/project-registry/project-scanner.ts packages/core/src/__tests__/project-scanner.test.ts
git commit -m "feat(core): add project scanner for filesystem-based project hierarchy"
```

---

### Task 3: Build Project Registry with Inheritance

**Files:**
- Create: `packages/core/src/project-registry/project-registry.ts`
- Test: `packages/core/src/__tests__/project-registry.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/src/__tests__/project-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { dump } from 'js-yaml';

describe('ProjectRegistry', () => {
  let tempDir: string;
  let registry: ProjectRegistry;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'raven-reg-test-'));
    registry = new ProjectRegistry();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(tempDir, path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  it('resolves context chain from root to leaf', async () => {
    setup({
      'context.md': '# Global context',
      'uni/context.md': '# UNI context',
      'uni/calculus/context.md': '# Calculus context',
    });
    await registry.load(tempDir);

    const resolved = registry.resolveProjectContext('uni/calculus');
    expect(resolved.contextChain).toHaveLength(3);
    expect(resolved.contextChain[0]).toContain('Global');
    expect(resolved.contextChain[1]).toContain('UNI');
    expect(resolved.contextChain[2]).toContain('Calculus');
  });

  it('inherits agents from parent levels', async () => {
    setup({
      'context.md': '# Global',
      'agents/raven.yaml': dump({
        name: 'raven', displayName: 'Raven', description: 'Default',
        skills: [], isDefault: true,
      }),
      'uni/context.md': '# UNI',
      'uni/agents/uni-coordinator.yaml': dump({
        name: 'uni-coordinator', displayName: 'UNI Coordinator',
        description: 'Academic coordinator', skills: ['calendar-read'],
      }),
      'uni/calculus/context.md': '# Calculus',
      'uni/calculus/agents/calc-helper.yaml': dump({
        name: 'calc-helper', displayName: 'Calc Helper',
        description: 'Calculus assistant', skills: ['note-taking'],
      }),
    });
    await registry.load(tempDir);

    const resolved = registry.resolveProjectContext('uni/calculus');
    // Should have all 3 agents: raven (global) + uni-coordinator (parent) + calc-helper (own)
    expect(resolved.agents.size).toBe(3);
    expect(resolved.agents.has('raven')).toBe(true);
    expect(resolved.agents.has('uni-coordinator')).toBe(true);
    expect(resolved.agents.has('calc-helper')).toBe(true);
  });

  it('deeper agent overrides same-name parent agent', async () => {
    setup({
      'context.md': '# Global',
      'agents/helper.yaml': dump({
        name: 'helper', displayName: 'Global Helper',
        description: 'Global version', skills: ['pdf'],
      }),
      'uni/context.md': '# UNI',
      'uni/agents/helper.yaml': dump({
        name: 'helper', displayName: 'UNI Helper',
        description: 'UNI version', skills: ['calendar-read'],
      }),
    });
    await registry.load(tempDir);

    const resolved = registry.resolveProjectContext('uni');
    expect(resolved.agents.get('helper')!.displayName).toBe('UNI Helper');
  });

  it('lists all projects as flat list', async () => {
    setup({
      'context.md': '# Global',
      'a/context.md': '# A',
      'b/context.md': '# B',
      'b/sub/context.md': '# B/Sub',
    });
    await registry.load(tempDir);

    const list = registry.listProjects();
    expect(list.length).toBe(3); // a, b, b/sub (not _global)
  });

  it('getProject returns a single project node', async () => {
    setup({
      'context.md': '# Global',
      'my-project/context.md': '# My Project',
    });
    await registry.load(tempDir);

    const proj = registry.getProject('my-project');
    expect(proj).toBeDefined();
    expect(proj!.name).toBe('my-project');
  });

  it('getProjectChildren returns direct children', async () => {
    setup({
      'context.md': '# Global',
      'parent/context.md': '# Parent',
      'parent/child-a/context.md': '# A',
      'parent/child-b/context.md': '# B',
    });
    await registry.load(tempDir);

    const children = registry.getProjectChildren('parent');
    expect(children).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

- [ ] **Step 3: Implement project-registry.ts**

```typescript
// packages/core/src/project-registry/project-registry.ts
import { createLogger } from '@raven/shared';
import type { ProjectNode, ProjectIndex, ResolvedProjectContext, AgentYaml, ScheduleYaml } from '@raven/shared';
import { scanProjects } from './project-scanner.ts';

const logger = createLogger('project-registry');
const GLOBAL_ID = '_global';

export class ProjectRegistry {
  private index: ProjectIndex | null = null;

  async load(projectsDir: string): Promise<void> {
    this.index = await scanProjects(projectsDir);
    logger.info({ projects: this.index.projects.size }, 'project registry loaded');
  }

  private ensureLoaded(): ProjectIndex {
    if (!this.index) throw new Error('ProjectRegistry not loaded');
    return this.index;
  }

  getProject(id: string): ProjectNode | undefined {
    return this.ensureLoaded().projects.get(id);
  }

  getGlobal(): ProjectNode {
    return this.ensureLoaded().projects.get(GLOBAL_ID)!;
  }

  listProjects(): ProjectNode[] {
    const idx = this.ensureLoaded();
    return [...idx.projects.values()].filter((p) => p.id !== GLOBAL_ID);
  }

  getProjectChildren(id: string): ProjectNode[] {
    const idx = this.ensureLoaded();
    const node = idx.projects.get(id);
    if (!node) return [];
    return node.children.map((cid) => idx.projects.get(cid)!).filter(Boolean);
  }

  /**
   * Resolve full context for a project, inheriting from parent chain.
   * Context chain: global → ... → parent → this project
   * Agents: union, deeper level overrides same-name
   * Schedules: union of all levels
   */
  resolveProjectContext(projectId: string): ResolvedProjectContext {
    const idx = this.ensureLoaded();
    const chain = this.getAncestorChain(projectId);

    const contextChain: string[] = [];
    const agents = new Map<string, AgentYaml>();
    const schedules: ScheduleYaml[] = [];

    for (const nodeId of chain) {
      const node = idx.projects.get(nodeId);
      if (!node) continue;

      if (node.contextMd) {
        contextChain.push(node.contextMd);
      }

      // Agents: deeper overrides same-name
      for (const agent of node.agents) {
        agents.set(agent.name, agent);
      }

      // Schedules: accumulate
      schedules.push(...node.schedules);
    }

    return { contextChain, agents, schedules };
  }

  /**
   * Get ancestor chain from global → ... → target
   */
  private getAncestorChain(projectId: string): string[] {
    const idx = this.ensureLoaded();
    const chain: string[] = [];
    let current = idx.projects.get(projectId);

    while (current) {
      chain.unshift(current.id);
      if (current.parentId) {
        current = idx.projects.get(current.parentId);
      } else if (current.id !== GLOBAL_ID) {
        chain.unshift(GLOBAL_ID);
        break;
      } else {
        break;
      }
    }

    return chain;
  }
}
```

- [ ] **Step 4: Run test to verify passes**

- [ ] **Step 5: Build, check, commit**

```bash
git add packages/core/src/project-registry/project-registry.ts packages/core/src/__tests__/project-registry.test.ts
git commit -m "feat(core): add project registry with inheritance resolution"
```

---

### Task 4: Create Agent YAML Store

**Files:**
- Create: `packages/core/src/project-registry/agent-yaml-store.ts`
- Test: `packages/core/src/__tests__/agent-yaml-store.test.ts`

Handles CRUD for agent YAML files — dashboard writes agents as YAML files on disk.

- [ ] **Step 1: Write failing test**

Tests for:
- `createAgent(projectId, agentYaml)` — writes YAML file to correct directory
- `updateAgent(projectId, agentName, updates)` — reads, merges, writes back
- `deleteAgent(projectId, agentName)` — removes YAML file
- Validates agent YAML with `AgentYamlSchema` before writing
- Creates `agents/` directory if it doesn't exist
- Rejects creating duplicate agent name in same scope

- [ ] **Step 2: Implement agent-yaml-store.ts**

```typescript
// packages/core/src/project-registry/agent-yaml-store.ts
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, AgentYamlSchema } from '@raven/shared';
import type { AgentYaml } from '@raven/shared';
import { dump, load as yamlLoad } from 'js-yaml';

const logger = createLogger('agent-yaml-store');

export interface AgentYamlStore {
  createAgent: (projectPath: string, agent: AgentYaml) => Promise<void>;
  updateAgent: (projectPath: string, agentName: string, updates: Partial<AgentYaml>) => Promise<AgentYaml>;
  deleteAgent: (projectPath: string, agentName: string) => Promise<void>;
}

export function createAgentYamlStore(): AgentYamlStore {
  return {
    async createAgent(projectPath, agent) {
      const validated = AgentYamlSchema.parse(agent);
      const agentsDir = join(projectPath, 'agents');
      await mkdir(agentsDir, { recursive: true });
      const filePath = join(agentsDir, `${validated.name}.yaml`);
      await writeFile(filePath, dump(validated, { lineWidth: 120 }), 'utf-8');
      logger.info({ agent: validated.name, path: filePath }, 'agent created');
    },

    async updateAgent(projectPath, agentName, updates) {
      const filePath = join(projectPath, 'agents', `${agentName}.yaml`);
      const content = await readFile(filePath, 'utf-8');
      const current = yamlLoad(content) as Record<string, unknown>;
      const merged = { ...current, ...updates, name: agentName }; // name is immutable
      const validated = AgentYamlSchema.parse(merged);
      await writeFile(filePath, dump(validated, { lineWidth: 120 }), 'utf-8');
      logger.info({ agent: agentName }, 'agent updated');
      return validated;
    },

    async deleteAgent(projectPath, agentName) {
      const filePath = join(projectPath, 'agents', `${agentName}.yaml`);
      await unlink(filePath);
      logger.info({ agent: agentName }, 'agent deleted');
    },
  };
}
```

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add agent YAML store for filesystem-based agent CRUD"
```

---

### Task 5: Create Initial projects/ Directory Structure

**Files:**
- Create: `projects/context.md`
- Create: `projects/agents/raven.yaml`
- Create: `projects/schedules/` (YAML files from config/schedules.json)
- Create: `projects/templates/` (move from config/task-templates/)
- Create: `projects/system/context.md`

- [ ] **Step 1: Create global context**

```markdown
<!-- projects/context.md -->
# Raven Personal Assistant

Global context for all projects. This file is loaded as the base context for every agent interaction.

## Guidelines

- Be concise and actionable in responses
- When creating tasks, always include deadlines if mentioned
- Use structured output for data summaries
- Save files to data/files/ or data/artifacts/ as appropriate
```

- [ ] **Step 2: Create default agent YAML from config/agents.json**

```yaml
# projects/agents/raven.yaml
name: raven
displayName: Raven
description: Default general-purpose personal assistant
isDefault: true
skills: []
model: sonnet
maxTurns: 20
```

- [ ] **Step 3: Convert config/schedules.json to YAML files**

Read `config/schedules.json` and create one YAML file per schedule group under `projects/schedules/`.

- [ ] **Step 4: Move task templates**

```bash
mkdir -p projects/templates
cp config/task-templates/*.yaml projects/templates/
```

- [ ] **Step 5: Create meta-project**

```markdown
<!-- projects/system/context.md -->
# Raven System Administration

System project with full read-write access. Used for managing Raven's configuration, running maintenance tasks, and system-level operations.
```

```yaml
# projects/system/agents/system-admin.yaml
name: system-admin
displayName: System Administrator
description: Full system access for configuration and maintenance
skills: []
model: sonnet
maxTurns: 20
bash:
  access: scoped
  allowedPaths:
    - "data/**"
    - "config/**"
    - "library/**"
    - "packages/**"
  deniedPaths:
    - ".env"
    - ".git/**"
```

- [ ] **Step 6: Commit**

```bash
git add projects/
git commit -m "feat: create initial projects/ directory structure with agents, schedules, templates"
```

---

### Task 6: Wire Project Registry into Boot Sequence

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/orchestrator/orchestrator.ts`

- [ ] **Step 1: Add project registry loading to boot**

In `index.ts`, after capability library loading, add:

```typescript
import { ProjectRegistry } from './project-registry/project-registry.ts';

const projectRegistry = new ProjectRegistry();
const projectsDir = resolve(projectRoot, 'projects');
try {
  await projectRegistry.load(projectsDir);
  logger.info('project registry loaded');
} catch (err) {
  logger.warn({ err }, 'project registry failed to load');
}
```

Pass to orchestrator and agent resolver.

- [ ] **Step 2: Update orchestrator to use project context**

In `handleUserChat`, after resolving the project, get the project context chain from the registry and inject it into the prompt:

```typescript
if (this.projectRegistry) {
  const resolved = this.projectRegistry.resolveProjectContext(projectId);
  const contextStr = resolved.contextChain.join('\n\n---\n\n');
  // Prepend to prompt or inject as context
}
```

- [ ] **Step 3: Build, test, commit**

```bash
git commit -m "feat(boot): wire project registry into boot sequence and orchestrator"
```

---

### Task 7: Update Projects API to Read from Filesystem

**Files:**
- Modify: `packages/core/src/api/routes/projects.ts`

- [ ] **Step 1: Add project registry to API deps**

The projects API currently reads from DB. Update to read from `ProjectRegistry` with fallback to DB.

`GET /api/projects` — list projects from registry (includes hierarchy info: parentId, children)
`GET /api/projects/:id` — get project from registry
`POST /api/projects` — create project directory + context.md on filesystem
`PUT /api/projects/:id` — update context.md
`DELETE /api/projects/:id` — remove project directory (with safety checks)

Add new endpoints:
`GET /api/projects/:id/children` — list sub-projects

- [ ] **Step 2: Add parentId to API responses**

Each project response now includes `parentId` and `children` arrays.

- [ ] **Step 3: Build, test, commit**

```bash
git commit -m "feat(api): update projects API to read from filesystem registry"
```

---

### Task 8: Update Agents API to Write YAML

**Files:**
- Modify: `packages/core/src/api/routes/agents.ts`
- Modify: `packages/core/src/agent-registry/named-agent-store.ts`

- [ ] **Step 1: Add project scope to agent creation**

`POST /api/agents` now accepts optional `projectPath` to specify where the agent YAML is created. If omitted, creates in `projects/agents/` (global).

- [ ] **Step 2: Agent CRUD writes YAML files**

Create agent → writes YAML via agent-yaml-store
Update agent → updates YAML file
Delete agent → removes YAML file

The named-agent-store becomes a read layer that builds from the project registry, rather than owning agent data.

- [ ] **Step 3: Reload project registry after changes**

After any CRUD operation, trigger `projectRegistry.load()` to refresh the index.

- [ ] **Step 4: Build, test, commit**

```bash
git commit -m "feat(api): update agents API to write YAML files on filesystem"
```

---

### Task 9: Build Project Validator

**Files:**
- Create: `packages/core/src/project-registry/project-validator.ts`
- Create: `scripts/validate-projects.ts`
- Modify: root `package.json` (add `validate:projects` script)

- [ ] **Step 1: Implement project-validator.ts**

Validates:
- Every project directory has `context.md`
- All agent YAMLs pass `AgentYamlSchema`
- All schedule YAMLs pass `ScheduleYamlSchema`
- Agent skills reference existing skills in the capability library
- No duplicate agent names within the same scope
- Max 3 levels deep (global → project → sub-project)
- `bash.access: full` only in global agents or system/ project
- `bash.deniedPaths` always includes `.env` and `.git/`

- [ ] **Step 2: Create CLI script**

```typescript
// scripts/validate-projects.ts
import { resolve } from 'node:path';
import { validateProjects } from '../packages/core/src/project-registry/project-validator.ts';

const projectsDir = resolve(import.meta.dirname, '..', 'projects');
const errors = await validateProjects(projectsDir);

if (errors.length === 0) {
  console.log('Project validation passed.');
  process.exit(0);
} else {
  console.error(`Project validation failed with ${errors.length} error(s):`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}
```

Add to `package.json`: `"validate:projects": "node --experimental-strip-types scripts/validate-projects.ts"`

- [ ] **Step 3: Run validation on real projects directory, fix issues**

- [ ] **Step 4: Build, test, commit**

```bash
git commit -m "feat: add project structure validator (npm run validate:projects)"
```

---

### Task 10: Integration Test — Full Project Resolution

**Files:**
- Create: `packages/core/src/__tests__/project-integration.test.ts`

- [ ] **Step 1: Write integration test using real projects/ directory**

Tests:
- Loads real `projects/` directory
- Validates project structure (zero errors)
- Resolves context for global level
- Finds default agent (raven) in global agents
- Lists all projects
- System project is identified as meta

- [ ] **Step 2: Run, fix issues, commit**

```bash
git commit -m "test: add integration test for real project hierarchy"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Build everything**

Run: `npm run build`

- [ ] **Step 2: Run all tests**

Run: `npm test`

- [ ] **Step 3: Run lint/format check**

Run: `npm run check`

- [ ] **Step 4: Run both validators**

Run: `npm run validate:library && npm run validate:projects`

- [ ] **Step 5: Commit any final fixes**

```bash
git commit -m "feat: complete Phase 2 — project-centric file structure with inheritance"
```

---

## Summary

After completing all 11 tasks:

- `projects/` directory is the source of truth for projects, agents, schedules, and templates
- Hierarchical structure with inheritance (global → project → sub-project)
- Agent definitions as YAML files (git-committed, diffable)
- Context chain resolves bottom-up for agent prompts
- Agents inherited from parent levels (deeper overrides same-name)
- Project CRUD creates/modifies filesystem (not just DB)
- Validation ensures structural integrity
- DB retains runtime state (sessions, tasks) but definitions come from filesystem
- Both old (DB-backed) and new (filesystem-backed) paths work during migration

**Next plan**: Phase 3 — Task Execution Engine (harness, validation gates, task-board protocol)
