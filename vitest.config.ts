import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/core/vitest.config.ts',
      'packages/mcp-ticktick/vitest.config.ts',
    ],
  },
});
