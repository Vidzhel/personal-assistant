import { resolve } from 'node:path';

import { validateProjects } from '../packages/core/src/project-registry/project-validator.ts';

const projectsDir = resolve(import.meta.dirname!, '..', 'projects');
const errors = await validateProjects(projectsDir);

if (errors.length === 0) {
  console.log('Project validation passed.');
  process.exit(0);
} else {
  console.error(`Project validation failed with ${errors.length} error(s):`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}
