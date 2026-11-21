# Frontend

React 19 single-page app for Train Price Monitor. It is a Vite build with Material-UI v7, urql for
GraphQL and Amazon Cognito for authentication.

## Commands

```bash
npm install
npm run dev          # Vite on http://localhost:3000
npm run build        # tsc + production build into build/
npm test             # Vitest
npm run test:ci      # Vitest run, no watch
npm run typecheck
npm run lint
```

From the repository root, use `mise run //frontend:dev` and `mise run //frontend:test`.

## Environment

The app needs Cognito and GraphQL values at build/dev time:

- `REACT_APP_GRAPHQL_ENDPOINT` — API Gateway base URL for production builds; the dev server proxies
  `/graphql` to `VITE_DEV_BACKEND_URL` instead (default `http://127.0.0.1:4000`).
- `REACT_APP_COGNITO_USER_POOL_ID`
- `REACT_APP_COGNITO_CLIENT_ID`
- `REACT_APP_COGNITO_IDENTITY_POOL_ID`

`mise run env:local` writes `frontend/.env` from the deployed stack.
Vite also accepts the unprefixed `COGNITO_*` names. See
[docs/configuration.md](../docs/configuration.md#frontend-build) for the full reference.

## Structure

- `src/pages/` — search, journeys, profile, home and auth pages.
- `src/components/` — shared UI, search results, journey tickets and the notification menu.
- `src/api/` — urql queries/mutations.
- `src/utils/` — auth, API client, legal links, formatting and account/data helpers.
- `src/theme.ts` — Material-UI theme.

The API client attaches the Cognito JWT. The watchlist reads the cached journey snapshot, so it does
not call DB Vendo while rendering. The UI distinguishes fares at/below the limit from fares above it.

## Tests

Vitest + Testing Library. Tests cover API query variables, pagination, profile/data deletion helpers
and the watchlist states. Run `npm run test:ci` before opening a PR.

## More

- [Architecture](../docs/architecture.md)
- [Development](../docs/development.md)
- [Configuration](../docs/configuration.md)
