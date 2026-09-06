import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { inspectMcpEntrypoint } from '../diagnostics/mcp-entrypoint.ts';

describe('static MCP script entrypoints', () => {
  it('checks script availability in the actual execution directory without running it', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-entrypoint-'));
    try {
      expect(
        inspectMcpEntrypoint('node', ['--experimental-strip-types', 'missing.ts'], root)[0],
      ).toMatchObject({ state: 'unavailable' });
      writeFileSync(
        join(root, 'server.mjs'),
        'throw new Error("Never execute readiness scripts");',
      );
      expect(inspectMcpEntrypoint('node', ['server.mjs'], root)[0]).toMatchObject({
        state: 'verified',
      });
      expect(inspectMcpEntrypoint('node', ['-e', 'code', 'output.js'], root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
