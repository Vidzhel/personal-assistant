import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mcp-ticktick',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
