# ---------------------------------------------------------------------------
# Backend image: AWS Lambda Node.js 24 + the pre-built GraphQL bundle.
#
# The application bundle is built on the host (`npm run build`) rather than
# inside this image, because it bundles ../shared, which is outside this
# Dockerfile's build context. mise/infrastructure build it before the image.
# ---------------------------------------------------------------------------

# Only packages left external by the esbuild bundle are loaded at runtime, but
# installing the full production set straight from the lockfile keeps versions
# pinned and reproducible.
FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules ${LAMBDA_TASK_ROOT}/node_modules

# Pre-built CJS bundle (produced by 'npm run build' in backend/). The station
# index for autocomplete is bundled into it (backend/scripts/build-station-index.mjs).
COPY dist/main.js ${LAMBDA_TASK_ROOT}/
# main.ts reads the SDL at startup, relative to the task root.
COPY src/schema/schema.graphql ${LAMBDA_TASK_ROOT}/src/schema/schema.graphql

CMD ["main.handler"]
