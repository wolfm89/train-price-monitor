import { type TtdTier } from './types.js';

// Scrape intervals are capacity-derived, not aspirational.
//
// DB tolerates only a modest request rate per egress IP (bursts are throttled for
// minutes), and the poller spaces its calls accordingly: a 25-target batch every
// 15 minutes is ~2,400 scrapes/day, above the ~1,654/day these intervals demand
// for a 60-day horizon (140 routes => 8,400 rows), so the schedule is met and the
// backlog drains in about a week. The poller serves NEAR first (see `dueKey`), so
// if capacity ever falls short it is the far end of the horizon that slips.
//
// The previous 4h/12h/24h tiers implied ~20,900 scrapes/day across the catalog —
// 12x more than achievable — so every row was permanently overdue and next_scrape_at
// was meaningless.
const INTERVAL_MS: Record<TtdTier, number> = {
  FAR: 16 * 24 * 60 * 60 * 1000, // 16d — 4,060 rows => ~254/day
  MID: 8 * 24 * 60 * 60 * 1000, // 8d — 3,360 rows => ~420/day
  NEAR: 24 * 60 * 60 * 1000, // 24h — 980 rows => ~980/day
};

// Jitter is kept at roughly an eighth of the interval so scrapes stay spread
// out across the window rather than clumping after a backlog is worked off.
const JITTER_MS: Record<TtdTier, number> = {
  FAR: 2 * 24 * 60 * 60 * 1000, // ±2d
  MID: 24 * 60 * 60 * 1000, // ±1d
  NEAR: 3 * 60 * 60 * 1000, // ±3h
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Time-to-departure at which a target is NEAR. Must match `computeTtdTier`. */
const NEAR_THRESHOLD_DAYS = 7;

/**
 * Enter NEAR just *inside* the window. `computeTtdTier` treats exactly 7.0 days
 * as MID, so clamping to the boundary itself would reschedule the target eight
 * days out and skip the whole near window.
 */
const NEAR_ENTRY_MARGIN_MS = MINUTE_MS;

/** A scrape is never scheduled this close to departure, and never after it. */
const DEPARTURE_SAFETY_MARGIN_MS = 90 * MINUTE_MS;

/**
 * Every route sharing a departure date hits the near-entry clamp and the final
 * scrape at the same instant. Spread both over a window: the poller serves 25
 * targets per 15 minutes, so 140 targets due together take ~1.4 hours to drain.
 */
const NEAR_ENTRY_SPREAD_MS = 6 * HOUR_MS;
const FINAL_SCRAPE_WINDOW_MS = 3 * HOUR_MS;

/** Injectable so tests do not have to stub `Math.random`. */
export type Rng = () => number;

/** Noon UTC on the departure date — the reference point for every TTD calculation. */
export function departureReferenceMs(departureDate: string): number {
  const departure = new Date(`${departureDate}T12:00:00Z`).getTime();
  if (!Number.isFinite(departure)) {
    throw new Error(`Invalid departure_date: ${JSON.stringify(departureDate)}`);
  }
  return departure;
}

/**
 * Scheduling bounds for a departure date.
 * `nearEntry` is the first instant that counts as NEAR; `hardStop` is the last
 * instant at which a scrape still returns prices.
 */
export function scheduleBounds(departureDate: string): { nearEntry: Date; hardStop: Date } {
  const departure = departureReferenceMs(departureDate);
  return {
    nearEntry: new Date(departure - NEAR_THRESHOLD_DAYS * DAY_MS + NEAR_ENTRY_MARGIN_MS),
    hardStop: new Date(departure - DEPARTURE_SAFETY_MARGIN_MS),
  };
}

/**
 * Compute the TTD tier for a departure date relative to now.
 * Uses noon UTC on the departure date as the reference point.
 */
export function computeTtdTier(departureDateStr: string, now: Date): TtdTier {
  const ttdDays = (departureReferenceMs(departureDateStr) - now.getTime()) / DAY_MS;
  if (ttdDays > 30) return 'FAR';
  if (ttdDays >= NEAR_THRESHOLD_DAYS) return 'MID';
  return 'NEAR';
}

/**
 * Compute the next scrape timestamp: now + interval + random jitter in
 * [-jitter, +jitter], clamped to the departure bounds.
 *
 * Without the clamp, a MID target scraped eight days out was rescheduled eight
 * days later — at or after departure — where the poller deletes it as expired.
 * That phase lock cost ~830 of the ~1,654 daily scrapes the intervals demand and
 * left most route-days without a single observation in their final week.
 *
 * Both clamps are spread over a window: every route sharing a departure date
 * would otherwise become due at the same instant, which defeats the jitter and
 * piles 140 targets onto a poller that serves 25 per run.
 */
export function computeNextScrapeAt(tier: TtdTier, now: Date, departureDate: string, rng: Rng = Math.random): Date {
  const { nearEntry, hardStop } = scheduleBounds(departureDate);
  const nowMs = now.getTime();

  // The last useful scrape is the one inside this window. Once it has happened,
  // hand the target to the poller's expiry path instead of scheduling another
  // one at the hard stop, which every route would otherwise share.
  const finalWindowStart = hardStop.getTime() - FINAL_SCRAPE_WINDOW_MS;
  if (nowMs >= finalWindowStart) {
    return new Date(nowMs + DAY_MS);
  }

  const jitter = (rng() * 2 - 1) * JITTER_MS[tier];
  let candidate = nowMs + INTERVAL_MS[tier] + jitter;

  // Pull a MID/FAR scrape that would jump over the near window back to its
  // edge, so the target is tiered NEAR and sampled daily from then on.
  if (tier !== 'NEAR' && nowMs < nearEntry.getTime() && candidate > nearEntry.getTime()) {
    candidate = nearEntry.getTime() + rng() * NEAR_ENTRY_SPREAD_MS;
  }

  // Spread the final scrape across the window before the hard stop.
  const finalSlot = finalWindowStart + rng() * FINAL_SCRAPE_WINDOW_MS;
  candidate = Math.min(candidate, finalSlot);
  candidate = Math.max(candidate, nowMs + MINUTE_MS);
  candidate = Math.min(candidate, hardStop.getTime());
  return new Date(candidate);
}

/**
 * Ordering rank for the `ByDue` index. Lower is served first, so a shortfall in
 * poller capacity costs the far end of the horizon rather than the near end:
 * NEAR targets are the ones a user is about to book.
 */
const TIER_RANK: Record<TtdTier, number> = { NEAR: 0, MID: 1, FAR: 2 };

/**
 * Sort key of the `ByDue` index: `<tier rank>#<next scrape at>`. The rank prefix
 * makes the index read in priority order; the timestamp inside each rank makes it
 * a plain due-time range query (`BETWEEN '<rank>#' AND '<rank>#<now>'`).
 */
export function dueKey(tier: TtdTier, nextScrapeAt: Date | string): string {
  // Normalise strings: an offset or a missing-millisecond format would break
  // the lexicographic ordering the ByDue range query relies on.
  const at = nextScrapeAt instanceof Date ? nextScrapeAt : new Date(nextScrapeAt);
  return `${TIER_RANK[tier]}#${at.toISOString()}`;
}

/** Tier ranks in the order the poller queries them. */
export const TIER_QUERY_ORDER: TtdTier[] = ['NEAR', 'MID', 'FAR'];

/** Rank of a tier, for building `due_key`. */
export function tierRank(tier: TtdTier): number {
  return TIER_RANK[tier];
}
