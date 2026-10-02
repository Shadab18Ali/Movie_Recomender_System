import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'web/data/'] },
  js.configs.recommended,
  {
    files: ['web/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['web/js/boot.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['api/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'no-implicit-globals': 'error',
    },
  },
];
