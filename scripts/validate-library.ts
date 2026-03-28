import { resolve } from 'node:path';
import { validateLibrary } from '../packages/core/src/capability-library/library-validator.ts';

const libraryDir = resolve(import.meta.dirname, '..', 'library');

const errors = await validateLibrary(libraryDir);

if (errors.length === 0) {
  console.log('Library validation passed.');
  process.exit(0);
} else {
  console.error(`Library validation failed with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}
