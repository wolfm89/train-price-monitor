# AGENTS.md - Train Price Monitor

This document provides guidance for AI agents working in this codebase.

## Project Overview

Train price monitoring webapp built with React, TypeScript, GraphQL, Docker, and AWS serverless services. The codebase is split into three modules:

- **frontend/** - React app with Material-UI and urql
- **backend/** - Express/GraphQL Yoga API with AWS integrations
- **infrastructure/** - AWS CDK infrastructure definitions

## Build/Lint/Test Commands

### Frontend

```bash
cd frontend
npm install && npm start      # Install and start dev server (port 3000)
npm run build                 # Production build to frontend/build
npm test                      # Run tests (Jest with react-scripts)
npm test -- --watchAll=false  # Run tests once (CI mode)
npm test -- --testPathPattern="SearchMask"  # Run single test file
```

### Backend

```bash
cd backend
npm install && npm run dev    # Install and start with hot reload
npm run build                 # Bundle with esbuild to backend/dist
npm run codegen               # Generate GraphQL types from schema
```

### Infrastructure

```bash
cd infrastructure
npm install && npm run build  # Install and compile TypeScript
npm test                      # Run Jest tests
npm test -- --testNamePattern="SQS"  # Run single test
npm run cdk deploy             # Deploy to AWS
npm run cdk diff               # Show diff against deployed stack
```

### Root Level

```bash
npx pre-commit run --all-files  # Run all pre-commit hooks
```

## Code Style Guidelines

### General

- **TypeScript strict mode** enabled in all modules
- Use `const` by default; use `let` only when reassignment is necessary
- **No `console.log`** in frontend code (ESLint: `no-console: error`)
- **Backend** allows `console.log` (overrides to `no-console: off`)

### Formatting (Prettier)

```json
{ "trailingComma": "es5", "tabWidth": 2, "printWidth": 120, "useTabs": false, "semi": true, "singleQuote": true }
```

### ESLint Configuration

Root `.eslintrc.yml` applies to all modules:

- Extends `eslint:recommended` and `@typescript-eslint/recommended`
- Rules: `no-console: error`, `prefer-const: warn`

Module-specific overrides:

- **frontend/.eslintrc.yml** - Extends `react-app` and `react-app/jest`
- **backend/.eslintrc.yml** - Overrides `no-console: off`
- **infrastructure/.eslintrc.yml** - Extends `plugin:awscdk/all`

### Import Conventions

1. External packages first (alphabetical)
2. Internal modules (relative paths)
3. Group imports with blank lines between

```typescript
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Button } from '@mui/material';

import Header from './components/Header';
import { authService } from './services/auth';
```

### Naming Conventions

- **Components**: PascalCase (`SearchMask.tsx`, `AlertBar.tsx`)
- **Hooks**: camelCase with `use` prefix (`useAlert.tsx`)
- **Utilities/API**: camelCase (`apiClient.tsx`, `journey.tsx`)
- **Classes/Stacks**: PascalCase (`InfrastructureStack`)
- **Variables/functions**: camelCase
- **Constants**: SCREAMING_SNAKE_CASE
- **Files**: kebab-case (`infrastructure-stack.ts`)

### TypeScript Guidelines

- Use explicit types for function parameters and return values
- Prefer interfaces over type aliases for object shapes
- Use `unknown` instead of `any` when type is truly unknown
- Enable strict null checks (`strictNullChecks: true`)

### React Conventions

- Functional components with hooks
- Named exports for reusable components; default exports for pages
- Prop interfaces named `<ComponentName>Props`
- Destructure props in function signature

```typescript
interface SearchMaskProps {
  onSearch: (query: SearchQuery) => void;
  isLoading: boolean;
}

export default function SearchMask({ onSearch, isLoading }: SearchMaskProps) {
  // ...
}
```

### AWS CDK Conventions

- Use `cdk.Stack` as base class
- Construct IDs should be descriptive: `'Backend'`, `'CognitoAuth'`
- Use CDK L2 constructs when available
- Always specify `props?: cdk.StackProps` for stack constructors

### Error Handling

- Backend uses `@aws-lambda-powertools/logger` for structured logging
- Use `try/catch` with specific error types
- Frontend uses `AlertProvider` for user-facing notifications

### Testing

- Test files: `<name>.test.ts` pattern in `test/` directory
- Infrastructure uses Jest with ts-jest; Frontend uses react-scripts testing
- Write descriptive test names: `test('SQS Queue Created')`

## Pre-commit Hooks

Enforce: no trailing whitespace, LF line endings, valid YAML/JSON, Prettier formatting, ESLint linting.

Install: `pip install pre-commit && pre-commit install`

## Environment Variables

Never commit `.env` files or secrets. Required:

- **Backend**: `PROFILE_IMAGE_BUCKET_NAME`, `TPM_SQS_QUEUE_URL`
- **Infrastructure**: AWS credentials via AWS CLI

## Directory Structure

```
train-price-monitor/
├── frontend/src/
│   ├── api/          # GraphQL API clients
│   ├── components/   # Reusable UI components
│   ├── hooks/        # Custom React hooks
│   ├── pages/        # Page components
│   ├── providers/    # React context providers
│   ├── theme.ts      # Material-UI theme
│   └── utils/        # Utility functions
├── backend/src/
│   ├── lib/          # Shared utilities (logger, sort)
│   └── main.ts       # Entry point
├── infrastructure/
│   ├── lib/          # Stack definitions
│   ├── test/         # CDK tests
│   └── bin/          # CDK app entry
└── AGENTS.md
```

## Common Tasks

### Adding a new frontend component

1. Create file in appropriate subdirectory under `frontend/src/`
2. Export as named export if reusable, default if page-level
3. Create accompanying prop interface
4. Verify ESLint/TypeScript checks pass

### Adding a new GraphQL resolver

1. Add resolver to backend schema
2. Run `npm run codegen` to update types
3. Implement resolver in appropriate resolver file
4. Update tests if applicable

### Modifying infrastructure

1. Make CDK changes in appropriate stack file
2. Run `npm run build` to verify TypeScript compiles
3. Run `npm run cdk diff` to preview changes
4. Deploy with `npm run cdk deploy`
