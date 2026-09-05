import type { ProjectNode, ResolvedProjectContext, ProjectIndex, AgentYaml } from '@raven/shared';

import { scanProjects } from './project-scanner.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

export interface ProjectRegistryOptions {
  /** Runtime mutation recovery can temporarily make a path unavailable. */
  getUnavailableProjectPaths?: () => readonly string[];
  /** Capability names are read at each reload so repaired bindings are fresh. */
  getKnownSkills?: () => ReadonlySet<string>;
}

export class ProjectRegistry {
  private index: ProjectIndex = { projects: new Map(), rootProjects: [] };
  private loadError?: unknown;
  private diagnostics: DefinitionDiagnostic[] = [];
  private invalidProjectPaths: string[] = [];

  private readonly options: ProjectRegistryOptions;

  constructor(options: ProjectRegistryOptions = {}) {
    this.options = options;
  }

  async load(
    projectsDir: string,
    options: { knownSkills?: ReadonlySet<string> } = {},
  ): Promise<void> {
    await withProjectMutation(projectsDir, async () => {
      try {
        const scanned = await scanProjects(projectsDir, {
          knownSkills: options.knownSkills ?? this.options.getKnownSkills?.(),
        });
        this.index = scanned;
        this.diagnostics = scanned.diagnostics;
        this.invalidProjectPaths = scanned.invalidProjectPaths;
        this.loadError = undefined;
      } catch (error) {
        this.loadError = error;
        this.diagnostics = [
          {
            source: 'project',
            path: 'context.md',
            code: 'project-root-unavailable',
            message: error instanceof Error ? error.message : String(error),
            severity: 'error',
          },
        ];
        throw error;
      }
    });
  }

  getDefinitionDiagnostics(): readonly DefinitionDiagnostic[] {
    return [...this.diagnostics];
  }

  getInvalidProjectPaths(): readonly string[] {
    return [...new Set([...this.invalidProjectPaths, ...this.unavailablePaths()])];
  }

  assertHealthy(): void {
    if (this.loadError) throw this.loadError;
    this.getGlobal();
  }

  getProject(id: string): ProjectNode | undefined {
    if (id !== '_global' && this.isUnavailable(id)) return undefined;
    return this.index.projects.get(id);
  }

  findByName(name: string): ProjectNode | undefined {
    const lower = name.toLowerCase();
    for (const node of this.index.projects.values()) {
      if (node.id !== '_global' && this.isUnavailable(node.id)) continue;
      if (node.name.toLowerCase() === lower) return node;
    }
    return undefined;
  }

  getGlobal(): ProjectNode {
    const global = this.index.projects.get('_global');
    if (!global) {
      throw new Error('Global project node not found — was load() called?');
    }
    return global;
  }

  listProjects(): ProjectNode[] {
    return [...this.index.projects.values()].filter(
      (p) => p.id !== '_global' && !this.isUnavailable(p.id),
    );
  }

  getProjectChildren(id: string): ProjectNode[] {
    if (id !== '_global' && this.isUnavailable(id)) return [];
    const node = this.index.projects.get(id);
    if (!node) return [];
    return node.children
      .map((childId) => this.index.projects.get(childId))
      .filter((n): n is ProjectNode => n !== undefined && !this.isUnavailable(n.id));
  }

  resolveProjectContext(projectId: string): ResolvedProjectContext {
    const chain = this.buildAncestorChain(projectId);

    const contextChain: string[] = [];
    const agents = new Map<string, AgentYaml>();
    const schedules: ResolvedProjectContext['schedules'] = [];

    for (const node of chain) {
      if (node.contextMd) {
        contextChain.push(node.contextMd);
      }
      if (node.metadata?.systemPrompt) contextChain.push(node.metadata.systemPrompt);

      for (const agent of node.agents) {
        agents.set(agent.name, agent);
      }

      schedules.push(...node.schedules);
    }

    return { contextChain, agents, schedules };
  }

  private buildAncestorChain(projectId: string): ProjectNode[] {
    if (projectId !== '_global' && this.isUnavailable(projectId)) {
      throw new Error(`Project definition is unavailable: ${projectId}`);
    }
    const chain: ProjectNode[] = [];
    const seen = new Set<string>();
    let current = this.index.projects.get(projectId);

    while (current) {
      if (seen.has(current.id)) throw new Error('Project hierarchy contains a cycle');
      seen.add(current.id);
      chain.unshift(current);
      if (current.parentId === null) break;
      current = this.index.projects.get(current.parentId);
    }

    // Ensure _global is always first if not already
    const global = this.index.projects.get('_global');
    if (global && (chain.length === 0 || chain[0].id !== '_global')) {
      chain.unshift(global);
    }

    return chain;
  }

  private unavailablePaths(): readonly string[] {
    return this.options.getUnavailableProjectPaths?.() ?? [];
  }

  private isUnavailable(id: string): boolean {
    const blocked = new Set([...this.invalidProjectPaths, ...this.unavailablePaths()]);
    return [...blocked].some((path) => path === '.' || id === path || id.startsWith(`${path}/`));
  }
}
