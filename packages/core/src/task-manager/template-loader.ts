import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, type TaskTemplate, type RavenTask, TaskTemplateSchema } from '@raven/shared';
import type { TaskStore } from './task-store.ts';

const log = createLogger('template-loader');

export interface TemplateLoader {
  getTemplate: (name: string) => TaskTemplate | undefined;
  listTemplates: () => TaskTemplate[];
  createTaskFromTemplate: (
    templateName: string,
    overrides?: Partial<{
      title: string;
      description: string;
      prompt: string;
      assignedAgentId: string;
      projectId: string;
    }>,
  ) => RavenTask;
}

// eslint-disable-next-line max-lines-per-function -- factory with file loading, parsing, and CRUD methods
export function createTemplateLoader(deps: {
  templatesDir: string;
  taskStore: TaskStore;
}): TemplateLoader {
  const { templatesDir, taskStore } = deps;
  const templates = new Map<string, TaskTemplate>();

  function loadTemplates(): void {
    if (!existsSync(templatesDir)) {
      log.info(`Templates directory not found: ${templatesDir}`);
      return;
    }

    const files = readdirSync(templatesDir).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
    );

    for (const file of files) {
      try {
        const content = readFileSync(join(templatesDir, file), 'utf-8');
        const raw: unknown = parseYaml(content);
        const result = TaskTemplateSchema.safeParse(raw);

        if (!result.success) {
          log.warn(`Invalid template ${file}: ${result.error.message}`);
          continue;
        }

        templates.set(result.data.name, result.data);
        log.info(`Loaded template: ${result.data.name}`);
      } catch (err) {
        log.warn(`Failed to load template ${file}: ${err}`);
      }
    }
  }

  // Load on initialization
  loadTemplates();

  return {
    getTemplate(name: string): TaskTemplate | undefined {
      return templates.get(name);
    },

    listTemplates(): TaskTemplate[] {
      return [...templates.values()];
    },

    createTaskFromTemplate(templateName, overrides = {}): RavenTask {
      const template = templates.get(templateName);
      if (!template) throw new Error(`Template not found: ${templateName}`);

      return taskStore.createTask({
        title: overrides.title ?? template.title,
        description: overrides.description ?? template.description,
        prompt: overrides.prompt ?? template.prompt,
        assignedAgentId: overrides.assignedAgentId ?? template.defaultAgentId,
        projectId: overrides.projectId ?? template.projectId,
        source: 'template',
      });
    },
  };
}
