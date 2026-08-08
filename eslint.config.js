// @ts-check
const js = require('@eslint/js');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'sidecar/**',
    ],
  },
  js.configs.recommended,
  {
    // Root-level tooling config files (this file, scripts/*) run as plain
    // Node CommonJS, not part of any TypeScript workspace package. Listed
    // explicitly rather than a bare '*.js'/'*.cjs' glob, which minimatch
    // matches at any depth — that would also catch renderer-context fixture
    // .js files elsewhere in the tree and wrongly hand them Node globals.
    files: ['eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Fixture pages loaded into the Electron renderer under test (M0-3 e2e) —
    // real browser globals, not Node's.
    files: ['apps/desktop/e2e/fixtures/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-throw-literal': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/providers/src/adapters/*', '**/providers/src/adapters/**'],
              message:
                'packages/core must not import provider adapters directly. Route model calls through the Governor (packages/core/src/governor/Governor.ts) — see docs/ARCHITECTURE.md section on the Governor enforcement mechanism.',
            },
            {
              group: ['**/tools/src/servers/*', '**/tools/src/servers/**'],
              message:
                'packages/core must not import internal tool servers directly. Route tool calls through the Governor (packages/core/src/governor/Governor.ts) — see docs/ARCHITECTURE.md section on the Governor enforcement mechanism.',
            },
          ],
        },
      ],
    },
  },
  {
    // E2E specs mix Node-side Playwright APIs with page.evaluate() callbacks
    // that run in the browser — both global sets are legitimately in play
    // in the same file.
    files: ['apps/desktop/e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // Belt-and-braces: the Governor no-bypass rule applies specifically to the
    // runtime and engine, which don't exist until M2. Scoping it here now means
    // it can never be accidentally introduced later without the guard already
    // in place. See docs/ROADMAP.md M0-1 and docs/ARCHITECTURE.md.
    files: ['packages/core/src/runtime/**/*.ts', 'packages/core/src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/providers/src/adapters/*',
                '**/providers/src/adapters/**',
                '@chimera/providers/*',
              ],
              message:
                'The agent runtime and engine must call providers only through Governor.authorizeModelCall(). No bypass path — see CLAUDE.md hard rule 1.',
            },
            {
              group: ['**/tools/src/servers/*', '**/tools/src/servers/**', '@chimera/tools/*'],
              message:
                'The agent runtime and engine must call tools only through Governor.authorizeToolCall(). No bypass path — see CLAUDE.md hard rule 1.',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
];
