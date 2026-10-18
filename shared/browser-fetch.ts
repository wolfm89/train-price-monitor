// ---------------------------------------------------------------------------
// browser-fetch — a Fetch API shim that issues DB requests from inside a real
// browser page.
//
// Why this exists (history matters here):
//   · 2026-09: DB's Akamai Bot Manager began returning `403 OPS_BLOCKED` for
//     every non-browser TLS/HTTP2 fingerprint, so the transport became a real
//     Chromium launched in the Lambda, issuing same-origin `fetch()` from a page
//     on int.bahn.de.
//   · 2026-10-13: that stopped working too. DB now rejects requests from
//     non-consumer *hosts* — a headless Linux container is blocked even when a
//     genuine Chromium makes the request, and even with no automation (CDP)
//     attached at all. A Windows/macOS consumer browser on the *same* network is
//     still allowed, so the decision is about the client environment, not the
//     IP and not the automation. See AGENTS.md for the full evidence.
//
// Consequence: the browser can no longer run inside the Lambda. It runs at a
// managed unblocking-browser vendor and this module attaches to it over CDP
// (`BROWSER_WS_ENDPOINT`, or an SSM parameter named by
// `BROWSER_WS_ENDPOINT_PARAM`). The request is still issued from inside a page
// on the DB origin via same-origin `fetch()`, so db-vendo-client's request
// building and response parsing are untouched and no CORS preflight applies.
//
// Both the backend and the scraper alias `cross-fetch` to this file, so there is
// exactly one implementation. Launching a local Chromium remains the fallback
// for local development (and would work again only if DB relaxed the rule).
// ---------------------------------------------------------------------------

import type { Browser, Page } from 'playwright-core';

// Chromium and the page are reused across invocations in the same execution
// environment: the origin is loaded once per cold start rather than per
// request, which matters for the poller's batched runs.
//
// Callers may issue requests concurrently (the poller asks for 1st and 2nd
// class at the same time), so every cached promise below is assigned
// synchronously — awaiting before assignment would let a second caller see a
// null field and start a duplicate browser/page/navigation.
//
// Sessions are kept in a small pool rather than one at a time. DB decides its
// block when a vendor session is created and applies it to everything that
// session does, and in a bad stretch ~50 % of sessions come back blocked: with a
// sibling already connected, a request that lands on a blocked session fails
// over in ~1 s instead of paying 11-22 s for a new one.
interface Session {
  browserPromise: Promise<Browser>;
  pagePromise: Promise<Page> | null;
  navigationPromise: Promise<void> | null;
  currentOrigin: string | null;
  /** When the vendor handed this session over (0 while it is still connecting). */
  startedAt: number;
  /** Last time a request used it; the least recently used session is picked next. */
  lastUsedAt: number;
  /** Set when it served a blocked response or died; it is closed and never reused. */
  unusable: boolean;
}

const sessions: Session[] = [];

/**
 * How many vendor sessions to keep ready. Two is enough to survive a blocked
 * session without paying for a new one, and few enough that a keep-warm ping
 * every two minutes can hold both inside the vendor's five-minute idle window.
 */
function sessionPoolSize(): number {
  return envNumber('BROWSER_SESSION_POOL_SIZE', 2);
}

const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * A fulfilled warm-up answers locally, so a navigation that needs the full 30 s is
 * already dead; a real page load (`BROWSER_WARMUP=load`) genuinely can take ~17 s.
 * Failing faster keeps a hung vendor node from eating the whole caller budget.
 */
function navigationTimeoutMs(): number {
  return warmupMode() === 'load' ? NAVIGATION_TIMEOUT_MS : 10_000;
}

