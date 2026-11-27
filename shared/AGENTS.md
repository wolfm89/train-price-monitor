# Shared — Agent Guide

Code and values used by more than one module. There is no `node_modules` here: each consuming
module type-checks these files through its own tsconfig `include` and bundles them with esbuild.
Lint uses the root ESLint config via `mise run //shared:lint`. The root [`AGENTS.md`](../AGENTS.md)
still applies; this file covers the shared pieces.

## Files

- `db-fetch.ts` — the Node `https` fetch that both the backend and the scraper alias `cross-fetch`
  to. It carries the browser-like TLS profiles and DB pacing.
- `runtime-config.json` — bronze prefix, scraper tuning, backend/scraper retention. It is read by the
  backend, the scraper and `../infrastructure/lib/config.ts` at synth time.

## DB transport

**History.** DB's Akamai edge rejects every non-browser TLS/HTTP2 fingerprint with
`403 OPS_BLOCKED`. Browsers, headless browsers, unblocking vendors and unblocker APIs were all
tried and are refused; only Node's `https` client with a browser-like cipher list passes. The
measured history and the list of refused approaches are in
[docs/architecture.md](../docs/architecture.md#db-transport). Do not retry a browser or vendor proxy;
the only proxies are the app-owned regional Lambda bridges described below.

**What works.** Node's own `https` client with a browser-like cipher list; DB matches the TLS
ClientHello. The measured profiles and endpoint results are in
[docs/architecture.md](../docs/architecture.md#db-transport). Keep the profile list and rotation
order there; the transport must rotate on a block rather than pinning one profile. No browser,
vendor proxy, native module or vendor account; the app-owned Lambda proxy below is the exception.

**Headers.** For the bahn.de web API only `Content-Type`/`Accept` plus `Origin`/`Referer` are sent;
db-vendo-client's User-Agent and correlation headers turn an accepted web request into a 403. The
DB Navigator API is the exception: its profile supplies `X-Correlation-ID`, which the transport
forwards. The backend and poller esbuild-`alias` `cross-fetch` to this module, so
`db-vendo-client`'s request building and response parsing stay untouched.

**Pacing.** The module spaces request starts (`DB_MIN_GAP_MS`) and caps in-flight requests
(`DB_MAX_IN_FLIGHT`); changing these defaults affects both runtimes. The poller's batch size and
pacing are in `../scraper/AGENTS.md`; the measured limits and the throttling history are in
[docs/architecture.md](../docs/architecture.md#db-transport).

**Circuit breaker.** After `DB_BREAKER_THRESHOLD` consecutive failed requests the environment stops
calling DB for `DB_BREAKER_COOLDOWN_MS`; hammering a throttled IP only extends the ban. When every
option is exhausted the transport throws `DbThrottledError` and the poller ends its batch. There is
no vendor fallback.

**Cross-region proxy.** `DB_PROXY_FUNCTIONS` is a comma-separated list of proxy Lambda ARNs, one per
region (normally us-east-1 and eu-central-1); the legacy single `DB_PROXY_FUNCTION` is still read.
The handler lives in `../infrastructure/lambda/db-proxy` and uses the same direct path. The caller
tries the healthiest region first, fails over on a refusal, retries a 429 with backoff, and skips a
refused region for `DB_REGION_COOLDOWN_MS` (2 min). `DB_PROXY_REGION` is only the hint for a single unparsable ARN.

**Dynamic fingerprints.** DB matches the TLS ClientHello and changes which order it accepts without
notice: `tls12` worked on 2026-11-25 and was refused again on 2026-11-27, while `chrome` and
`legacy` still returned 200. `DB_TLS_PROFILES` is the ordered list (default
`chrome,legacy,firefox,safari,tls13,tls12`). The transport rotates on `403`/`452 OPS_BLOCKED` _and_
on a `429`, remembers the winner for the environment, and skips a refused profile for
`DB_PROFILE_BLOCK_COOLDOWN_MS` (15 min). The proxy accepts the winner as a per-invocation hint and
reports `usedProfile` back, so each region keeps its own sticky fingerprint. If every option is
refused the breaker takes over and the poller ends its batch.

**Packaging.** The transport is pure Node (`node:https`), so neither bundle contains a native
module. The backend and poller Lambdas run x86_64 Docker images with the pre-built bundle copied in
unchanged. Both esbuild configs alias `@aws-sdk/client-lambda` and bundle it; the transport imports
it lazily, so local development with no proxy configured never loads it.

## Rules for changes

- Keep the transport pure Node. Do not add a browser, proxy, undici, native module or vendor
  dependency; that is the problem this file exists to avoid.
- Do not remove the `cross-fetch` alias in `../backend/` or `../scraper/`, and do not send
  additional headers without re-measuring against the live DB endpoint.
- After a transport change, run `mise run //shared:lint`, backend and scraper `typecheck`, `lint`
  and `test`, then build both bundles and confirm neither contains a native module.
- `runtime-config.json` is read by both runtimes and by CDK. Change it together with
  `docs/configuration.md` and check `../infrastructure/lib/config.ts`; do not fork a value into a
  module-local copy.
- Update [docs/architecture.md](../docs/architecture.md) when the transport design changes, and
  [docs/operations.md](../docs/operations.md) when throttling behavior or runbooks change.
