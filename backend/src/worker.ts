import { createInMemoryCache } from '@graphql-yoga/plugin-response-cache';
import { createContext } from './context';
import type { GraphQLContext } from './context';
import Logger from './lib/logger';
import type { JourneyWorkerJob } from './lib/journeyWorkerProtocol';

const cache = createInMemoryCache();

/**
 * DB worker for journey searches.
 *
 * Deployed with reserved concurrency 1, no API Gateway route and no triggers
 * other than the keep-warm rule, so exactly one environment exists and only the
 * API function reaches it. That single slot is the point: a vendor browser
 * session costs 11-22 s to provision and expires after five minutes without
 * proxy traffic, so a search must never have to create one — and must always
 * land on the environment that holds it. Reserving the concurrency removes the
 * routing ambiguity without paying for provisioned concurrency.
 *
 * See shared/browser-fetch.ts for the transport and infrastructure/lib/backend.ts
 * for the wiring.
 */
export const handler = async (job: JourneyWorkerJob): Promise<unknown> => {
  const context = (await createContext(cache, {})) as GraphQLContext;
  Logger.info('Journey worker invoked', { job: job.job });

  if (job.job === 'keepAlive') {
    // A real DB request, not a CDP ping: the vendor's idle timer counts traffic
    // through the session (measured — a CDP-only ping three minutes after the last
    // request did not keep it open). warmUp() also creates the session when there
    // is none, replaces one the vendor hands out blocked, and rotates a session
    // that is approaching the 60-minute cap.
    await context.dbHafas.warmUp();
    return { ok: true };
  }

  if (job.job === 'journey') {
    const journey = await context.dbHafas.requeryJourney(job.refreshToken, job.pricingOptions);
    return journey ?? null;
  }

  return context.dbHafas.queryJourneys(job.from, job.to, new Date(job.departure), job.options);
};
