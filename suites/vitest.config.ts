import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@raven/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      '@raven/core': resolve(__dirname, '../packages/core/src'),
    },
  },
});
