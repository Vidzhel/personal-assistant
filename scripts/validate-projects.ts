import { resolve } from 'node:path';

import { validateProjects } from '../packages/core/src/project-registry/project-validator.ts';

const projectsDir = resolve(import.meta.dirname!, '..', 'projects');
const result = await validateProjects(projectsDir);

if (result.warnings.length > 0) {
  for (const warn of result.warnings) console.warn(`  ⚠  ${warn}`);
}

if (result.errors.length === 0) {
  console.log('Project validation passed.');
  process.exit(0);
} else {
  console.error(`Project validation failed with ${result.errors.length} error(s):`);
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}