// ---------------------------------------------------------------------------
// Egress. A genuine Chromium is necessary but no longer sufficient: as of
// 2026-10 DB's bot protection rejects requests from non-consumer hosts (the
// Lambda's headless Linux container) even when a real browser makes them —
// verified against the running deployment, and against a plain, non-automated
// Chromium with no CDP attached. Requests from a consumer device (Windows PC,
// phone) on the *same* network are still allowed, so the blocking decision is
// about the client host, not the IP and not the automation.
//
// The workaround is therefore to stop originating the request from the Lambda
// container. Either:
//   BROWSER_WS_ENDPOINT  a remote CDP endpoint (a managed unblocking browser
//                        that supplies a real browser plus a trusted egress);
//   BROWSER_PROXY        an HTTP/SOCKS proxy whose egress is trusted, applied
//                        to the locally launched Chromium.
// Neither set => legacy behaviour (local headless Chromium), which is what
// local development uses.
// ---------------------------------------------------------------------------
// Configuration is read lazily, per use, rather than captured at module load.
// Module bodies run before `dotenv.config()` in local development (imports are
// hoisted), so reading them eagerly would miss backend/.env and silently fall
// back to the local Chromium — which DB blocks — instead of the vendor browser.
// In Lambda the platform sets these before the module loads, so this is purely a
// local-development correctness fix; the lookups are trivial.
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== undefined ? value : fallback;
}

/**
 * The vendor CDP endpoint (a literal) wins when present, so local development
 * needs no AWS access. In production the endpoint lives in an SSM SecureString,
 * written by CI from a repository secret, and only the parameter *name* is
 * configured — see resolveRemoteEndpoint().
 */
function remoteEndpointLiteral(): string | undefined {
  return process.env.BROWSER_WS_ENDPOINT;
}

function remoteEndpointParam(): string | undefined {
  return process.env.BROWSER_WS_ENDPOINT_PARAM;
}

function proxyUrl(): string | undefined {
  return process.env.BROWSER_PROXY;
}

/**
 * How long a resolved SSM value is reused. Deliberately finite: the keep-warm
 * rule can keep an execution environment alive for weeks, so a value cached "for
 * the life of the environment" would never pick up a rotated credential.
 */
function endpointTtlMs(): number {
  return envNumber('BROWSER_ENDPOINT_TTL_MS', 15 * 60_000);
}

/**
 * Warm-up strategy. The vendor bills per MB that traverses its proxy, and the
 * only meaningful traffic left is the warm-up page load (~200 KiB–1.2 MB per
 * session). Fulfilling the document from the client gives the page a real
 * `https://int.bahn.de` origin — all we need to issue a same-origin fetch — while
 * costing zero billed traffic. Set BROWSER_WARMUP=load to load the real page.
 */
function warmupMode(): string {
  return process.env.BROWSER_WARMUP ?? 'fulfill';
}

/**
 * DB's edge intermittently rejects a well-formed request with `403 OPS_BLOCKED`,
 * tied to the vendor's rotating exit IP. A fresh session usually succeeds, and a
 * zero-byte warm-up makes retrying cheap, so retry a few times.
 */
function fetchAttempts(): number {
  return envNumber('BROWSER_MAX_ATTEMPTS', 3);
}

/**
 * Each retry pays a full remote-session setup (~8–10 s), so an unbounded retry
 * loop can outlive the caller's timeout (API Gateway caps the GraphQL Lambda at
 * 29 s). Stop retrying once this much wall-clock time has been spent.
 */
function retryBudgetMs(): number {
  return envNumber('BROWSER_RETRY_BUDGET_MS', 20_000);
}

/**
 * What one retry costs: a fresh vendor session. Measured at ~11 s per connect
 * (four samples, sequential and parallel; occasionally 22 s). The budget check
 * below is predictive so a retry is never started that cannot finish inside the
 * caller's budget — overrunning it used to turn a clean error into an API Gateway
 * 504 after 29 s, which is worse for the user than a fast, retryable error.
 */
function retryCostMs(): number {
  return envNumber('BROWSER_RETRY_COST_MS', 12_000);
}

/** True when another attempt can still complete inside the caller's budget. */
function canAffordRetry(startedAt: number): boolean {
  return Date.now() - startedAt + retryCostMs() < retryBudgetMs();
}

