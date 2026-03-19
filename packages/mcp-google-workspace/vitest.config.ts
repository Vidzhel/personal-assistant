import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mcp-google-workspace',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
