import type { PricingOptions, QueryJourneysOptions } from '../managers/DbHafasManager';

/**
 * Jobs accepted by the journey worker (backend/src/worker.ts).
 *
 * The worker exists because a vendor browser session costs 11-22 s to provision
 * and expires after five minutes without proxy traffic. A session therefore has
 * to live outside the request path, in an environment that is guaranteed to be
 * the one serving the request — which is what reserved concurrency 1 gives us.
 * The API function and the keep-warm rule speak this protocol.
 */
export interface JourneyQueryJob {
  job: 'journeys';
  from: string;
  to: string;
  /** ISO 8601: Dates do not survive the JSON invoke payload. */
  departure: string;
  options?: QueryJourneysOptions;
}

export interface JourneyRefreshJob {
  job: 'journey';
  refreshToken: string;
  pricingOptions?: PricingOptions;
}

/**
 * Ensures a validated session exists. The keep-warm rule sends this every few
 * minutes, and the search page asks for it when it opens.
 */
export interface KeepAliveJob {
  job: 'keepAlive';
}

export type JourneyWorkerJob = JourneyQueryJob | JourneyRefreshJob | KeepAliveJob;
