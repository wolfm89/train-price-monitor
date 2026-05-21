declare module 'db-vendo-client' {
  export { createClient } from 'hafas-client';
}

declare module 'db-vendo-client/p/dbnav/index.js' {
  import type { Profile } from 'hafas-client';
  export const profile: Profile;
}

declare module 'db-vendo-client/p/db/index.js' {
  import type { Profile } from 'hafas-client';
  export const profile: Profile;
}

declare module 'db-vendo-client/p/dbweb/index.js' {
  import type { Profile } from 'hafas-client';
  export const profile: Profile;
}

declare module 'db-vendo-client/format/loyalty-cards.js' {
  export const data: {
    NONE: symbol;
    BAHNCARD: symbol;
    VORTEILSCARD: symbol;
    HALBTAXABO: symbol;
    VOORDEELURENABO: symbol;
    SHCARD: symbol;
    GENERALABONNEMENT: symbol;
    NL_40: symbol;
    AT_KLIMATICKET: symbol;
  };
  export function formatLoyaltyCard(
    card: {
      type: symbol;
      discount?: number;
      class?: number;
      business?: boolean;
    } | null
  ): { art: string; klasse: string };
}
