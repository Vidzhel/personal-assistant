import type { ProjectNode, ResolvedProjectContext, ProjectIndex, AgentYaml } from '@raven/shared';

import { scanProjects } from './project-scanner.ts';

export class ProjectRegistry {
  private index: ProjectIndex = { projects: new Map(), rootProjects: [] };

  async load(projectsDir: string): Promise<void> {
    this.index = await scanProjects(projectsDir);
  }

  getProject(id: string): ProjectNode | undefined {
    return this.index.projects.get(id);
  }

  findByName(name: string): ProjectNode | undefined {
    const lower = name.toLowerCase();
    for (const node of this.index.projects.values()) {
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
    return [...this.index.projects.values()].filter((p) => p.id !== '_global');
  }

  getProjectChildren(id: string): ProjectNode[] {
    const node = this.index.projects.get(id);
    if (!node) return [];
    return node.children
      .map((childId) => this.index.projects.get(childId))
      .filter((n): n is ProjectNode => n !== undefined);
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

      for (const agent of node.agents) {
        agents.set(agent.name, agent);
      }

      schedules.push(...node.schedules);
    }

    return { contextChain, agents, schedules };
  }

  private buildAncestorChain(projectId: string): ProjectNode[] {
    const chain: ProjectNode[] = [];
    let current = this.index.projects.get(projectId);

    while (current) {
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
}
