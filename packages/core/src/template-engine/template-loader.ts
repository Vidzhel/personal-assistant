import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, type TaskTemplate, TaskTemplateSchema } from '@raven/shared';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

const logger = createLogger('template-loader');

async function listTemplates(
  dir: string,
  report?: (diagnostic: DefinitionDiagnostic) => void,
): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => /\.ya?ml$/.test(file)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report?.({
        source: 'template',
        path: dir,
        code: 'template-directory-unreadable',
        message: `Cannot read templates: ${String(error)}`,
        severity: 'error',
      });
    }
    return [];
  }
}

/**
 * Loads all task templates from `.yaml` / `.yml` files in the given directory.
 * Invalid files are skipped with a warning. Non-existent directories return
 * an empty map.
 */
export async function loadTemplatesFromDir(
  dir: string,
  report?: (diagnostic: DefinitionDiagnostic) => void,
): Promise<Map<string, TaskTemplate>> {
  const templates = new Map<string, TaskTemplate>();

  for (const file of await listTemplates(dir, report)) {
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      const template = TaskTemplateSchema.parse(parsed);
      if (templates.has(template.name)) {
        report?.({
          source: 'template',
          path: filePath,
          code: 'duplicate-template-name',
          message: `Duplicate template name "${template.name}"; this later file overrides the earlier definition`,
          severity: 'warning',
        });
      }
      templates.set(template.name, template);
      logger.info(`Loaded template: ${template.name} (${file})`);
    } catch (err) {
      report?.({
        source: 'template',
        path: filePath,
        code: 'invalid-template-definition',
        message: `Invalid template: ${String(err)}`,
        severity: 'error',
      });
      logger.warn(`Skipping invalid template file ${file}: ${err}`);
    }
  }

  return templates;
}
