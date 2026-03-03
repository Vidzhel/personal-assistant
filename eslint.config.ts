import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/.next/',
      'scripts/',
      'data/',
      '*.config.*',
      '*.json',
    ],
  },

  // Base recommended rules
  eslint.configs.recommended,

  // Strict TypeScript rules
  ...tseslint.configs.strict,

  // Disable formatting rules (Prettier handles those)
  eslintConfigPrettier,

  // Shared/core/skills: Node globals
  {
    files: ['packages/shared/src/**/*.ts', 'packages/core/src/**/*.ts', 'packages/skills/*/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Web: browser + node globals
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // All TypeScript files: custom rules
  {
    files: ['packages/*/src/**/*.ts', 'packages/skills/*/src/**/*.ts', 'packages/web/**/*.{ts,tsx}'],
    rules: {
      // Ban .js extensions in imports — use .ts instead
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in imports.',
        },
        {
          selector: 'ExportNamedDeclaration[source.value=/\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in exports.',
        },
        {
          selector: 'ExportAllDeclaration[source.value=/\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in exports.',
        },
      ],

      // Enforce type safety
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused vars with _ prefix exception
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Use Pino logger, not console
      'no-console': 'warn',
    },
  },

  // Relaxed rules for test files
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
