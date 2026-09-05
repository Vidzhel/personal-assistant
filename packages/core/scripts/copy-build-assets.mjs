import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../../../migrations');
const target = resolve(import.meta.dirname, '../dist/migrations');
const files = readdirSync(source)
  .filter((file) => file.endsWith('.sql'))
  .sort();
if (files.length === 0) throw new Error('Core build requires the canonical SQL migrations');

// Replace only this generated directory, so removed SQL files cannot linger in dist.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(resolve(source, file), resolve(target, file));
console.log(`Packaged ${files.length} SQL migrations in core/dist/migrations`);
