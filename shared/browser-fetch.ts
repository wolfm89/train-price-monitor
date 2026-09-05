// ---------------------------------------------------------------------------
// browser-fetch — a minimal Fetch API shim backed by a real Chromium browser.
//
// Why this exists:
// DB's Akamai Bot Manager rejects every request whose TLS/HTTP2 fingerprint
// does not come from a genuine browser, with `403 OPS_BLOCKED`. This affects
// Node's fetch/undici and — as of 2026-09 — every curl-impersonate target,
// including the Chrome ones. Verified from an AWS Lambda egress IP: only a
// real Chromium request succeeds (HTTP 201 with journey data).
//
// This module swaps only the transport db-vendo-client uses; its request
// building and response parsing are untouched. Both the backend refresher and
// the scraper poller alias `cross-fetch` to this file in their esbuild config,
// so there is exactly one implementation of the workaround.
//
// The request is issued from inside the page via same-origin `fetch()`, so the
// browser attaches the Akamai session cookies it obtained when loading the
// origin, and no CORS preflight applies.
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

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return await chromium.launch({
    headless: true,
    // Lambda runs unprivileged with a small /dev/shm; --single-process keeps
    // the memory footprint (and cold start) down for a one-page workload.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
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

export async function closeBrowser(): Promise<void> {
  await resetBrowser();
}

export { FetchCompatibleRequest as Request };
