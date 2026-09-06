#!/usr/bin/env bash
# Check production TypeScript without importing it or starting the assistant.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

node --input-type=module <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

let count = 0;
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (entry.isFile() && path.endsWith('.ts') && !/\.(d|test|spec)\.ts$/.test(path)) {
      stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip', sourceUrl: path });
      count++;
    }
  }
}
for (const workspace of ['shared', 'core']) {
  check(`packages/${workspace}/src`);
}
console.log(`strip-types compatibility passed: ${count} production files; no code executed.`);
NODE
