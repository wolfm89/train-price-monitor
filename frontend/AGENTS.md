# Frontend — Agent Guide

React 19 single-page app built with Vite, Material-UI v7 and urql. It signs users in with Cognito and
talks to the GraphQL API. The root [`AGENTS.md`](../AGENTS.md) still applies; this file adds the
frontend-specific rules.

## Commands

```bash
npm install
npm run dev          # Vite on http://localhost:3000
npm run build        # tsc + production build into build/
npm run test:ci      # Vitest one-shot (use this before a PR)
npm test             # Vitest watch mode
npm run typecheck
npm run lint
```

From the repository root: `mise run //frontend:dev` and `mise run //frontend:test`.

## Environment

Production builds read `REACT_APP_GRAPHQL_ENDPOINT` and `REACT_APP_COGNITO_*`; in dev the client
calls `/graphql` on its own origin and the dev server proxies it to `VITE_DEV_BACKEND_URL` (default
`http://127.0.0.1:4000`). `mise run env:local` writes the ignored `frontend/.env`; Vite also accepts
the unprefixed `COGNITO_*` names. Without those values the app cannot sign in. The canonical variable
list is [docs/configuration.md](../docs/configuration.md#frontend-build).

## What to know

- **Auth and API.** The urql client attaches the Cognito JWT. Keep API operations in `src/api/` and
  never call the DB Vendo API from the browser.
- **Watchlist is a snapshot.** Journeys render from the `cached*` fields and `lastCheckedAt` that
  the backend refresher maintains. Rendering the watchlist must not trigger a network call; a stale
  or unavailable snapshot is shown as `unavailable`, not as an error.
- **Structure.** `src/pages/` holds route pages, `src/components/` shared UI, `src/hooks/` hooks,
  `src/providers/` context providers, `src/utils/` auth, formatting and account/data helpers. The
  Material-UI theme is `src/theme.ts`.
- **Components.** Use functional components with hooks. Components and pages use default exports
  (all `src/components/*.tsx` do). Props interfaces are named `<Component>Props` and destructured in
  the signature.
- **Tests.** Vitest + Testing Library (`*.test.ts` / `*.test.tsx`). Cover query variables,
  pagination, profile/data deletion helpers and watchlist states. `vitest.config.ts` caps workers at
  two; do not raise that without checking memory on CI and low-memory machines.
- **Privacy.** Do not put emails, names or search text into URLs, analytics or logs. Account export
  and deletion UI must stay wired to `exportMyData` and `deleteUser`.
- **Logging.** Do not add console calls; the two suppressions in `src/providers/AuthProvider.tsx`
  are intentional.

Update `README.md` for user-facing behavior changes and
[docs/configuration.md](../docs/configuration.md#frontend-build) for new environment variables.
