import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'node_modules',
    'backend/node_modules',
    'temp_openclaw',
    '*.html',
    'debug_*.html',
    'backend/test-listen.js',
    'test_*.js',
    'test_*.cjs',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    plugins: { react },
    extends: [
      js.configs.recommended,
      react.configs.flat.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^[A-Z_]' }],
      // This rule is too aggressive for common "fetch on mount" patterns.
      'react-hooks/set-state-in-effect': 'off',
      // React 17+ JSX transform: React import isn't required.
      'react/react-in-jsx-scope': 'off',
      // This repo doesn't use runtime PropTypes (TypeScript is not in use either).
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'off',
    },
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['backend/**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      // Backend is intentionally pragmatic; keep lint focused on real issues.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-case-declarations': 'off',
      'no-redeclare': 'off',
    },
  },
])
