import { createInMemoryCache } from '@graphql-yoga/plugin-response-cache';
import { warmSessionPool } from '../../shared/browser-fetch';
import { createContext } from './context';
import type { GraphQLContext } from './context';
import Logger from './lib/logger';
import type { JourneyWorkerJob } from './lib/journeyWorkerProtocol';

const cache = createInMemoryCache();

/**
 * The keeper and a search play different games, so they get different budgets.
 *
 * The keeper must end up holding a *good* session and nobody is waiting on it: it
 * may spend several session setups (each 11-22 s, measured) inside its 60 s
 * timeout, and it must not stop at a blocked session — that is what repairs the
 * worker after the vendor hands one out.
 *
 * A search has to answer inside the API function's 24 s wait, and while a long
 * budget would still leave a good session behind, it would hold the worker's
 * single slot for that whole time, throttling every other search.
 */
const SEARCH_RETRY_BUDGET_MS = process.env.BROWSER_RETRY_BUDGET_MS ?? '25000';
const KEEPALIVE_RETRY_BUDGET_MS = process.env.BROWSER_KEEPALIVE_BUDGET_MS ?? '45000';

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
  // Read per use by the shim, so setting it here scopes the budget to this
  // invocation — see SEARCH_RETRY_BUDGET_MS above.
  process.env.BROWSER_RETRY_BUDGET_MS = job.job === 'keepAlive' ? KEEPALIVE_RETRY_BUDGET_MS : SEARCH_RETRY_BUDGET_MS;

  const context = (await createContext(cache, {})) as GraphQLContext;
  Logger.info('Journey worker invoked', { job: job.job });

  if (job.job === 'keepAlive') {
    // One session setup at most (11-22 s measured). A keep-warm invocation must not
    // hold the worker's single slot for minutes while it digs out of a blocked
    // stretch: a user search colliding with it is throttled, and the API's wait is
    // bounded. Creating the replacement here is what keeps the *next* search off
    // that path.
    await warmSessionPool();

    // A real DB request, not a CDP ping: the vendor's idle timer counts traffic
    // through the session (measured — a CDP-only ping three minutes after the last
    // request did not keep it open). It also serves as the validation of whichever
    // session was least recently used, retiring it if the vendor handed out a
    // blocked one.
    await context.dbHafas.warmUp();
    return { ok: true };
  }

  if (job.job === 'journey') {
    const journey = await context.dbHafas.requeryJourney(job.refreshToken, job.pricingOptions);
    return journey ?? null;
  }

  return context.dbHafas.queryJourneys(job.from, job.to, new Date(job.departure), job.options);
};
