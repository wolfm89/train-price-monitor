# ---------------------------------------------------------------------------
# libcurl-impersonate — curl-impersonate's patched libcurl shared library.
#
# Since 2026-07-13, int.bahn.de's Akamai Bot Manager blocks every request
# whose TLS/HTTP2 fingerprint doesn't match a real browser (403 OPS_BLOCKED),
# which affects Node's native fetch/undici regardless of IP. curl-impersonate
# patches libcurl to present a genuine Chrome fingerprint; `impers` loads this
# .so via FFI (koffi) at runtime. See src/net/impersonate-fetch.ts.
#
# The tarball is verified against a pinned SHA256 digest before extraction
# (sourced from GitHub's own per-asset `digest` field for this exact release).
# ---------------------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:24 AS libcurl-impersonate

ARG LIBCURL_IMPERSONATE_VERSION=v1.5.6
ARG TARGETARCH
RUN microdnf install -y tar gzip ca-certificates && microdnf clean all
RUN case "${TARGETARCH}" in \
      arm64) LIBCURL_ARCH=aarch64-linux-gnu; LIBCURL_SHA256=b4e4f713655616efd2be83153d9057b5961c15e34563dde09a8b6798a8b331e9 ;; \
      amd64) LIBCURL_ARCH=x86_64-linux-gnu; LIBCURL_SHA256=f07e25084020c54d6fd5654c8d458e09b3a44c312f88e480c255399f00487b25 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/libcurl-impersonate.tar.gz \
      "https://github.com/lexiforest/curl-impersonate/releases/download/${LIBCURL_IMPERSONATE_VERSION}/libcurl-impersonate-${LIBCURL_IMPERSONATE_VERSION}.${LIBCURL_ARCH}.tar.gz" \
    && echo "${LIBCURL_SHA256}  /tmp/libcurl-impersonate.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/libcurl-impersonate \
    && tar -xzf /tmp/libcurl-impersonate.tar.gz -C /opt/libcurl-impersonate \
    && cp -L /opt/libcurl-impersonate/libcurl-impersonate.so /opt/libcurl-impersonate.so \
    && rm /tmp/libcurl-impersonate.tar.gz

FROM public.ecr.aws/lambda/nodejs:24 AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run codegen
RUN npm run build

# ---------------------------------------------------------------------------
# deps — production node_modules selected for the Lambda's target
# architecture. `impers`/`koffi` (used by src/net/impersonate-fetch.ts) are
# native bindings that cannot be esbuild-bundled; they must be present in
# node_modules at runtime. koffi ships its platform-specific addon as a
# separate optional dependency (@koromix/koffi-linux-*), so
# --cpu/--os/--libc --ignore-scripts picks the right prebuilt package without
# running koffi's own postinstall (which would try to build for the build
# host's architecture).
# ---------------------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:24 AS deps
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
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /build/dist/* ./
COPY --from=builder /build/src/schema ./src/schema
COPY --from=deps /deps/node_modules ./node_modules
COPY --from=libcurl-impersonate /opt/libcurl-impersonate.so /opt/lib/libcurl-impersonate.so

ENV LIBCURL_IMPERSONATE_PATH=/opt/lib/libcurl-impersonate.so

CMD [ "main.handler" ]
