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
