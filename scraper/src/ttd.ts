import { type TtdTier } from './types.js';

// Scrape intervals are capacity-derived, not aspirational.
//
// DB tolerates only a modest request rate per egress IP (bursts are throttled for
// minutes), and the poller spaces its calls accordingly: a 22-target batch every
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

/**
 * Compute the TTD tier for a departure date relative to now.
 * Uses noon UTC on the departure date as the reference point.
 */
export function computeTtdTier(departureDateStr: string, now: Date): TtdTier {
  const departureNoon = new Date(`${departureDateStr}T12:00:00Z`);
  const ttdDays = (departureNoon.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (ttdDays > 30) return 'FAR';
  if (ttdDays >= 7) return 'MID';
  return 'NEAR';
}

/**
 * Compute the next scrape timestamp: now + interval + random jitter in [-jitter, +jitter].
 */
export function computeNextScrapeAt(tier: TtdTier, now: Date): Date {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS[tier];
  return new Date(now.getTime() + INTERVAL_MS[tier] + jitter);
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
  const plain = typeof nextScrapeAt === 'string' ? nextScrapeAt : nextScrapeAt.toISOString();
  return `${TIER_RANK[tier]}#${plain}`;
}

/** Tier ranks in the order the poller queries them. */
export const TIER_QUERY_ORDER: TtdTier[] = ['NEAR', 'MID', 'FAR'];

/** Rank of a tier, for building `due_key`. */
export function tierRank(tier: TtdTier): number {
  return TIER_RANK[tier];
}
