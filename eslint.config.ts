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
    files: ['packages/shared/src/**/*.ts', 'packages/core/src/**/*.ts', 'packages/skills/*/src/**/*.ts', 'packages/mcp-ticktick/src/**/*.ts'],
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

  // Type-checked linting for shared + core (mcp-ticktick/web too heavy for typed linting)
  {
    files: [
      'packages/shared/src/**/*.ts',
      'packages/core/src/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: [
          './packages/shared/tsconfig.json',
          './packages/core/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // All TypeScript files: custom rules (NO projectService here)
  {
    files: ['packages/*/src/**/*.ts', 'packages/skills/*/src/**/*.ts', 'packages/web/**/*.{ts,tsx}'],
    rules: {
      // Ban .js extensions in imports — use .ts instead
      // Ban TS parameter properties — not supported by Node strip-types
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/^\\..*\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in imports.',
        },
        {
          selector: 'ExportNamedDeclaration[source.value=/^\\..*\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in exports.',
        },
        {
          selector: 'ExportAllDeclaration[source.value=/^\\..*\\.js[\'"]?$/]',
          message: 'Use .ts extension instead of .js in exports.',
        },
        {
          selector: 'TSParameterProperty',
          message: 'Parameter properties are not supported by Node strip-types. Use explicit field declaration.',
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

      // Catch usage of deprecated APIs
      '@typescript-eslint/no-deprecated': 'error',

      // Use Pino logger, not console
      'no-console': 'error',

      // AI guardrail: keep functions short and simple
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 10],

      // AI guardrail: limit params — use option objects instead
      'max-params': ['error', 3],

      // AI guardrail: extract named constants
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1, 2],
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          ignoreTypeIndexes: true,
        },
      ],

      // AI guardrail: explicit return types on exported functions
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowIIFEs: true,
        },
      ],

      // AI guardrail: consistent import type usage
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // Relaxed rules for React components (.tsx) — return types are self-evident
  {
    files: ['**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // Disable no-deprecated for packages without type-checked linting (requires type info)
  {
    files: ['packages/web/**/*.{ts,tsx}', 'packages/mcp-ticktick/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
    },
  },

  // Relaxed rules for test files
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      'no-console': 'off',
      'max-lines-per-function': 'off',
      'complexity': 'off',
      'max-params': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
