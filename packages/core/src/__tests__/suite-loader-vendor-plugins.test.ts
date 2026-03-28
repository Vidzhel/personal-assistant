import { describe, it, expect } from 'vitest';
import { resolveVendorPlugins } from '../suite-registry/suite-loader.ts';

describe('resolveVendorPlugins', () => {
  it('resolves vendor plugin names to absolute paths', () => {
    const result = resolveVendorPlugins(
      ['anthropic-skills', 'ffmpeg-master'],
      '/project/vendor',
    );

    expect(result).toEqual([
      { type: 'local', path: '/project/vendor/anthropic-skills' },
      { type: 'local', path: '/project/vendor/ffmpeg-master' },
    ]);
  });

  it('returns empty array for no vendor plugins', () => {
    const result = resolveVendorPlugins([], '/project/vendor');
    expect(result).toEqual([]);
  });
});