/** How long to wait for the vendor to hand over a browser before giving up. */
function connectTimeoutMs(): number {
  return envNumber('BROWSER_CONNECT_TIMEOUT_MS', 20_000);
}

/**
 * When to replace a remote session. The vendor's documented maximum session
 * length is 60 minutes; rotating below that keeps the replacement off the
 * request path, because the keep-warm rule pings every few minutes.
 */
function sessionMaxAgeMs(): number {
  return envNumber('BROWSER_SESSION_MAX_AGE_MS', 50 * 60_000);
}

// Only retry when the browser is remote: relaunching the local Chromium three
// times would be slow and cannot help (the local environment is blocked).
let remoteSession = false;

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // Additional fields (agent, keepalive, redirect, query) set by
  // db-vendo-client's request.js are intentionally ignored: `query` is already
  // merged into the URL before fetch() is called, and the others have no
  // meaningful equivalent for a browser-backed transport.
  [key: string]: unknown;
}

interface BrowserFetchRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface BrowserFetchResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyText: string;
}

// The callback passed to `page.evaluate` is serialized and executed inside the
// page, so it must use the browser's `fetch`, not Node's. The consuming
// modules compile without the DOM lib, so the browser globals this file relies
// on are declared explicitly here instead.
declare const window: {
  fetch(
    input: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<{
    status: number;
    statusText: string;
    headers: { entries(): Iterable<[string, string]> };
    text(): Promise<string>;
  }>;
};

class FetchCompatibleHeaders {
  private readonly values: Map<string, string>;

  constructor(headers: Array<[string, string]>) {
    this.values = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}

class FetchCompatibleResponse {
  readonly ok: boolean;
  readonly headers: FetchCompatibleHeaders;

  constructor(
    readonly status: number,
    readonly statusText: string,
    private readonly bodyText: string,
    headers: Array<[string, string]>
  ) {
    this.ok = status >= 200 && status < 300;
    this.headers = new FetchCompatibleHeaders(headers);
  }

  async text(): Promise<string> {
    return this.bodyText;
  }
}

// db-vendo-client's request.js only constructs `Request` to pass it to
// `profile.logRequest`, which is a no-op unless `DEBUG=hafas-client` is set.
class FetchCompatibleRequest {
  readonly url: string;
  readonly body: string | undefined;

  constructor(url: string, init: FetchInit = {}) {
    this.url = url;
    this.body = init.body;
  }
}

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/** Splits `http://user:pass@host:port` into the shape Playwright's `proxy` expects. */
function parseProxyConfig(raw: string): ProxyConfig {
  const url = new URL(raw);
  const server = `${url.protocol}//${url.host}`;
  if (!url.username) return { server };
  return {
    server,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

let remoteEndpointRequest: Promise<string | null> | null = null;
let remoteEndpointCache: { value: string; expiresAt: number } | null = null;

/**
 * Resolves the vendor CDP endpoint from SSM.
 *
 * The secret lives in an SSM SecureString that CI writes from a repository
 * secret, so it never reaches CloudFormation, a template or the function's
 * environment — only the parameter *name* is configured. Values are cached with
 * a TTL (see endpointTtlMs) and concurrent callers share one request, so a cold
 * start performs at most one GetParameter call.
 */
function resolveRemoteEndpoint(): Promise<string | null> {
  const literal = remoteEndpointLiteral();
  if (literal) return Promise.resolve(literal);

  const parameterName = remoteEndpointParam();
  if (!parameterName) return Promise.resolve(null);

  if (remoteEndpointCache && Date.now() < remoteEndpointCache.expiresAt) {
    return Promise.resolve(remoteEndpointCache.value);
  }

  if (!remoteEndpointRequest) {
    remoteEndpointRequest = (async (): Promise<string | null> => {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const result = await new SSMClient({}).send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true })
      );
      const value = result.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${parameterName} is empty`);
      remoteEndpointCache = { value, expiresAt: Date.now() + endpointTtlMs() };
      return value;
    })().finally(() => {
      // Cleared on failure too, so a transient SSM error is retried next time
      // rather than cached as a permanent failure.
      remoteEndpointRequest = null;
    });
  }

  return remoteEndpointRequest;
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');

  const endpoint = await resolveRemoteEndpoint();

  // A managed unblocking browser already has a real Chrome and a trusted egress
  // behind it; we only attach. Everything downstream (navigate to the origin,
  // same-origin fetch, response mapping) is identical to the local case.
  if (endpoint) {
    remoteSession = true;
    // The vendor provisions a browser in ~11 s (measured four times, sequential and
    // parallel). Playwright's 30 s default outlives both the caller's retry budget
    // and API Gateway's 29 s allowance, so a stalled connect must fail sooner.
    return await chromium.connectOverCDP(endpoint, { timeout: connectTimeoutMs() });
  }

  return await chromium.launch({
    headless: true,
    // Lambda runs unprivileged with a small /dev/shm; --single-process keeps
    // the memory footprint (and cold start) down for a one-page workload.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
    ...(proxyUrl() ? { proxy: parseProxyConfig(proxyUrl()!) } : {}),
  });
}

function createSession(): Session {
  const session: Session = {
    // Assigned synchronously below: callers race for this promise, so there must
    // never be a moment where the session exists without one.
    browserPromise: undefined as unknown as Promise<Browser>,
    pagePromise: null,
    navigationPromise: null,
    currentOrigin: null,
    startedAt: 0,
    lastUsedAt: 0,
    unusable: false,
  };

  session.browserPromise = launchBrowser()
    .then((browser) => {
      session.startedAt = Date.now();
      return browser;
    })
    .catch((error: unknown) => {
      session.unusable = true;

      const index = sessions.indexOf(session);
      if (index >= 0) sessions.splice(index, 1);

      throw error;
    });

  sessions.push(session);
  return session;
}

function usableSessions(): Session[] {
  return sessions.filter((session) => !session.unusable);
}

/** Retires a session: never picked again, closed in the background. */
function closeSession(session: Session): void {
  session.unusable = true;

  const index = sessions.indexOf(session);
  if (index >= 0) sessions.splice(index, 1);

  void session.browserPromise.then((browser) => browser.close()).catch(() => undefined);
}

/**
 * Least recently used usable session, creating one when none is left.
 *
 * Least-recently-used rather than "any", so every session in the pool keeps being
 * exercised and a spare is not quietly dropped by the vendor's idle timeout.
 */
function pickSession(): Session {
  const usable = usableSessions();
  if (usable.length === 0) return createSession();

  return usable.reduce((oldest, candidate) => (candidate.lastUsedAt < oldest.lastUsedAt ? candidate : oldest));
}

/**
 * Rounds the session out to the pool size, retiring any session that is past the
 * vendor's 60-minute cap, and creates at most one replacement.
 *
 * For the keep-warm path only: creating a session costs 11-22 s, and a user
 * request must never wait for the pool to be refilled — it picks what is already
 * there and fails over between sessions instead.
 */
export async function warmSessionPool(): Promise<{ ready: number; created: boolean }> {
  for (const session of usableSessions()) {
    if (session.startedAt && Date.now() - session.startedAt > sessionMaxAgeMs()) {
      closeSession(session);
    }
  }

  let created = false;

  if (usableSessions().length < sessionPoolSize()) {
    // Bounded on purpose: one session per call, so a keep-warm invocation cannot
    // hold the worker's single slot for minutes while it digs out of a bad stretch.
    await createSession().browserPromise;
    created = true;
  }

  return { ready: usableSessions().length, created };
}

async function getPage(session: Session, origin: string): Promise<Page> {
  if (!session.pagePromise) {
    session.pagePromise = (async () => {
      const browser = await session.browserPromise;
      const context = await browser.newContext();

      // Serve the origin's document locally. Nothing traverses the vendor's
      // proxy, so the warm-up is free, but the page still has the real origin
      // the subsequent same-origin fetch needs.
      if (warmupMode() === 'fulfill') {
        await context.route(`${origin}/`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><title>warmup</title>',
          })
        );
      }

      return await context.newPage();
    })().catch((error: unknown) => {
      session.pagePromise = null;
      throw error;
    });
  }

  const page = await session.pagePromise;

  // Concurrent callers share a single navigation instead of each issuing their
  // own goto() against the same page.
  if (session.currentOrigin !== origin) {
    if (!session.navigationPromise) {
      session.navigationPromise = page
        .goto(origin, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs() })
        .then(() => {
          session.currentOrigin = origin;
        })
        .catch(async (error: unknown) => {
          // A navigation that cannot complete means this browser is unusable —
          // observed: a timeout on a *locally fulfilled* page when the vendor's node
          // hung. Retire the session so the caller's retry picks its sibling instead
          // of every later request paying the same timeout.
          closeSession(session);
          throw error;
        })
        .finally(() => {
          session.navigationPromise = null;
        });
    }
    await session.navigationPromise;
  }

  return page;
}

/**
 * True for Playwright's "the thing you were talking to is gone" errors.
 *
 * The vendor closes sessions on its own schedule (idle timeout, node rotation),
 * which from here looks exactly like a concurrent renewal — except it cannot bump
 * the generation. Measured on the live poller: ~20 % of targets died on
 * "Target page, context or browser has been closed" without being retried.
 */
function isClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|Target closed|Browser closed|Connection closed/i.test(message);
}

export function fetch(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  return fetchSerialized(url, init);
}

async function fetchSerialized(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  const target = new URL(url);
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    const session = pickSession();

    try {
      const page = await getPage(session, target.origin);
      session.lastUsedAt = Date.now();

      const response = await page.evaluate(
        async ({ path, method, headers, body }: BrowserFetchRequest): Promise<BrowserFetchResponse> => {
          const result = await window.fetch(path, { method, headers, body });
          return {
            status: result.status,
            statusText: result.statusText,
            headers: Array.from(result.headers.entries()),
            bodyText: await result.text(),
          };
        },
        {
          path: `${target.pathname}${target.search}`,
          method: (init.method ?? 'GET').toUpperCase(),
          headers: init.headers ?? {},
          body: init.body,
        }
      );

      const blocked = response.status === 403 && /OPS_BLOCKED/.test(response.bodyText);

      // DB's block applies to everything a session does, so retire it either way:
      // the retry then picks a sibling instead of paying for this one again.
      if (remoteSession && blocked) closeSession(session);

      if (remoteSession && blocked && attempt < fetchAttempts() && canAffordRetry(startedAt)) {
        continue;
      }

      return new FetchCompatibleResponse(response.status, response.statusText, response.bodyText, response.headers);
    } catch (error) {
      // The vendor closes sessions on its own schedule (idle timeout, node
      // rotation), a sibling may have been retired while this request was in
      // flight, and a hung node shows up as a navigation timeout. All of them mean
      // this session is gone: retire it and retry on whatever is left.
      const sessionGone = session.unusable || isClosedError(error) || !(await isConnected(session));
      if (sessionGone) closeSession(session);

      if (remoteSession && sessionGone && attempt < fetchAttempts() && canAffordRetry(startedAt)) {
        continue;
      }

      throw error;
    }
  }
}

async function isConnected(session: Session): Promise<boolean> {
  const browser = await session.browserPromise.catch(() => null);
  return !!browser && browser.isConnected();
}

/** Closes every session — used by tests and by a deliberate reset. */
export async function closeBrowser(): Promise<void> {
  const closing = sessions.map((session) => {
    session.unusable = true;
    return session.browserPromise.then((browser) => browser.close()).catch(() => undefined);
  });

  sessions.length = 0;
  await Promise.all(closing);
}

export { FetchCompatibleRequest as Request };
