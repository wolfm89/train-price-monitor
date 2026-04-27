# AGENTS.md - Train Price Monitor

This document provides guidance for AI agents working in this codebase.

## Project Overview

Train price monitoring webapp built with React, TypeScript, GraphQL, Docker, and AWS serverless services. The codebase is split into three modules:

- **frontend/** - React 19 app with Material-UI v7, urql, and Vite
- **backend/** - GraphQL Yoga API with native AWS Lambda handler and AWS integrations
- **infrastructure/** - AWS CDK v2 infrastructure definitions

## Tooling

This project uses **mise** for Node.js version management. Run `mise install` to set up tools.

## Build/Lint/Test Commands

### Frontend (Vite + React 19)

```bash
cd frontend
npm install              # Install dependencies
npm run dev            # Start Vite dev server (port 3000)
npm run build          # Production build to frontend/build
npm test               # Run Vitest tests
npm run typecheck      # TypeScript check
npm run lint           # ESLint check
```

### Backend

```bash
cd backend
npm install            # Install dependencies
LOCAL_DEV=1 npm run dev  # Start local HTTP server with hot reload (port 4000)
npm run build         # Bundle with esbuild to backend/dist
npm run codegen       # Generate GraphQL types from schema
npm run typecheck     # TypeScript check
npm run lint          # ESLint check
```

> `LOCAL_DEV=1` switches the entry point from exporting a Lambda handler to starting a plain HTTP server. The mise task `mise run //backend:dev` sets this automatically.

### Infrastructure (CDK)

```bash
cd infrastructure
npm install            # Install dependencies
npm run build         # Compile TypeScript
npm run test          # Run Jest tests
npm run cdk deploy    # Deploy to AWS
npm run cdk diff      # Show diff against deployed stack
npm run typecheck     # TypeScript check
npm run lint          # ESLint check
```

### Root Level (mise monorepo)

This project is configured as a mise monorepo. Tasks defined in each module's `mise.toml` are accessible via `mise run //module:task`.

```bash
npx pre-commit run --all-files       # Run all pre-commit hooks
mise run //...:build                 # Build all modules in parallel
mise run //...:test                  # Run tests across all modules
mise run //...:lint                  # Lint all modules
mise run //frontend:dev              # Start frontend dev server
mise run //backend:dev               # Start backend local server (sets LOCAL_DEV=1)
mise run //infrastructure:deploy     # Deploy all CDK stacks
```

## Code Style Guidelines

### General

- **TypeScript strict mode** enabled in all modules
- Use `const` by default; use `let` only when reassignment is necessary
- **No `console.log`** in any module (ESLint: `no-console: error`)
- **Backend**: use `@aws-lambda-powertools/logger` for structured logging instead

### Formatting (Prettier)

```json
{ "trailingComma": "es5", "tabWidth": 2, "printWidth": 120, "useTabs": false, "semi": true, "singleQuote": true }
```

### ESLint Configuration

ESLint v10 uses flat config (`eslint.config.js`):

```javascript
export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: { ...tseslint.configs.recommended.rules, 'prefer-const': 'warn', 'no-console': 'error' },
  },
];
```

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

- Frontend: Vitest (`*.test.{ts,tsx}`)
- Infrastructure: Jest with ts-jest (`*.test.ts`)
- Write descriptive test names: `test('SQS Queue Created')`

## Pre-commit Hooks

Enforce: trailing whitespace, LF line endings, valid YAML/JSON, Prettier formatting, ESLint linting.

Install: `pip install pre-commit && pre-commit install`

## Backend esbuild Bundling Rules

The backend bundles with `--format=cjs` for Lambda compatibility. Critical rules for `--external` flags:

- **Do NOT externalize ESM-only packages** — they cannot be `require()`d at runtime and will crash Lambda with `UserCodeSyntaxError: Cannot use import statement outside a module`. Symptom: API Gateway returns 502 (browser misreports this as a CORS error).
- **`db-vendo-client`** must be **bundled** (not external) — it is ESM-only.
- **`db-hafas-stations`** must stay **external** — it uses `import.meta.url` for `.ndjson` data file resolution and is loaded via dynamic `import()`, which works from CJS context.

## AWS Deployment

```bash
# Source root .env first (sets AWS_PROFILE, CDK_DOMAIN_NAME, etc.)
source .env

# Deploy all stacks — from infrastructure/ or via mise
npx cdk deploy --all --require-approval never
# or:
mise run //infrastructure:deploy
```

`CDK_APP_NAME`, `CDK_DOMAIN_NAME`, and `CDK_SES_FROM_EMAIL` must be set before running `cdk deploy` (either via env vars or `-c` CDK context flags). Missing values cause a synth-time error.

- Lambda runs as a Docker image — expect **~15s cold start** on first invocation after deployment.
- If the Lambda crashes silently, check CloudWatch: log group is `/aws/lambda/InfrastructureStack-BackendGraphql*`.
- API Gateway uses a Cognito authorizer — all GraphQL requests require a valid JWT in the `Authorization` header (handled automatically by the frontend urql client).

## Environment Variables

Never commit `.env` files or secrets.

### Backend

| Variable                    | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `PROFILE_IMAGE_BUCKET_NAME` | S3 bucket name for profile images                                        |
| `TPM_SQS_QUEUE_URL`         | SQS queue URL for journey monitor updates                                |
| `SES_FROM_EMAIL`            | Sender address for SES notification emails (injected by CDK)             |
| `FRONTEND_URL`              | Frontend base URL for notification links (injected by CDK)               |
| `LOCAL_DEV`                 | Set to `1` to start an HTTP server instead of exporting a Lambda handler |
| `PORT`                      | HTTP port for local dev server (default: `4000`)                         |

### Frontend

| Variable                     | Description                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `REACT_APP_GRAPHQL_ENDPOINT` | API Gateway base URL (e.g. `https://xxx.execute-api.eu-central-1.amazonaws.com/`) |

### Infrastructure

AWS credentials must be available via the AWS CLI. The following variables override CDK context values and must be set before `cdk deploy`:

| Variable             | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `CDK_APP_NAME`       | Application name                                               |
| `CDK_DOMAIN_NAME`    | Custom domain name for the deployment                          |
| `CDK_SES_FROM_EMAIL` | Sender email address, injected into Lambda as `SES_FROM_EMAIL` |

See `.env` for example values.

## Directory Structure

```
train-price-monitor/
├── frontend/
│   ├── src/
│   │   ├── api/          # GraphQL API clients
│   │   ├── components/   # Reusable UI components
│   │   ├── hooks/        # Custom React hooks
│   │   ├── pages/        # Page components
│   │   ├── providers/    # React context providers
│   │   ├── theme.ts      # Material-UI theme
│   │   └── utils/        # Utility functions
│   ├── vite.config.ts     # Vite configuration
│   ├── vitest.config.ts   # Vitest configuration
│   └── index.html         # Entry HTML
├── backend/
│   └── src/
│       ├── lib/          # Shared utilities
│       └── main.ts       # Entry point
├── infrastructure/
│   ├── lib/              # Stack definitions
│   ├── test/             # CDK tests
│   └── bin/              # CDK app entry
├── .mise.toml            # Mise configuration
├── .env                  # Environment variables (not committed)
├── eslint.config.js      # ESLint v10 flat config
└── AGENTS.md             # This file
```

## Common Tasks

### Adding a new frontend component

1. Create file in appropriate subdirectory under `frontend/src/`
2. Export as named export if reusable, default if page-level
3. Create accompanying prop interface
4. Verify TypeScript/ESLint checks pass

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
