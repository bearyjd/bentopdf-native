import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.test-results/**', 'release/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'error' },
  },
  {
    // Code evaluated inside the page / sandboxed preload runs in a browser context.
    files: ['src/preload.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
];
