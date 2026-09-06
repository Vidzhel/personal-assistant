import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = vi.hoisted(() => vi.fn(async () => vi.fn()));

vi.mock('@huggingface/transformers', () => ({ pipeline }));

import { getPipeline, resetPipeline } from '../knowledge-engine/embeddings.ts';

describe('embedding model cache', () => {
  beforeEach(() => {
    pipeline.mockClear();
    resetPipeline();
  });

  it('passes the runtime-owned cache directory to Transformers.js', async () => {
    const cacheDir = '/tmp/raven-data/models/transformers';

    await getPipeline(cacheDir);

    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/bge-small-en-v1.5', {
      dtype: 'fp32',
      cache_dir: cacheDir,
    });
  });
});
