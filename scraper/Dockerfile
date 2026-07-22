FROM public.ecr.aws/lambda/nodejs:24 AS libcurl-impersonate

# Fetch curl-impersonate's shared library for the target architecture at
# image build time (not at Lambda cold start) so cold starts don't depend on
# GitHub availability/network egress and the build stays reproducible.
#
# See src/net/impersonate-fetch.ts for why this is needed: since 2026-07-13
# int.bahn.de's Akamai Bot Manager blocks every request whose TLS/HTTP2
# fingerprint doesn't match a real browser (OPS_BLOCKED), which affects
# Node's native fetch/undici regardless of IP. curl-impersonate patches
# libcurl to present a genuine Chrome fingerprint.
ARG LIBCURL_IMPERSONATE_VERSION=v1.5.6
ARG TARGETARCH
RUN microdnf install -y tar gzip ca-certificates && microdnf clean all
RUN case "${TARGETARCH}" in \
      arm64) LIBCURL_ARCH=aarch64-linux-gnu ;; \
      amd64) LIBCURL_ARCH=x86_64-linux-gnu ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/libcurl-impersonate.tar.gz \
      "https://github.com/lexiforest/curl-impersonate/releases/download/${LIBCURL_IMPERSONATE_VERSION}/libcurl-impersonate-${LIBCURL_IMPERSONATE_VERSION}.${LIBCURL_ARCH}.tar.gz" \
    && mkdir -p /opt/libcurl-impersonate \
    && tar -xzf /tmp/libcurl-impersonate.tar.gz -C /opt/libcurl-impersonate \
    && cp -L /opt/libcurl-impersonate/libcurl-impersonate.so /opt/libcurl-impersonate.so \
    && rm /tmp/libcurl-impersonate.tar.gz

FROM public.ecr.aws/lambda/nodejs:24 AS deps

# `impers` (used only by the poller, see src/net/impersonate-fetch.ts) is a
# native binding via `koffi` and cannot be esbuild-bundled — install it here
# so its platform-specific native addon (koffi) resolves for the image's
# actual target architecture, then copy just these two packages into the
# final image below. Everything else stays bundled into dist/poller/index.mjs.
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules/impers ${LAMBDA_TASK_ROOT}/node_modules/impers
COPY --from=deps /deps/node_modules/koffi ${LAMBDA_TASK_ROOT}/node_modules/koffi
COPY --from=deps /deps/node_modules/@koromix ${LAMBDA_TASK_ROOT}/node_modules/@koromix
COPY --from=libcurl-impersonate /opt/libcurl-impersonate.so /opt/lib/libcurl-impersonate.so

ENV LIBCURL_IMPERSONATE_PATH=/opt/lib/libcurl-impersonate.so

# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
