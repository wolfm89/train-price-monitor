ARG BUILDPLATFORM

# ---------------------------------------------------------------------------
# Builder stages run on the *build* machine's native platform
# (--platform=$BUILDPLATFORM), not the Lambda's target platform. Neither
# needs to execute anything compiled for the target architecture — they only
# fetch/select the right prebuilt binaries as inert files — so building them
# natively avoids requiring QEMU/binfmt cross-arch emulation, which most CI
# runners and dev machines don't have configured. Only the final stage below
# targets the Lambda's actual architecture, and it contains no RUN steps
# (COPY is architecture-agnostic), so no emulation is needed there either.
# ---------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS libcurl-impersonate

# Fetch curl-impersonate's shared library for the Lambda's target
# architecture at image build time (not at Lambda cold start) so cold starts
# don't depend on GitHub availability/network egress and the build stays
# reproducible.
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

FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps

# `impers` (used only by the poller, see src/net/impersonate-fetch.ts) is a
# native binding via `koffi` and cannot be esbuild-bundled — install it here
# so its platform-specific native addon (koffi ships this as a separate
# optional dependency per platform/arch, e.g. @koromix/koffi-linux-arm64)
# resolves for the Lambda's actual target architecture, regardless of what
# architecture this build stage itself runs on. `npm ci --cpu/--os/--libc`
# selects the right prebuilt package as plain files — no execution of
# foreign-architecture code happens during install, only at Lambda runtime.
#
# --ignore-scripts: koffi's own postinstall (cnoke.cjs) tries to fetch/build
# a native binary matching the *build host's* arch, which conflicts with the
# cross-arch --cpu override above and falls back to a from-source build
# (needs CMake, not installed, and can't cross-compile anyway). It's safe to
# skip entirely: the actual binary we need is the separate
# @koromix/koffi-linux-* package selected below, which ships prebuilt files
# with no install script of its own.
ARG TARGETARCH
WORKDIR /deps
COPY package.json package-lock.json ./
RUN case "${TARGETARCH}" in \
      arm64) NPM_CPU=arm64 ;; \
      amd64) NPM_CPU=x64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && npm ci --omit=dev --ignore-scripts --cpu="${NPM_CPU}" --os=linux --libc=glibc

FROM public.ecr.aws/lambda/nodejs:24

COPY --from=deps /deps/node_modules/impers ${LAMBDA_TASK_ROOT}/node_modules/impers
COPY --from=deps /deps/node_modules/koffi ${LAMBDA_TASK_ROOT}/node_modules/koffi
COPY --from=deps /deps/node_modules/@koromix ${LAMBDA_TASK_ROOT}/node_modules/@koromix
COPY --from=libcurl-impersonate /opt/libcurl-impersonate.so /opt/lib/libcurl-impersonate.so

ENV LIBCURL_IMPERSONATE_PATH=/opt/lib/libcurl-impersonate.so

# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
