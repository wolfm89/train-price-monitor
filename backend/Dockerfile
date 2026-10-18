# ---------------------------------------------------------------------------
# Backend image: AWS Lambda Node.js 24 + the pre-built GraphQL bundle.
#
# There is deliberately NO browser in this image. Until 2026-10-13 the backend
# shipped Chromium (headless shell) and issued DB requests from a page it
# controlled; DB's bot protection then stopped allowing non-consumer *hosts*, so
# a browser running in a Lambda container is refused no matter how genuine it is.
# The browser now runs at a managed unblocking-browser vendor and the shim
# attaches to it over CDP using BROWSER_WS_ENDPOINT[_PARAM]. See
# ../shared/browser-fetch.ts and AGENTS.md for the evidence.
#
# That removed the Playwright browser download, the Chromium shared-library
# layer (alsa-lib, nss, pango, …) and PLAYWRIGHT_BROWSERS_PATH, and with them the
# x86_64-only constraint that came from installing those libraries for the target
# architecture. playwright-core stays: it is the CDP client.
#
# The application bundle is built on the host (`npm run build`) rather than
# inside this image, because it bundles ../shared, which is outside this
# Dockerfile's build context. mise/infrastructure build it before the image.
# ---------------------------------------------------------------------------

# Only packages left external by the esbuild bundle are loaded at runtime, but
# installing the full production set straight from the lockfile keeps versions
# pinned and reproducible. This stage is architecture-agnostic (no native
# builds), so it runs natively on the build host.
FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules ${LAMBDA_TASK_ROOT}/node_modules

# Pre-built CJS bundles (produced by 'npm run build' in backend/): the GraphQL
# API/SQS handler and the journey worker, which runs the same image with
# reserved concurrency 1. The station index for autocomplete is bundled into both
# (backend/scripts/build-station-index.mjs).
COPY dist/main.js dist/worker.js ${LAMBDA_TASK_ROOT}/
# main.ts reads the SDL at startup, relative to the task root.
COPY src/schema/schema.graphql ${LAMBDA_TASK_ROOT}/src/schema/schema.graphql

CMD ["main.handler"]
