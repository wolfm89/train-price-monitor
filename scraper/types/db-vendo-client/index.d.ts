declare module 'db-vendo-client' {
  export { createClient } from 'hafas-client';
}

declare module 'db-vendo-client/p/dbweb/index.js' {
  import type { Profile } from 'hafas-client';
  export const profile: Profile;
}

declare module 'db-vendo-client/parse/journey-leg.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function parseJourneyLeg(ctx: any, pt: any, date: any, fallbackLocations: any): any;
}

declare module 'db-vendo-client/parse/stopover.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function parseStopover(ctx: any, st: any, date: any): any;
}
