import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, type TaskTemplate, TaskTemplateSchema } from '@raven/shared';

const logger = createLogger('template-loader');

/**
 * Loads all task templates from `.yaml` / `.yml` files in the given directory.
 * Invalid files are skipped with a warning. Non-existent directories return
 * an empty map.
 */
export async function loadTemplatesFromDir(dir: string): Promise<Map<string, TaskTemplate>> {
  const templates = new Map<string, TaskTemplate>();

  let entries: string[];
  try {
    const dirEntries = await readdir(dir);
    entries = dirEntries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    logger.warn(`Template directory not found: ${dir}, returning empty map`);
    return templates;
  }

  for (const file of entries) {
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      const template = TaskTemplateSchema.parse(parsed);
      if (templates.has(template.name)) {
        logger.warn(`Duplicate template name "${template.name}" in ${file}, overwriting previous`);
      }
      templates.set(template.name, template);
      logger.info(`Loaded template: ${template.name} (${file})`);
    } catch (err) {
      logger.warn(`Skipping invalid template file ${file}: ${err}`);
    }
  }

  return templates;
}
