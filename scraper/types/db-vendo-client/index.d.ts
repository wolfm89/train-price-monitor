declare module 'db-vendo-client' {
  export { createClient } from 'hafas-client';
}

declare module 'db-vendo-client/p/dbweb/index.js' {
  import type { Profile } from 'hafas-client';
  export const profile: Profile;
}

declare module 'db-vendo-client/parse/journey-leg.js' {
  export function parseJourneyLeg(ctx: unknown, pt: unknown, date: unknown, fallbackLocations: unknown): unknown;
}

declare module 'db-vendo-client/parse/stopover.js' {
  export function parseStopover(ctx: unknown, st: unknown, date: unknown): unknown;
}
