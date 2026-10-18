import { createInMemoryCache } from '@graphql-yoga/plugin-response-cache';
import { suspendSessionCreation, warmSessionPool } from '../../shared/browser-fetch';
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
 * Backoff for the keep-alive, so the worker stops amplifying a vendor episode.
 *
 * Every new session is another 11-22 s of churn, and measured on 2026-10-18 it did
 * not help: 29 session attempts in 22 minutes, 27 of them failed, and the episode
 * ended only once the churn stopped. After a failure the keeper therefore stays
 * quiet for a while and leaves the worker's single slot to searches, which create
 * a session only when one is actually needed. Any successful DB work — including a
 * user's search — means the vendor is healthy again and resets this.
 */
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 8 * 60_000;

let consecutiveFailures = 0;
let pausedUntil = 0;

function noteSuccess(): void {
  consecutiveFailures = 0;
  pausedUntil = 0;
}

function noteFailure(): void {
  consecutiveFailures += 1;
  const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
  pausedUntil = Date.now() + backoffMs;
  Logger.warn('Backing off session setup', { consecutiveFailures, backoffMs });
}

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
    // Backoff pauses *creation*, not the ping: the sessions that do work must stay
    // inside the vendor's five-minute idle window, otherwise a recovered vendor
    // still finds an empty pool. Creating during a bad stretch is what amplifies it
    // — measured: 29 attempts in 22 minutes, 27 failures, and it only ended when the
    // churn stopped.
    const backedOff = Date.now() < pausedUntil;
    suspendSessionCreation(backedOff);

    try {
      // At most one round of setups (11-22 s measured), never a second inside the
      // same ping, so the worker's single slot is never held for minutes.
      const { ready, created } = await warmSessionPool();

      if (ready > 0) {
        // A real DB request, not a CDP ping: the vendor's idle timer counts traffic
        // through the session (measured — a CDP-only ping three minutes after the
        // last request did not keep it open).
        await context.dbHafas.warmUp();

        // With three sessions in the pool, two requests per two-minute ping keep
        // every one of them inside the vendor's five-minute idle window.
        if (!created) await context.dbHafas.warmUp();

        noteSuccess();
        return { ok: true, created, backedOff };
      }

      // Pool empty while backed off: nothing to ping, and nothing to learn.
      return { ok: true, created: false, backedOff };
    } catch (error) {
      noteFailure();
      throw error;
    } finally {
      // The flag is module state in a single-slot environment; a search must never
      // inherit it.
      suspendSessionCreation(false);
    }
  }

  try {
    if (job.job === 'journey') {
      const journey = await context.dbHafas.requeryJourney(job.refreshToken, job.pricingOptions);
      noteSuccess();
      return journey ?? null;
    }

    const result = await context.dbHafas.queryJourneys(job.from, job.to, new Date(job.departure), job.options);
    noteSuccess();
    return result;
  } catch (error) {
    // A failed search means the vendor handed out another blocked session (or the
    // browser hung), so the keeper should back off too instead of piling on.
    noteFailure();
    throw error;
  }
};
