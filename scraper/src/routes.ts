import stationsData from '../stations.json' with { type: 'json' };

export interface Route {
  /** "{originEva}-{destEva}" — used as route_id throughout the system */
  id: string;
  originEva: string;
  originName: string;
  destEva: string;
  destName: string;
}

interface Station {
  eva: string;
  name: string;
}

const { t1, t2 } = stationsData as { t1: Station[]; t2: Station[] };

/**
 * All directed routes within a single station set.
 * For n stations: n×(n-1) routes (every ordered pair where origin ≠ dest).
 */
function directedPairsWithin(stations: Station[]): Route[] {
  const routes: Route[] = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = 0; j < stations.length; j++) {
      if (i === j) continue;
      const o = stations[i];
      const d = stations[j];
      routes.push({ id: `${o.eva}-${d.eva}`, originEva: o.eva, originName: o.name, destEva: d.eva, destName: d.name });
    }
  }
  return routes;
}

/**
 * All directed routes between two disjoint station sets (both A→B and B→A).
 * For m×n stations: 2×m×n routes.
 */
function directedPairsBetween(a: Station[], b: Station[]): Route[] {
  const routes: Route[] = [];
  for (const o of a) {
    for (const d of b) {
      routes.push({ id: `${o.eva}-${d.eva}`, originEva: o.eva, originName: o.name, destEva: d.eva, destName: d.name });
      routes.push({ id: `${d.eva}-${o.eva}`, originEva: d.eva, originName: d.name, destEva: o.eva, destName: o.name });
    }
  }
  return routes;
}

// T1×T1: all directed pairs within T1 — 7×6 = 42 routes
// T1×T2: all directed pairs between T1 and T2 — 7×7×2 = 98 routes
// Total: 140 routes
export const ROUTE_CATALOG: Route[] = [...directedPairsWithin(t1), ...directedPairsBetween(t1, t2)];
