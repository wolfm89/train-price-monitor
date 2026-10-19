# ---------------------------------------------------------------------------
# Poller image: AWS Lambda Node.js 24 + the pre-built poller bundle.
#
# DB is reached with `impit`, a native HTTP client that imitates Firefox's TLS and
# HTTP/2 handshake (see ../shared/db-fetch.ts). It stays external to the bundle
# (native module) and ships a prebuilt binary per platform as an optional
# dependency, so the dependency stage pins the Lambda target
# (linux/x86_64/glibc). Only impit and its platform binary are copied; everything
# else the bundle needs is bundled.
#
# The bundle is built on the host (`npm run build`) because it bundles ../shared,
# which is outside this Dockerfile's build context.
# ---------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --os=linux --cpu=x64 --libc=glibc

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules/impit ${LAMBDA_TASK_ROOT}/node_modules/impit
COPY --from=deps /deps/node_modules/impit-linux-x64-gnu ${LAMBDA_TASK_ROOT}/node_modules/impit-linux-x64-gnu

# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
