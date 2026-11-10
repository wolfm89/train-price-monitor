import type { Journey } from 'hafas-client';

export interface JourneyMatchTarget {
  /** The exact reconstruction token, when the caller has one. */
  refreshToken?: string;
  fromId?: string;
  toId?: string;
  departure?: Date;
  /** First-leg line name, when the caller knows it. */
  lineName?: string;
}

/**
 * A fresh search can legitimately return the same connection with a slightly
 * shifted scheduled departure, but a different train on the same route is not a
 * match. Fifteen minutes covers schedule corrections without accepting the next
 * connection.
 */
export const MAX_DEPARTURE_DIFFERENCE_MS = 15 * 60 * 1000;

function departureMs(journey: Journey): number {
  const firstLeg = journey.legs?.[0];
  const value = firstLeg?.plannedDeparture ?? firstLeg?.departure;
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Finds the same physical connection in a fresh `journeys` result.
 *
 * A `refreshToken` is an ephemeral reconstruction token: DB often returns a
 * different one for the same train, so exact equality alone silently fails. The
 * fallback matches the route and line, then requires the closest planned
 * departure to be within {@link MAX_DEPARTURE_DIFFERENCE_MS}; otherwise it
 * returns `undefined` so the caller can try a wider search or report no price.
 */
export function findMatchingJourney(candidates: readonly Journey[], target: JourneyMatchTarget): Journey | undefined {
  if (target.refreshToken) {
    const exact = candidates.find((journey) => journey.refreshToken === target.refreshToken);
    if (exact) return exact;
  }

  if (!target.departure || !Number.isFinite(target.departure.getTime())) return undefined;

  const routeMatches =
    target.fromId && target.toId
      ? candidates.filter((journey) => {
          const firstLeg = journey.legs?.[0];
          const lastLeg = journey.legs?.[journey.legs.length - 1];
          return firstLeg?.origin?.id === target.fromId && lastLeg?.destination?.id === target.toId;
        })
      : candidates;

  const lineMatches = target.lineName
    ? routeMatches.filter((journey) => journey.legs?.[0]?.line?.name === target.lineName)
    : routeMatches;

  if (lineMatches.length === 0) return undefined;

  const targetTime = target.departure.getTime();
  const best = lineMatches.reduce<Journey | undefined>((closest, journey) => {
    if (!closest) return journey;
    return Math.abs(departureMs(journey) - targetTime) < Math.abs(departureMs(closest) - targetTime)
      ? journey
      : closest;
  }, undefined);

  if (!best || Math.abs(departureMs(best) - targetTime) > MAX_DEPARTURE_DIFFERENCE_MS) {
    return undefined;
  }
  return best;
}
