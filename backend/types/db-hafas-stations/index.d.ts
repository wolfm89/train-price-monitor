declare module 'db-hafas-stations' {
  interface SimpleStation {
    type: string;
    id: string;
    name: string;
    weight: number;
  }

  interface FullStation extends SimpleStation {
    [key: string]: unknown;
  }

  export function readSimplifiedStations(): AsyncGenerator<SimpleStation>;
  export function readFullStations(): AsyncGenerator<FullStation>;
}
