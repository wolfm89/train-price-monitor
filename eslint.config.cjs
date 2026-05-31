const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const globals = require('globals');
const awscdk = require('eslint-plugin-awscdk');

module.exports = [
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.generated.ts', '**/generated/**'],
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'prefer-const': 'warn',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['backend/**/*.{ts,tsx}', 'scraper/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'prefer-const': 'warn',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['infrastructure/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      awscdk,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'prefer-const': 'warn',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'awscdk/construct-constructor-property': 'off',
      'awscdk/require-dynamodb-autoscale': 'off',
      'awscdk/require-dynamodb-ptr': 'off',
    },
  },
  {
    files: ['infrastructure/**/*.js'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        require: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
      },
    },
    plugins: {
      awscdk,
    },
    rules: {
      'awscdk/construct-constructor-property': 'off',
      'awscdk/require-dynamodb-autoscale': 'off',
      'awscdk/require-dynamodb-ptr': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['infrastructure/test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },
];
