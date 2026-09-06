import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const output = mkdtempSync(join(tmpdir(), 'raven-build-context-'));
const allowed = [
  /^(package(?:-lock)?\.json|tsconfig\.base\.json)$/,
  /^packages\/(shared|core|web)\/(package\.json|tsconfig\.json)$/,
  /^packages\/(shared|core|web)\/src\/.+$/,
  /^packages\/web\/(next\.config\.ts|postcss\.config\.mjs)$/,
  /^packages\/core\/scripts\/copy-build-assets\.mjs$/,
  /^migrations\/[^/]+\.sql$/,
  /^scripts\/smoke-compiled-core(?:-worker)?\.mjs$/,
  /^deployment\/(runtime-init|entrypoint|install-ticktick)\.mjs$/,
  /^deployment\/seeds\/.+$/,
];
const forbidden =
  /(^|\/)(\.env[^/]*|\.git|\.next|__tests__|node_modules|next-env\.d\.ts)(\/|$)|(?:\.test\.|\.spec\.|\.tsbuildinfo$)/;

function list(prefix = '') {
  return readdirSync(join(output, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink in build context: ${path}`);
    return entry.isDirectory() ? list(path) : [path];
  });
}

try {
  execFileSync('docker', ['build', '--file', '-', '--output', `type=local,dest=${output}`, '.'], {
    cwd: repoRoot,
    input: 'FROM scratch\nCOPY . /\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const files = list();
  assert(files.length > 0, 'Build context must contain deliberate source inputs');
  for (const required of [
    'deployment/entrypoint.mjs',
    'deployment/runtime-init.mjs',
    'deployment/install-ticktick.mjs',
    'deployment/seeds/library/mcps/ticktick.json',
    'deployment/seeds/library/skills/productivity/_index.md',
    'deployment/seeds/library/skills/productivity/task-management/_index.md',
    'deployment/seeds/library/skills/productivity/task-management/ticktick/config.json',
    'deployment/seeds/library/skills/productivity/task-management/ticktick/skill.md',
  ]) {
    assert(files.includes(required), `Build context is missing required setup input: ${required}`);
  }
  const invalid = files.filter(
    (path) => forbidden.test(path) || !allowed.some((rule) => rule.test(path)),
  );
  assert.deepEqual(invalid, [], 'Build context contains inputs outside the deployment allowlist');
  console.log(
    `Docker context verified: ${files.length} deliberate input files; no owner state or development artifacts.`,
  );
} finally {
  rmSync(output, { recursive: true, force: true });
}
