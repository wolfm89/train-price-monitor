import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ROUTE_CATALOG } from './routes.js';

describe('ROUTE_CATALOG', () => {
  it('contains every directed catalogue pair exactly once', () => {
    // Keep in sync with analytics quality.expected_route_count; the Python contract test derives
    // the same 140 from stations.json.
    assert.equal(ROUTE_CATALOG.length, 140);
    assert.equal(new Set(ROUTE_CATALOG.map((route) => route.id)).size, ROUTE_CATALOG.length);
    assert.ok(ROUTE_CATALOG.every((route) => route.originEva !== route.destEva));
  });
});
