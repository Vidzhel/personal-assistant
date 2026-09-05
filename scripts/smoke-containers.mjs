import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [coreImage, webImage] = process.argv.slice(2);
assert(coreImage && webImage, 'Usage: node scripts/smoke-containers.mjs CORE_IMAGE WEB_IMAGE');
const prefix = `raven-smoke-${randomUUID()}`;
const containers = [];
const volumes = [];

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function execute(name, source) {
  return docker(['exec', name, 'node', '--input-type=module', '-e', source]);
}

async function waitFor(name, url) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      execute(
        name,
        `const response = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) throw new Error(String(response.status));`,
      );
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`Container ${name} did not become ready`, { cause: lastError });
}

function createCore(name) {
  containers.push(name);
  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'none',
    '--env',
    'NEO4J_ENABLED=false',
    '--env',
    'NODE_ENV=production',
    ...volumes.flatMap((volume, index) => [
      '--mount',
      `type=volume,source=${volume},target=/app/${['data', 'projects', 'library', 'config'][index]}`,
    ]),
    coreImage,
  ]);
}

try {
  for (const root of ['data', 'projects', 'library', 'config']) {
    const name = `${prefix}-${root}`;
    docker(['volume', 'create', name]);
    volumes.push(name);
  }
  const first = `${prefix}-core-first`;
  createCore(first);
  await waitFor(first, 'http://127.0.0.1:4001/api/health');
  const project = JSON.parse(
    execute(
      first,
      `
    import assert from 'node:assert/strict';
    const health = await (await fetch('http://127.0.0.1:4001/api/health')).json();
    assert.equal(health.knowledge, 'unavailable');
    assert(health.services.loaded > 0);
    const response = await fetch('http://127.0.0.1:4001/api/projects', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({name:'Container persistence check', description:'Disposable fixture'})
    });
    assert.equal(response.status, 200);
    console.log(JSON.stringify(await response.json()));
  `,
    ),
  );
  // Verify durable definition content and history, not merely a .git directory.
  const durable = JSON.parse(
    execute(
      first,
      `
    import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const context = ${JSON.stringify(`projects/${project.fsPath}/context.md`)};
    const memory = 'projects/agents/raven/memory/container-smoke.md';
    mkdirSync('/app/projects/agents/raven/memory', {recursive:true});
    writeFileSync('/app/' + memory, '# Container memory sentinel');
    const git = (...args) => execFileSync('git', args, {cwd:'/app', encoding:'utf8'}).trim();
    git('add', '--', context, memory);
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'test: container persistence', '--', context, memory);
    console.log(JSON.stringify({head:git('rev-parse','HEAD'), context:readFileSync('/app/' + context,'utf8')}));
  `,
    ),
  );
  docker(['stop', '--time', '20', first]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', first]), '0');

  const restarted = `${prefix}-core-restarted`;
  createCore(restarted);
  await waitFor(restarted, 'http://127.0.0.1:4001/api/health');
  execute(
    restarted,
    `
    import assert from 'node:assert/strict';
    const response = await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, 'Container persistence check');
    const {readFileSync} = await import('node:fs');
    const {execFileSync} = await import('node:child_process');
    const git = (...args) => execFileSync('git', args, {cwd:'/app', encoding:'utf8'}).trim();
    assert.equal(git('rev-parse','HEAD'), ${JSON.stringify(durable.head)});
    const context = ${JSON.stringify(`projects/${project.fsPath}/context.md`)};
    assert.equal(readFileSync('/app/' + context,'utf8'), ${JSON.stringify(durable.context)});
    assert.equal(git('show','HEAD:' + context), ${JSON.stringify(durable.context.trim())});
    const memory = 'projects/agents/raven/memory/container-smoke.md';
    assert.equal(readFileSync('/app/' + memory,'utf8'), '# Container memory sentinel');
    assert.equal(git('show','HEAD:' + memory), '# Container memory sentinel');
  `,
  );
  const web = `${prefix}-web`;
  containers.push(web);
  docker(['run', '--detach', '--name', web, '--network', 'none', webImage]);
  await waitFor(web, 'http://127.0.0.1:4000/projects');
  // Exercise the deployed standalone server's static asset location too.
  execute(
    web,
    `
    import assert from 'node:assert/strict';
    const html = await (await fetch('http://127.0.0.1:4000/projects')).text();
    const asset = html.match(new RegExp('src="([^" ]*/_next/static/[^" ]+)"'));
    assert(asset, 'Page should reference a Next static asset');
    const response = await fetch(new URL(asset[1], 'http://127.0.0.1:4000'));
    assert.equal(response.status, 200);
  `,
  );
  docker(['stop', '--time', '20', restarted]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', restarted]), '0');
  console.log(
    'Container smoke passed: offline core boot, persisted project/memory/Git history, standalone page and asset.',
  );
} catch (error) {
  for (const name of containers) {
    try {
      console.error(docker(['logs', '--tail', '60', name]));
    } catch {
      /* container may not exist */
    }
  }
  throw error;
} finally {
  for (const name of containers.reverse()) {
    try {
      docker(['rm', '--force', name]);
    } catch {
      /* preserve the original failure */
    }
  }
  for (const name of volumes.reverse()) {
    try {
      docker(['volume', 'rm', name]);
    } catch {
      /* preserve the original failure */
    }
  }
}
