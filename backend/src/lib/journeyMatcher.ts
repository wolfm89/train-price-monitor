import type { Journey } from 'hafas-client';

export interface JourneyMatchTarget {
  /** The exact reconstruction token, when the caller has one. */
  refreshToken?: string;
  fromId?: string;
  toId?: string;
  departure?: Date;
}

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
 * fallback matches the route and then the closest planned departure, the same
 * strategy the resolver uses when a refresh token is stale.
 */
export function findMatchingJourney(candidates: readonly Journey[], target: JourneyMatchTarget): Journey | undefined {
  if (target.refreshToken) {
    const exact = candidates.find((journey) => journey.refreshToken === target.refreshToken);
    if (exact) return exact;
  }

  const routeMatches =
    target.fromId && target.toId
      ? candidates.filter((journey) => {
          const firstLeg = journey.legs?.[0];
          const lastLeg = journey.legs?.[journey.legs.length - 1];
          return firstLeg?.origin?.id === target.fromId && lastLeg?.destination?.id === target.toId;
        })
      : candidates;

  if (routeMatches.length === 0) return undefined;
  if (!target.departure) return routeMatches[0];

  const targetTime = target.departure.getTime();
  return routeMatches.reduce<Journey | undefined>((best, journey) => {
    if (!best) return journey;
    return Math.abs(departureMs(journey) - targetTime) < Math.abs(departureMs(best) - targetTime) ? journey : best;
  }, undefined);
}
