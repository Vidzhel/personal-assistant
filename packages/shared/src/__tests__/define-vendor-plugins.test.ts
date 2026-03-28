import { describe, it, expect } from 'vitest';
import { defineSuite } from '../suites/define.ts';

describe('defineSuite vendorPlugins', () => {
  it('accepts vendorPlugins array and includes it in resolved manifest', () => {
    const suite = defineSuite({
      name: 'test-suite',
      displayName: 'Test Suite',
      description: 'A test',
      capabilities: ['agent-definition'],
      vendorPlugins: ['anthropic-skills', 'ffmpeg-master'],
    });

    expect(suite.vendorPlugins).toEqual(['anthropic-skills', 'ffmpeg-master']);
  });

  it('defaults vendorPlugins to empty array when omitted', () => {
    const suite = defineSuite({
      name: 'test-suite',
      displayName: 'Test Suite',
      description: 'A test',
      capabilities: [],
    });

    expect(suite.vendorPlugins).toEqual([]);
  });
});
