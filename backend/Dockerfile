# ---------------------------------------------------------------------------
# Backend image: AWS Lambda Node.js 24 base + Chromium headless shell.
#
# The application bundle is built on the host (`npm run build`) rather than
# inside this image, because the browser transport it bundles lives in
# ../shared and is therefore outside this Dockerfile's build context. This
# matches the scraper image and keeps the build free of toolchains.
#
# See ../shared/browser-fetch.ts for why a real browser is required: DB's
# Akamai Bot Manager rejects every non-browser TLS/HTTP2 fingerprint with
# `403 OPS_BLOCKED`. Journey search still needs live DB access, so Chromium
# ships here as well as in the refresher; the watchlist read path is served
# from the DynamoDB snapshot and performs no network calls.
#
# Only the `chromium_headless_shell` build is copied (~260 MB) rather than the
# full `chromium` build (~390 MB): `chromium.launch({ headless: true })`
# selects the headless shell, so the full browser would be dead weight.
#
# The image is x86_64-only. Chromium's shared-library dependencies must be
# installed for the *target* architecture, which would require QEMU/binfmt
# emulation to build an arm64 image on an amd64 host.
# ---------------------------------------------------------------------------

# CHROMIUM_REVISION is the browser build that playwright-core resolves at
# runtime; it is tied to PLAYWRIGHT_VERSION. Both are pinned together, and the
# COPY below fails loudly if the revision ever stops matching.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG CHROMIUM_REVISION=1243
ARG BUILDPLATFORM

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS browser

# Only packages left external by the esbuild bundle are actually loaded at
# runtime, but installing the full production set straight from the lockfile
# keeps versions pinned and reproducible. This stage is architecture-agnostic
# (no native builds), so it runs natively on the build host.
FROM --platform=$BUILDPLATFORM public.ecr.aws/lambda/nodejs:24 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM public.ecr.aws/lambda/nodejs:24
ARG CHROMIUM_REVISION

# Shared libraries Chromium links against that are absent from the Lambda base.
RUN dnf install -y \
      alsa-lib atk at-spi2-atk at-spi2-core cups-libs libdrm libX11 libXcomposite \
      libXdamage libXext libXfixes libXrandr libxcb libxkbcommon mesa-libgbm nspr nss pango \
    && dnf clean all

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=browser /ms-playwright/chromium_headless_shell-${CHROMIUM_REVISION} \
                    /ms-playwright/chromium_headless_shell-${CHROMIUM_REVISION}

COPY --from=deps /deps/node_modules ${LAMBDA_TASK_ROOT}/node_modules

# Pre-built CJS bundle (produced by 'npm run build' in backend/).
COPY dist/main.js ${LAMBDA_TASK_ROOT}/
# main.ts reads the SDL at startup, relative to the task root.
COPY src/schema/schema.graphql ${LAMBDA_TASK_ROOT}/src/schema/schema.graphql

CMD ["main.handler"]
