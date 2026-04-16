import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';
import awscdk from 'eslint-plugin-awscdk';

export default [
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.generated.ts', '**/generated/**'],
  },
  {
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    ignores: ['**/generated/**', '**/*.generated.ts'],
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
    files: ['backend/**/*.{ts,tsx}'],
    ignores: ['**/generated/**', '**/*.generated.ts'],
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
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['infrastructure/**/*.{ts,tsx}'],
    ignores: ['**/generated/**', '**/*.generated.ts'],
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
