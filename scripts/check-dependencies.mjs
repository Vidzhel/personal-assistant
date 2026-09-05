import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Some npm 11 workspace resolutions silently ignore transitive overrides.
// Check both the committed resolution and what Transformers will actually load.
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const manifest = read(new URL('../package.json', import.meta.url));
const lock = read(new URL('../package-lock.json', import.meta.url));
const expected = manifest.overrides['@huggingface/transformers'].sharp;
const coreRequire = createRequire(new URL('../packages/core/package.json', import.meta.url));
const require = createRequire(coreRequire.resolve('@huggingface/transformers'));
const installed = require('sharp').versions.sharp;
assert.equal(
  installed,
  expected,
  'Transformers Sharp override was ignored; use the pinned npm version and reinstall',
);
const locked = Object.entries(lock.packages).filter(
  ([path]) => path.endsWith('/node_modules/sharp') || path === 'node_modules/sharp',
);
assert(locked.length > 0, 'Sharp missing from lockfile');
for (const [path, value] of locked) {
  const [major, minor] = value.version.split('.').map(Number);
  assert(major > 0 || minor >= 35, `${path} contains vulnerable Sharp ${value.version}`);
}
console.log(
  `Dependency override verified: Transformers loads Sharp ${expected}; all locked copies are patched`,
);
