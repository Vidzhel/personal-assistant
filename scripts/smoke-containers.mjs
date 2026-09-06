import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const [coreImage, webImage] = process.argv.slice(2);
assert(coreImage && webImage, 'Usage: node scripts/smoke-containers.mjs CORE_IMAGE WEB_IMAGE');
const prefix = `raven-smoke-${randomUUID()}`;
const containers = [];
const volumes = [];
const workspaceRoot = mkdtempSync(join(tmpdir(), `${prefix}-workspace-`));
chmodSync(workspaceRoot, 0o777);

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

function shell(name, source) {
  return docker(['exec', name, 'bash', '-lc', source]);
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
    '--env',
    'GIT_CONFIG_NOSYSTEM=1',
    ...volumes.flatMap((volume, index) => [
      '--mount',
      `type=volume,source=${volume},target=/app/${['data', 'projects', 'library', 'config'][index]}`,
    ]),
    '--mount',
    `type=bind,source=${workspaceRoot},target=/workspace`,
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
  shell(
    first,
    `set -eu
for tool in bash git ssh curl python3 make g++ rg jq file unzip pdftotext pandoc ffmpeg; do
  command -v "$tool" >/dev/null
done
ffmpeg -version >/dev/null
pdftotext -v >/dev/null 2>&1
python3 -m venv /workspace/venv
/workspace/venv/bin/python -c 'import sys; assert sys.prefix != sys.base_prefix'
git init --bare /workspace/remote.git >/dev/null
git init --initial-branch=main /workspace/repo >/dev/null
git -C /workspace/repo config user.name 'Raven Smoke Test'
git -C /workspace/repo config user.email 'raven-smoke@localhost'
git -C /workspace/repo remote add origin /workspace/remote.git
printf '%s\\n' '# Привіт, Raven' > /workspace/repo/output.md
pandoc /workspace/repo/output.md --standalone --metadata=title:Raven -o /workspace/repo/report.html
git -C /workspace/repo add output.md report.html
git -C /workspace/repo -c commit.gpgsign=false commit -m 'test: unicode workspace artifact' >/dev/null
GIT_TERMINAL_PROMPT=0 git -C /workspace/repo push --set-upstream origin main >/dev/null
test "$(git -C /workspace/repo log -1 --format=%an)" = 'Raven Smoke Test'`,
  );
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
  assert(project.id && project.fsPath, 'Project creation must return id and fsPath');
  const source = JSON.parse(
    execute(
      first,
      `
    const response = await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/data-sources', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({uri:'/workspace/repo', label:'Smoke repository', sourceType:'folder'})
    });
    if (!response.ok) throw new Error(await response.text());
    console.log(JSON.stringify(await response.json()));
  `,
    ),
  );
  execute(
    first,
    `
    const response = await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/workspace', {
      method: 'PUT', headers: {'content-type':'application/json'},
      body: JSON.stringify({execution:{mode:'full',sourceId:${JSON.stringify(source.id)}}})
    });
    if (!response.ok) throw new Error(await response.text());
    const workspace = await response.json();
    if (workspace.execution.mode !== 'full' || workspace.execution.sourceId !== ${JSON.stringify(source.id)}) throw new Error('Workspace execution grant was not persisted');
  `,
  );
  execute(
    first,
    `
    import assert from 'node:assert/strict';
    const base = 'http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/files';
    const query = new URLSearchParams({sourceId:${JSON.stringify(source.id)},path:'report.html'});
    const infoResponse = await fetch(base + '/info?' + query);
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json();
    query.set('revision', info.revision);
    const content = await fetch(base + '/content?' + query);
    assert.equal(content.status, 200);
    assert((content.headers.get('content-security-policy') ?? '').includes('sandbox'));
    assert((await content.text()).includes('Привіт'));
  `,
  );
  // Verify durable definition content and history, not merely a .git directory.
  const durable = JSON.parse(
    execute(
      first,
      `
    import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const context = ${JSON.stringify(`projects/${project.fsPath}/context.md`)};
    const manifest = ${JSON.stringify(`projects/${project.fsPath}/project.yaml`)};
    const memory = ${JSON.stringify(`projects/${project.fsPath}/memory/container-smoke.md`)};
    mkdirSync('/app/' + memory.slice(0, memory.lastIndexOf('/')), {recursive:true});
    writeFileSync('/app/' + memory, '# Container memory sentinel');
    const git = (...args) => execFileSync('git', args, {cwd:'/app', encoding:'utf8'}).trim();
    git('add', '--', context, manifest, memory);
    try {
      git('diff', '--cached', '--quiet', '--', context, manifest, memory);
    } catch (error) {
      if (error.status !== 1) throw error;
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'test: container persistence', '--', context, manifest, memory);
    }
    const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\\n').filter(Boolean);
    for (const expected of [context, manifest, memory]) {
      if (!files.includes(expected)) throw new Error('Definition history is missing ' + expected);
    }
    if (files.some((file) => file.startsWith('workspace/'))) throw new Error('Attached repository entered definition history');
    console.log(JSON.stringify({head:git('rev-parse','HEAD'), context:readFileSync('/app/' + context,'utf8'), manifest, memory, files}));
  `,
    ),
  );
  const remote = join(workspaceRoot, 'remote.git');
  const hostGitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], {
    encoding: 'utf8',
    env: hostGitEnv,
  }).trim();
  const remoteArtifact = execFileSync(
    'git',
    ['--git-dir', remote, 'show', `${remoteHead}:output.md`],
    { encoding: 'utf8', env: hostGitEnv },
  );
  assert.equal(remoteArtifact, '# Привіт, Raven\n');
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
    const manifest = ${JSON.stringify(`projects/${project.fsPath}/project.yaml`)};
    const memory = ${JSON.stringify(`projects/${project.fsPath}/memory/container-smoke.md`)};
    assert.equal(readFileSync('/app/' + context,'utf8'), ${JSON.stringify(durable.context)});
    assert(readFileSync('/app/' + manifest,'utf8').includes('sourceId'));
    assert.equal(git('show','HEAD:' + context), ${JSON.stringify(durable.context.trim())});
    assert.equal(readFileSync('/app/' + memory,'utf8'), '# Container memory sentinel');
    assert.equal(git('show','HEAD:' + memory), '# Container memory sentinel');
    const workspace = await (await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/workspace')).json();
    assert.equal(workspace.execution.mode, 'full');
    assert.equal(workspace.execution.sourceId, ${JSON.stringify(source.id)});
    const listing = await (await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/files?sourceId=${encodeURIComponent(source.id)}')).json();
    const artifact = listing.entries.find((entry) => entry.path === 'output.md');
    assert(artifact, 'Restarted workspace listing should expose the repository artifact');
    const info = await (await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/files/info?sourceId=${encodeURIComponent(source.id)}&path=output.md')).json();
    assert.equal(info.size, Buffer.byteLength('# Привіт, Raven\\n'));
    const content = await (await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/files/content?sourceId=${encodeURIComponent(source.id)}&path=output.md&revision=' + encodeURIComponent(listing.revision))).text();
    assert.equal(content, '# Привіт, Raven\\n');
    const memoryResponse = await (await fetch('http://127.0.0.1:4001/api/projects/${encodeURIComponent(project.id)}/memory')).json();
    assert(memoryResponse.some((entry) => entry.file === 'container-smoke.md' && entry.content === '# Container memory sentinel'));
    const agent = await (await fetch('http://127.0.0.1:4001/api/agents/raven')).json();
    assert(agent.skills.includes('repository-work'), 'Default agent must bind repository-work');
  `,
  );
  const restartedRemoteHead = execFileSync(
    'git',
    ['--git-dir', remote, 'rev-parse', 'refs/heads/main'],
    { encoding: 'utf8', env: hostGitEnv },
  ).trim();
  assert.equal(restartedRemoteHead, remoteHead);
  const web = `${prefix}-web`;
  containers.push(web);
  docker(['run', '--detach', '--name', web, '--network', 'none', webImage]);
  await waitFor(web, 'http://127.0.0.1:4000/projects');
  // Exercise the deployed standalone server's static asset location too.
  execute(
    web,
    `
    import assert from 'node:assert/strict';
    import { readdirSync } from 'node:fs';
    const html = await (await fetch('http://127.0.0.1:4000/projects')).text();
    const asset = html.match(new RegExp('src="([^" ]*/_next/static/[^" ]+)"'));
    assert(asset, 'Page should reference a Next static asset');
    const response = await fetch(new URL(asset[1], 'http://127.0.0.1:4000'));
    assert.equal(response.status, 200);
    const media = readdirSync('/app/packages/web/.next/static/media');
    const worker = media.find((name) => /^pdf\\.worker\\..+\\.mjs$/.test(name));
    assert(worker, 'Bundled PDF worker is missing');
    const workerResponse = await fetch('http://127.0.0.1:4000/_next/static/media/' + encodeURIComponent(worker));
    assert.equal(workerResponse.status, 200);
    assert((workerResponse.headers.get('content-type') ?? '').includes('javascript'));
  `,
  );
  docker(['stop', '--time', '20', restarted]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', restarted]), '0');
  console.log(
    `Container smoke passed: offline core boot, ${workspaceRoot}/repo/output.md, /app/projects/${project.fsPath}/memory/container-smoke.md, persisted Git history, standalone page and PDF worker asset.`,
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
  rmSync(workspaceRoot, { recursive: true, force: true });
}
