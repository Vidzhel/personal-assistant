import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Explicit opt-in: downloads the public BGE model into a disposable cache.
// Child processes inherit no owner credentials, model cache or Raven settings.
const scriptPath = fileURLToPath(import.meta.url);
const [mode, root] = process.argv.slice(2);

if (mode === 'online' || mode === 'offline') {
  assert(root, 'A temporary fixture root is required');
  const { env, RawImage } = await import('@huggingface/transformers');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.resolve('@huggingface/transformers'));
  const sharp = require('sharp');
  assert.equal(sharp.versions.sharp, '0.35.4');
  assert(sharp.versions.vips.localeCompare('8.18.3', undefined, { numeric: true }) >= 0);
  env.cacheDir = join(root, 'models');
  // Offline cache reads require local lookup enabled; its fallback root is also
  // disposable, so an unrelated model in the owner's tree can never satisfy it.
  env.allowLocalModels = mode === 'offline';
  env.localModelPath = join(root, 'local-models');
  env.allowRemoteModels = mode === 'online';
  env.useBrowserCache = false;
  const { getPipeline, buildQueryEmbeddingInput } =
    await import('../packages/core/dist/knowledge-engine/embeddings.js');
  const pipe = await getPipeline();
  try {
    const input = buildQueryEmbeddingInput('Prepare the next university teaching lesson.');
    const options = { pooling: 'mean', normalize: true };
    const first = Array.from((await pipe(input, options)).data);
    const repeated = Array.from((await pipe(input, options)).data);
    const other = Array.from(
      (await pipe(buildQueryEmbeddingInput('Bake a chocolate cake.'), options)).data,
    );
    assert.equal(first.length, 384);
    assert(first.every(Number.isFinite));
    assert(Math.abs(Math.hypot(...first) - 1) < 0.001);
    assert(first.every((value, index) => Math.abs(value - repeated[index]) < 0.00001));
    assert(first.some((value, index) => Math.abs(value - other[index]) > 0.01));
  } finally {
    await pipe.dispose();
  }

  // Exercise the actual Transformers→Sharp adapter with synthetic local pixels.
  const pixels = new Uint8ClampedArray(4 * 4 * 3).fill(127);
  const original = new RawImage(pixels, 4, 4, 3);
  const filename = join(root, `synthetic-${mode}.png`);
  await original.save(filename);
  const decoded = await RawImage.read(filename);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);
  const resized = await decoded.resize(8, 8);
  assert.equal(resized.width, 8);
  const bilinear = await decoded.resize(6, 6, { resample: 'bilinear' });
  assert.equal(bilinear.width, 6);
  const cropped = await resized.crop([1, 1, 5, 5]);
  assert(cropped.width > 0 && cropped.width < resized.width);
  const padded = await cropped.pad([1, 1, 1, 1]);
  assert.equal(padded.width, cropped.width + 2);
  console.log(
    `${mode}: BGE fp32 384-value normalized/repeatable embeddings and Sharp ${sharp.versions.sharp}/libvips ${sharp.versions.vips} adapter passed`,
  );
} else {
  assert.equal(process.argv.length, 2, 'Usage: npm run test:embeddings:download');
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'raven-embedding-smoke-'));
  try {
    for (const phase of ['online', 'offline']) {
      const result = await promisify(execFile)(process.execPath, [scriptPath, phase, fixtureRoot], {
        cwd: fixtureRoot,
        env: { PATH: process.env.PATH, TMPDIR: fixtureRoot, NODE_ENV: 'test' },
        timeout: 240_000,
        maxBuffer: 1024 * 1024,
      });
      process.stdout.write(result.stdout);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
