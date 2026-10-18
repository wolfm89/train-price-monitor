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
let browserPromise: Promise<Browser> | null = null;
let pagePromise: Promise<Page> | null = null;
let navigationPromise: Promise<void> | null = null;
let currentOrigin: string | null = null;

const NAVIGATION_TIMEOUT_MS = 30_000;

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
const REMOTE_CDP_ENDPOINT = process.env.BROWSER_WS_ENDPOINT;

// Production keeps the endpoint (which embeds the vendor zone password) in an
// SSM SecureString, written by CI from a repository secret, and passes only the
// parameter *name* to the function. The value is fetched once per execution
// environment and cached. `BROWSER_WS_ENDPOINT` (a literal) wins when present so
// local development needs no AWS access.
const REMOTE_CDP_PARAM = process.env.BROWSER_WS_ENDPOINT_PARAM;
const PROXY_URL = process.env.BROWSER_PROXY;

// Warm-up strategy. The remote vendor bills per MB that traverses its proxy, and
// the only meaningful traffic left is the warm-up page load (~200 KiB–1.2 MB per
// session). Fulfilling the document from the client gives the page a real
// `https://int.bahn.de` origin — all we need to issue a same-origin fetch — while
// costing zero billed traffic. Set BROWSER_WARMUP=load to load the real page.
const WARMUP_MODE = process.env.BROWSER_WARMUP ?? 'fulfill';

// DB's edge intermittently rejects a well-formed request with `403 OPS_BLOCKED`,
// tied to the vendor's rotating exit IP. A fresh session usually succeeds, and a
// zero-byte warm-up makes retrying cheap, so retry a few times.
const FETCH_ATTEMPTS = Number(process.env.BROWSER_MAX_ATTEMPTS ?? 3);

// Each retry pays a full remote-session setup (~8–10 s), so an unbounded retry
// loop can outlive the caller's timeout (API Gateway caps the GraphQL Lambda at
// 29 s). Stop retrying once this much wall-clock time has been spent.
const RETRY_BUDGET_MS = Number(process.env.BROWSER_RETRY_BUDGET_MS ?? 20_000);

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

let remoteEndpointPromise: Promise<string | null> | null = null;

/**
 * Resolves the remote CDP endpoint. Cached per execution environment so the SSM
 * read happens at most once per cold start, and only when the function is
 * actually asked to fetch something.
 */
function resolveRemoteEndpoint(): Promise<string | null> {
  if (REMOTE_CDP_ENDPOINT) return Promise.resolve(REMOTE_CDP_ENDPOINT);
  if (!REMOTE_CDP_PARAM) return Promise.resolve(null);

  if (!remoteEndpointPromise) {
    remoteEndpointPromise = (async (): Promise<string | null> => {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const result = await new SSMClient({}).send(
        new GetParameterCommand({ Name: REMOTE_CDP_PARAM, WithDecryption: true })
      );
      const value = result.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${REMOTE_CDP_PARAM} is empty`);
      return value;
    })().catch((error: unknown) => {
      remoteEndpointPromise = null;
      throw error;
    });
  }

  return remoteEndpointPromise;
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');

  const endpoint = await resolveRemoteEndpoint();

  // A managed unblocking browser already has a real Chrome and a trusted egress
  // behind it; we only attach. Everything downstream (navigate to the origin,
  // same-origin fetch, response mapping) is identical to the local case.
  if (endpoint) {
    remoteSession = true;
    return await chromium.connectOverCDP(endpoint);
  }

  return await chromium.launch({
    headless: true,
    // Lambda runs unprivileged with a small /dev/shm; --single-process keeps
    // the memory footprint (and cold start) down for a one-page workload.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
    ...(PROXY_URL ? { proxy: parseProxyConfig(PROXY_URL) } : {}),
  });
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error: unknown) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function getPage(origin: string): Promise<Page> {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext();

      // Serve the origin's document locally. Nothing traverses the vendor's
      // proxy, so the warm-up is free, but the page still has the real origin
      // the subsequent same-origin fetch needs.
      if (WARMUP_MODE === 'fulfill') {
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
      pagePromise = null;
      throw error;
    });
  }

  const page = await pagePromise;

  // Concurrent callers share a single navigation instead of each issuing their
  // own goto() against the same page.
  if (currentOrigin !== origin) {
    if (!navigationPromise) {
      navigationPromise = page
        .goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
        .then(() => {
          currentOrigin = origin;
        })
        .finally(() => {
          navigationPromise = null;
        });
    }
    await navigationPromise;
  }

  return page;
}

/** Drops the cached browser/page so the next call starts from a clean state. */
async function resetBrowser(): Promise<void> {
  const previous = browserPromise;
  browserPromise = null;
  pagePromise = null;
  navigationPromise = null;
  currentOrigin = null;

  if (previous) {
    await previous.then((browser) => browser.close()).catch(() => undefined);
  }
}

export async function fetch(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  const target = new URL(url);
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    try {
      const page = await getPage(target.origin);
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
      if (remoteSession && blocked && attempt < FETCH_ATTEMPTS && Date.now() - startedAt < RETRY_BUDGET_MS) {
        // A new CDP session means a new egress IP, and the zero-byte warm-up
        // makes that cheap in traffic — but not in time, so the budget above
        // caps how long a caller can be kept waiting.
        await resetBrowser();
        continue;
      }

      return new FetchCompatibleResponse(response.status, response.statusText, response.bodyText, response.headers);
    } catch (error) {
      // Only tear down when Chromium is actually gone. Resetting on *any* error
      // would close the browser while a concurrent request is still using it,
      // turning one failure into a cascade that fails every later call in this
      // execution environment. A crashed browser, by contrast, would poison
      // every later call unless it is replaced.
      const browser = await browserPromise?.catch(() => null);
      if (!browser || !browser.isConnected()) {
        await resetBrowser();
      }
      throw error;
    }
  }
}

export async function closeBrowser(): Promise<void> {
  await resetBrowser();
}

export { FetchCompatibleRequest as Request };
