# Shared — Agent Guide

Code and values used by more than one module. There is no `node_modules` here: each consuming
module type-checks these files through its own tsconfig `include` and bundles them with esbuild.
The root [`AGENTS.md`](../AGENTS.md) still applies; this file covers the shared pieces.

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
[docs/architecture.md](../docs/architecture.md#db-transport). Do not retry a browser, proxy or
vendor.

**What works.** Node's own `https` client with a browser-like cipher list; DB matches the TLS
ClientHello. The measured profiles and endpoint results are in
[docs/architecture.md](../docs/architecture.md#db-transport). Keep the profile list and rotation
order there; the transport must rotate on a block rather than pinning one profile. No browser,
proxy, native module or vendor account.

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
calling DB for `DB_BREAKER_COOLDOWN_MS`; hammering a throttled IP only extends the ban. With a
Decodo key the request falls back to Decodo; without one it throws `DbThrottledError` and the poller
ends its batch.

**Decodo fallback (backend only).** The API and refresher have `DECODO_API_KEY_PARAM` and use
Decodo's `/scrape` (premium pool; the standard pool cannot send custom headers and is refused) when
the direct path is throttled. The poller has no key on purpose: bulk work must never spend the free
allowance (5K calls/month). `DB_TRANSPORT=decodo` forces the fallback. The key lives in an SSM
SecureString that CI writes from the repository secret `DECODO_API_KEY`; functions receive only the
parameter name, so it never appears in a template, `cdk diff` or a function environment. IAM grants
exactly `ssm:GetParameter` on that parameter; no `kms:Decrypt` is needed with the AWS-managed
`aws/ssm` key. Rotation: update the repo secret and re-run the deploy job; running environments
converge within `DECODO_KEY_TTL_MS` (15 min).

**Fingerprint rotation.** Fingerprints get blocked once popular. On `403 OPS_BLOCKED` the transport
rotates to the next profile, remembers the working one for the environment and skips a blocked
profile for `DB_PROFILE_BLOCK_COOLDOWN_MS` (15 min). If every profile is blocked the breaker takes
over and the poller ends its batch; Decodo keeps search and refresh working meanwhile.

**Packaging.** The transport is pure Node (`node:https`), so neither bundle contains a native
module. The backend and poller Lambdas run x86_64 Docker images with the pre-built bundle copied in
unchanged. `@aws-sdk/client-ssm` is external in the backend bundle (present in the image) and
provided by the Node.js 24 runtime for the scraper; the transport imports it lazily, so local
development never touches SSM.

## Rules for changes

- Keep the transport pure Node. Do not add a browser, proxy, undici, native module or vendor
  dependency; that is the problem this file exists to avoid.
- Do not remove the `cross-fetch` alias in `../backend/` or `../scraper/`, and do not send
  additional headers without re-measuring against the live DB endpoint.
- After a transport change, run backend and scraper `typecheck`, `lint` and `test`, then build both
  bundles and confirm neither contains a native module.
- `runtime-config.json` is read by both runtimes and by CDK. Change it together with
  `docs/configuration.md` and check `../infrastructure/lib/config.ts`; do not fork a value into a
  module-local copy.
- Update [docs/architecture.md](../docs/architecture.md) when the transport design changes, and
  [docs/operations.md](../docs/operations.md) when throttling behavior or runbooks change.
