# Contributing

Contributions are welcome. Keep changes small, explain the user-visible effect, and run the checks
that cover the modules you touched.

## Before you start

- Read [docs/development.md](docs/development.md) for the toolchain and local setup.
- For a bug, open an issue with the expected and actual behaviour, the affected page or endpoint, and
  a sanitized log excerpt. Do not paste tokens, cookies, email addresses or raw personal data.
- For a security issue, use [SECURITY.md](SECURITY.md), not a public issue.

## Setup

```bash
mise install
mise run install
mise run env:local          # requires AWS SSO and a deployed InfrastructureStack
pip install pre-commit
pre-commit install
```

`mise run env:local` writes ignored `.env` files from CloudFormation outputs. See
[docs/deployment.md](docs/deployment.md#outputs-and-local-environment) if the stack is not
`InfrastructureStack`.

## Checks

Run the focused checks for your change, then the pre-commit hooks:

```bash
# Frontend
cd frontend && npm run test:ci && npm run typecheck && npm run lint

# Backend
cd backend && npm test && npm run typecheck && npm run lint

# Scraper
cd scraper && npm test && npm run typecheck && npm run lint

# Infrastructure
cd infrastructure && npm test && npm run typecheck && npm run lint

# Analytics
cd analytics && uv run pytest && uv run ruff check . && uv run ruff format --check . && uv run ty check

# Repository
pre-commit run --all-files
pre-commit run --all-files --hook-stage manual   # slower tsc/ty hooks
```

CI runs the per-module typecheck, lint and test commands, plus `uv run pytest` and `ty check` for
analytics. `ruff`, `ruff format` and Prettier run in pre-commit.ci. For a low-memory machine running
the whole monorepo, use `MISE_JOBS=1 mise run //:test` so modules run one at a time.

## Pull requests

1. Branch from `main`: `git switch -c feature/<short-name>`.
2. Keep the PR focused; separate refactors from behaviour changes.
3. Use a short imperative commit subject, for example `Add price alert threshold validation`.
4. In the PR description, state **what changed**, **why**, and the **checks** you ran.
5. Update the docs when behaviour, configuration or a documented claim changes. The canonical files
   are listed in [docs/README.md](docs/README.md).

The repository uses GitHub Actions on `main` and pull requests; the deploy job runs only on `main`.
Do not commit generated bundles, `cdk.out`, `.env` files, credentials or `package-lock.json` changes
made by hand.

## Dependencies

Dependabot alerts and PRs are reviewed in batches. Update the affected module with `npm install` or
`npm update`, then run that module's checks. Do not run `npm audit fix --force`; it proposes
unsupported downgrades (for example ESLint 9 and Jest 25). The remaining audit findings are
dev-tooling-only and are tracked.

## Docs

- Architecture and diagrams: [docs/architecture.md](docs/architecture.md)
- Deployment: [docs/deployment.md](docs/deployment.md)
- Development: [docs/development.md](docs/development.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Operations: [docs/operations.md](docs/operations.md)
- Privacy: [docs/privacy.md](docs/privacy.md)

Keep one source of truth: link instead of copying tables or commands. The code and tests are the
final source for factual claims.

## License

By contributing, you agree that your contribution is licensed under GPL-3.0.
