// ---------------------------------------------------------------------------
// impersonate-fetch — a minimal Fetch API shim backed by `impers`
// (TLS/HTTP2 browser fingerprint impersonation via curl-impersonate).
//
// Why this exists:
// Since 2026-07-13, int.bahn.de's Akamai Bot Manager started rejecting every
// request from a non-browser TLS/HTTP2 fingerprint with a 403 "OPS_BLOCKED"
// response — regardless of IP address or HTTP headers. This affects Node's
// native fetch/undici (and therefore db-vendo-client's `cross-fetch`-based
// transport) equally whether called from AWS Lambda or a residential IP.
//
// A client that presents a genuine Chrome TLS/HTTP2 fingerprint (a real
// browser, or a TLS-impersonation library) is not affected. This module
// swaps only the transport db-vendo-client uses — request building and
// response parsing are untouched — via an esbuild alias that redirects the
// `cross-fetch` import to this file for the poller bundle only (see
// scripts/build.mjs). It is not wired into the module resolution for the
// hydrator or compactor, which don't call the DB Vendo API.
//
// This exports the same two named bindings db-vendo-client's lib/request.js
// imports from `cross-fetch`: `fetch` and `Request`.
// ---------------------------------------------------------------------------

import { Session, type RequestOptions } from 'impers';

// Reused across invocations in the same Lambda execution environment so that
// Akamai's session cookies (_abck, bm_sz, ...) persist between the ~15
// targets scraped per poller run, matching real-browser session behavior.
let _session: Session | null = null;

function getSession(): Session {
  if (!_session) {
    _session = new Session({ impersonate: 'chrome' });
  }
  return _session;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // Additional fields (agent, keepalive, redirect, query) set by
  // db-vendo-client's request.js are intentionally ignored: `query` is
  // already merged into the URL before fetch() is called, and the others
  // have no meaningful equivalent for a libcurl-backed transport.
  [key: string]: unknown;
}

class FetchCompatibleHeaders {
  constructor(private readonly get_: (name: string) => string | null) {}
  get(name: string): string | null {
    return this.get_(name);
  }
}

class FetchCompatibleResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: FetchCompatibleHeaders;
  private readonly bodyText: string;

  constructor(status: number, statusText: string, bodyText: string, getHeader: (name: string) => string | null) {
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.bodyText = bodyText;
    this.headers = new FetchCompatibleHeaders(getHeader);
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

export async function fetch(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  const method = (init.method ?? 'GET').toUpperCase();
  const options: RequestOptions = {
    headers: init.headers,
    // Raw body: db-vendo-client already JSON.stringify()s the payload, so we
    // pass it through verbatim rather than re-encoding via impers' `json`
    // option (which would double-encode it).
    content: init.body,
  };

  const res = await getSession().request(method, url, options);
  return new FetchCompatibleResponse(res.status, res.statusText, res.text, (name) => res.headers.get(name));
}

export { FetchCompatibleRequest as Request };
