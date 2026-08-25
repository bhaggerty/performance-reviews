// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const eslintConfigPrettier = require('eslint-config-prettier');

const TYPE_CHECKED_GLOBS = ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'];

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'readonly',
  require: 'readonly',
  exports: 'writable',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
};

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'web/**', 'node_modules/**', 'coverage/**', '.github/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: NODE_GLOBALS,
    },
  },
  {
    // Type-aware rules are scoped only to the app source, scripts, and tests — root-level
    // *.config.ts files (vitest/playwright configs) get plain (non-type-checked) TS linting
    // below instead, since they aren't part of either tsconfig's project.
    files: TYPE_CHECKED_GLOBS,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.scripts.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // The Slack Bolt handlers consistently JSON.parse(view.private_metadata) — an untyped
      // `any` by design (Slack gives us a raw string) that a handful of authz-checked fields
      // are then read off of. Enforcing the full unsafe-any cascade here would require a
      // zod-validated parsing wrapper at every call site, which is a real but separate
      // src/ change beyond this lint-config pass — tracked as a follow-up, not silenced blindly
      // (no-explicit-any above still bans a *literal* `: any` annotation anywhere).
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Root-level TS config files (vitest.config.ts, playwright.config.ts, ...) — plain TS
    // syntax linting only, no type-aware rules (they sit outside both tsconfigs' project).
    files: ['*.ts'],
    extends: [...tseslint.configs.recommended],
  },
  {
    // scripts/*.js (create-table.js, check-table.js) and root-level *.config.js files are
    // plain Node CommonJS — not part of the type-checked TS project.
    files: ['scripts/**/*.js', '*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  eslintConfigPrettier
);
