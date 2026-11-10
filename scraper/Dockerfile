# ---------------------------------------------------------------------------
# Poller image: AWS Lambda Node.js 24 + the pre-built poller bundle.
#
# The bundle is built on the host (`npm run build`) because it bundles ../shared,
# which is outside this Dockerfile's build context.
# ---------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM public.ecr.aws/lambda/nodejs:24


# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
