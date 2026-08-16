import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Standalone Node scripts: plain ESM run directly by `node`, so they get
    // Node globals and are allowed to print (they are CLI tools).
    files: ['scripts/**/*.mjs', 'apps/web/e2e/**/*.mjs'],
    languageOptions: {
      // `fetch` is a global from Node 18 on, which the engines field already
      // requires — no import needed and none available.
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // The Playwright scripts are Node, but the bodies of `page.evaluate` and
    // `addInitScript` are serialised and run in the browser — so this one file
    // set legitimately mixes both global environments.
    files: ['apps/web/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        localStorage: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // §15: console.log is banned in the API — use the Pino logger.
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/**/*.test.ts', 'apps/api/src/observability/logger.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // The hook rules catch the class of bug this app is most exposed to: a
    // stale closure over a socket or a Y.Doc that silently stops updating.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Deliberately disabled in a few places where re-running an effect would
      // tear down a live CRDT binding; each one carries a comment saying why.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
