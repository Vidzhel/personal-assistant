import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { createLogger } from '@raven/shared';
import type { TaskTemplate } from '@raven/shared';

import { loadTemplatesFromDir } from './template-loader.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

const logger = createLogger('template-registry');

interface TemplateEntry {
  template: TaskTemplate;
  projectPath: string;
}

/**
 * Registry that loads task templates from the project hierarchy.
 *
 * Templates at deeper project levels override same-name templates from parent
 * levels, following the same inheritance pattern as agents in ProjectRegistry.
 */
export class TemplateRegistry {
  /** Global templates (from {projectsDir}/templates/) */
  private globalTemplates = new Map<string, TemplateEntry>();

  /** Per-project templates, keyed by projectId (relative path or '_global') */
  private projectTemplates = new Map<string, Map<string, TemplateEntry>>();

  /** Map of projectId → parentId for scope resolution */
  private parentMap = new Map<string, string | null>();
  private diagnostics: DefinitionDiagnostic[] = [];

  async load(projectsDir: string): Promise<void> {
    const candidate = new TemplateRegistry();
    try {
      await candidate.loadCurrent(projectsDir);
      this.globalTemplates = candidate.globalTemplates;
      this.projectTemplates = candidate.projectTemplates;
      this.parentMap = candidate.parentMap;
      this.diagnostics = candidate.diagnostics;
    } catch (error) {
      this.diagnostics = [
        {
          source: 'template',
          path: '.',
          code: 'template-root-unavailable',
          message: `Cannot load templates: ${String(error)}`,
          severity: 'error',
        },
      ];
      throw error;
    }
  }

  getDefinitionDiagnostics(): readonly DefinitionDiagnostic[] {
    return [...this.diagnostics];
  }

  private async loadCurrent(projectsDir: string): Promise<void> {
    // 1. Load global templates
    const globalDir = join(projectsDir, 'templates');
    const globalMap = await this.loadDirectory(globalDir, projectsDir);
    for (const [name, template] of globalMap) {
      this.globalTemplates.set(name, { template, projectPath: projectsDir });
    }
    this.projectTemplates.set('_global', new Map(this.globalTemplates));
    this.parentMap.set('_global', null);

    logger.info(`Loaded ${globalMap.size} global templates`);

    // 2. Walk project directories
    await this.scanDir(projectsDir, '_global', projectsDir);
  }

  private loadDirectory(dir: string, root: string): Promise<Map<string, TaskTemplate>> {
    return loadTemplatesFromDir(dir, (diagnostic) => {
      this.diagnostics.push({ ...diagnostic, path: relative(root, diagnostic.path) || '.' });
    });
  }

  getTemplate(name: string, projectId?: string): TaskTemplate | undefined {
    if (!projectId) {
      const entry = this.globalTemplates.get(name);
      return entry?.template;
    }

    // Walk from the project up to parents, then global
    let currentId: string | null | undefined = projectId;
    while (currentId != null) {
      const scopeMap = this.projectTemplates.get(currentId);
      if (scopeMap) {
        const entry = scopeMap.get(name);
        if (entry) return entry.template;
      }
      currentId = this.parentMap.get(currentId) ?? null;
      if (currentId === null) break;
    }

    // Fall back to global
    const entry = this.globalTemplates.get(name);
    return entry?.template;
  }

  listTemplates(projectId?: string): TaskTemplate[] {
    if (!projectId) {
      return [...this.globalTemplates.values()].map((e) => e.template);
    }

    // Collect templates from all ancestor scopes, deeper overrides shallower
    const merged = new Map<string, TaskTemplate>();

    // Build ancestor chain (from root to leaf)
    const chain: string[] = [];
    let currentId: string | null | undefined = projectId;
    while (currentId != null) {
      chain.unshift(currentId);
      currentId = this.parentMap.get(currentId) ?? null;
      if (currentId === null) break;
    }

    // Apply global first
    for (const [name, entry] of this.globalTemplates) {
      merged.set(name, entry.template);
    }

    // Then apply each level in order (root → leaf), so deeper overrides
    for (const scopeId of chain) {
      const scopeMap = this.projectTemplates.get(scopeId);
      if (scopeMap) {
        for (const [name, entry] of scopeMap) {
          merged.set(name, entry.template);
        }
      }
    }

    return [...merged.values()];
  }

  getAllTemplates(): TaskTemplate[] {
    const seen = new Map<string, TaskTemplate>();
    for (const scopeMap of this.projectTemplates.values()) {
      for (const [name, entry] of scopeMap) {
        seen.set(name, entry.template);
      }
    }
    return [...seen.values()];
  }

  private async scanDir(dirPath: string, parentId: string, projectsDir: string): Promise<void> {
    const SKIP_DIRS = new Set([
      'agents',
      'templates',
      'schedules',
      'tasks',
      'node_modules',
      '.git',
    ]);

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (dirPath === projectsDir) throw error;
      this.diagnostics.push({
        source: 'template',
        path: relative(projectsDir, dirPath),
        code: 'template-project-unreadable',
        message: `Cannot inspect project templates: ${String(error)}`,
        severity: 'error',
      });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const childPath = join(dirPath, entry.name);
      const rel = relative(projectsDir, childPath);
      const projectId = rel || '_global';

      // Check if this is a project (has context.md)
      const hasContext = await this.fileExists(join(childPath, 'context.md'));
      if (!hasContext) continue;

      // Load templates for this project scope
      const templatesDir = join(childPath, 'templates');
      const templateMap = await this.loadDirectory(templatesDir, projectsDir);

      const scopeEntries = new Map<string, TemplateEntry>();
      for (const [name, template] of templateMap) {
        scopeEntries.set(name, { template, projectPath: childPath });
      }

      this.projectTemplates.set(projectId, scopeEntries);
      this.parentMap.set(projectId, parentId);

      logger.info(`Loaded ${templateMap.size} templates for project: ${projectId}`);

      // Recurse into subdirectories
      await this.scanDir(childPath, projectId, projectsDir);
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
}
