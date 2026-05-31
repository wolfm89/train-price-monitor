import { type TtdTier } from './types.js';

const INTERVAL_MS: Record<TtdTier, number> = {
  FAR: 24 * 60 * 60 * 1000, // 24h
  MID: 12 * 60 * 60 * 1000, // 12h
  NEAR: 4 * 60 * 60 * 1000, // 4h
};

const JITTER_MS: Record<TtdTier, number> = {
  FAR: 2 * 60 * 60 * 1000, // ±2h
  MID: 60 * 60 * 1000, // ±1h
  NEAR: 20 * 60 * 1000, // ±20min
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
