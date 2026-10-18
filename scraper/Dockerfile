# ---------------------------------------------------------------------------
# Poller image: AWS Lambda Node.js 24 + the pre-built poller bundle.
#
# There is deliberately NO browser in this image. Until 2026-10-13 the poller
# shipped Chromium (headless shell) and scraped DB from a page it controlled;
# DB's bot protection then stopped allowing non-consumer *hosts*, so a browser in
# a Lambda container is refused no matter how genuine it is. The browser now runs
# at a managed unblocking-browser vendor and the shared shim attaches to it over
# CDP using BROWSER_WS_ENDPOINT[_PARAM]. See ../shared/browser-fetch.ts and
# AGENTS.md for the evidence.
#
# That removed the Playwright browser download and the Chromium shared-library
# layer. playwright-core stays: it is the CDP client. Note this image copies only
# playwright-core from the dependency stage — everything else the bundle needs is
# bundled, including @aws-sdk/client-ssm (see scripts/build.mjs).
#
# The bundle is built on the host (`npm run build`) because it bundles ../shared,
# which is outside this Dockerfile's build context.
# ---------------------------------------------------------------------------

# playwright-core is pure JavaScript, so this stage is architecture-agnostic
# and can run natively on the build host.
FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules/playwright-core ${LAMBDA_TASK_ROOT}/node_modules/playwright-core

# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
