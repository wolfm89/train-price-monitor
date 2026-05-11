# Research: Data Collection Strategies for Train Price Time-to-Event Prediction

I'm researching data collection strategies for a DB (Deutsche Bahn) train price prediction system. The goal is to predict **when** a specific journey's price is about to exceed a user's configured limit, so we can notify them **before** it happens — not after.

This is a research prompt for an LLM with web search capabilities. I need you to find and evaluate practical strategies, datasets, APIs, and proxies that can provide the historical price time-series data needed to train this model, considering performance, cost effectiveness, and robustness.

## Project Context

### The Use Case

A user searches for connections on a specific date and time (e.g., "Berlin → Munich, 27 April, 08:02"), chooses one or more connections to "watch" with a given maximum price (e.g., "€50"), and wants to be notified a certain time **before** the price will very probably rise above the maximum price set. Currently the system only notifies AFTER the price exceeded the limit — too late to act.

This converts to a **time-to-event / survival problem**: "How many hours or days until this specific journey's price rises above threshold X?"

Example price trajectory for a watched journey:

```
t=-90d: price=29€,  load_factor=low,   fare_family=Super_Sparpreis
t=-60d: price=29€,  load_factor=low,   fare_family=Super_Sparpreis
t=-30d: price=39€,  load_factor=medium, fare_family=Super_Sparpreis
t=-14d: price=49€,  load_factor=high,   fare_family=Sparpreis
t=-7d:  price=79€,  load_factor=high,   fare_family=Sparpreis
t=-2d:  price=99€,  load_factor=v.high, fare_family=Flexpreis  ← EVENT: price jumped above user's limit
```

The model needs: **many journey instances × many observations spread across the full time-to-departure horizon** to learn when jumps typically occur given features like days_to_departure, current_price, load_factor, fare_family, route_cluster, day_of_week, time_of_day, etc.

### Current Codebase & Assets

**Tech Stack:**

- Frontend: React 19, Material-UI v7, urql, Vite
- Backend: GraphQL Yoga with native AWS Lambda handler
- Infrastructure: AWS CDK v2
- Database: DynamoDB (Journey entity with refreshToken, limitPrice, etc.)
- Scheduling: EventBridge for hourly polling
- Notifications: AWS SES for email

**Existing Data Ingestion:**

- `db-vendo-client` (ESM-only package): fetches fares from DB Vendo API
- Returns: fare amounts, fare families (Super Sparpreis / Sparpreis / Flexpreis), load-factor proxy indicator, `bestprice` flag (returns cheapest fare across all trains on a route for a given day)
- `db-hafas-stations`: ~5,400 DB stations with metadata (coordinates, name, type)

**Current Data Gaps:**

- Only stores latest price per watched journey — NO historical snapshots persist
- No background data collection for routes users haven't watched yet
- When a user stops watching a journey, all data is lost
- Users typically start watching 7–30 days before departure — so 30–90 day horizon is almost never sampled
- "Cold start" problem: ML has no training data for routes no one has watched yet

## Available Data Sources (Need Evaluation)

### DB Official Sources

- **DB Open Data Portal** (`data.deutschebahn.com`): timetables, station geodata, route network as GeoJSON — NO passenger volume or booking counts per route. [https://data.deutschebahn.com](https://data.deutschebahn.com)
- **DB Facts & Figures 2024** (PDF): total passengers 1.867B system-wide, 133.4M long-distance — only aggregates, no O-D breakdown. [https://ibir.deutschebahn.com/2024](https://ibir.deutschebahn.com/2024)
- **DB Integrated Report 2024**: DB Regio 562M passengers, 6,266M pkm — no per-route detail

### Popular Routes Data (Booking Volume Proxies)

- **Trainline**: Berlin–Munich, Frankfurt–Berlin, Frankfurt–Munich are top 3 DB routes by booking volume. [https://www.thetrainline.com](https://www.thetrainline.com)
- **zeustrain / EveryRail**: Confirm Berlin–Munich (504 km, ~3h52m, 32+ ICE daily), Hamburg–Berlin (256 km, ~1h45m), Frankfurt–Cologne (152 km, ~1h4m) as highest-frequency ICE corridors. [https://zeustrain.com](https://zeustrain.com)
- **railmonsters**: Adds international routes: München–Zürich, Stuttgart–Wien, München–Innsbruck. [https://railmonsters.com](https://railmonsters.com)
- **zug-ticket-kaufen.de**: Lists routes by connections/day as demand proxy. [https://zug-ticket-kaufen.de](https://zug-ticket-kaufen.de)

### DB Deutschlandticket Data

- **DB Top-20 PDF** (April 2024): Most-traveled regional routes by Deutschlandticket users — commuter and leisure splits. [https://deutschebahn.com](https://www.deutschebahn.com/resource/blb12841578/Grafik-1-Jahr-D-Ticket-data.pdf)
- ⚠️ Regional trains only, not long-distance ICE/IC

### Regulatory & Academic

- **Bundesnetzagentur Marktuntersuchung**: Annual reports with aggregate sector-level passenger-km by operator type — no O-D breakdown. [https://bundesnetzagentur.de](http://www.bundesnetzagentur.de/DE/Fachthemen/Eisenbahnen/Veroeffentlichungen/Marktuntersuchungen/start.html)

### Community / Open Source

- **piebro/deutsche-bahn-data** (GitHub + HuggingFace, CC BY 4.0): Timetable, delay, cancellation data from DB Timetables API — useful for route activity and operational richness. No price or booking data. [https://huggingface.co/datasets/piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data)

## Data Collection Strategies Under Evaluation

### Strategy A: Passive Longitudinal Sweep (Route Catalog)

Maintain a static catalog of ~200 route pairs using station tiers from `db-hafas-stations`:

| Tier                   | Examples                                                            | Count  |
| ---------------------- | ------------------------------------------------------------------- | ------ |
| Tier 1 — Major hubs    | Berlin, Hamburg, Munich, Frankfurt, Cologne, Stuttgart, Düsseldorf  | ~7–10  |
| Tier 2 — Regional hubs | Hannover, Leipzig, Nuremberg, Dresden, Dortmund, Mannheim, Freiburg | ~15–20 |
| Tier 3 — Medium cities | Monitored only if user watches                                      | —      |

Generate route pairs: Tier-1 × Tier-1 (~45 pairs), Tier-1 × Tier-2 (~150 pairs), plus any route a user watches.

Daily, query each route with `bestprice` flag for all trains departing in next 90 days. One observation per train per day builds up full time series.

- **API load:** ~200 routes × 90 days × 1 query = ~200 queries/day at steady state using `bestprice`
- **Pros:** Full horizon coverage (30–90d), no user dependency, pure background collection, covers high-traffic corridors
- **Cons:** Static catalog — misses niche regional routes, 1 snapshot/day may miss intra-day jumps

### Strategy B: Watched-Journey Enrichment + Persistence

Persist every price snapshot for every watched journey into a dedicated DynamoDB `PriceSnapshot` entity. Currently discarded — this is zero extra API cost.

Additionally, when a user starts watching a journey, immediately query ±7 days for sibling trains as baseline price context.

- **API load:** Same as current + tiny backfill burst on new watch
- **Pros:** Zero incremental cost, immediate start, builds per-journey time series
- **Cons:** Selection bias toward user-watched routes only (users only watch popular routes they care about - doesn't cover cold routes), still only covers tail (users typically watch 7–30 days before departure, so early horizon 30–90 days remains uncovered)

### Strategy C: User-Triggered Route Expansion

When a user starts watching a journey (e.g., ICE 123, Berlin→Munich, 27 April), auto-promote that route to active background collection for all departures in the next 90 days.

The user's interest reveals demand on a corridor — collect proactively for all future trains on it.

- **API load:** ~90 extra queries/route/day when first user watches a route, grows with user base
- **Pros:** Demand-driven — collects exactly where users care, no hardcoded catalog needed, covers early horizon for watched routes
- **Cons:** Cold start until first user watches a route, biased toward popular routes (actually desirable), rate-limit pressure if many users watch same route simultaneously

### Strategy D: Adaptive Sampling Frequency

Rather than uniform polling, match sampling frequency to how fast prices change at each time horizon:

| Days to departure | Poll frequency  | Rationale                            |
| ----------------- | --------------- | ------------------------------------ |
| >60 days          | Daily (1×)      | Prices nearly static, jumps rare     |
| 30–60 days        | Every 12h       | Early contingent exhaustion possible |
| 7–30 days         | Every 2–4h      | Active yield management phase        |
| <7 days           | Every 30–60 min | Rapid last-mile price volatility     |

Applies on top of any collection strategy. Dramatically improves data resolution at moments where jumps are most likely.

- **API load:** Non-linear — most queries concentrated in last 7 days for many simultaneous watched journeys
- **Pros:** Training data density matches event density, survival model accuracy improves most in volatile window
- **Cons:** Rate limit pressure close to departure for high volume of watched journeys

### Strategy E: Cross-Route Generalization via Cluster Proxies

Rather than collecting data for every possible OD pair, collect densely for **cluster representatives** (30–50 routes covering each cluster type: long-distance high-demand, medium-distance, regional, etc.) and use those to train models that generalize to unobserved routes via feature corrections (distance, service type, demand proxy).

Not a standalone collection strategy — it's a modeling decision that reduces how much breadth you actually need.

- **API load:** Reduces requirement from 200+ routes to 30–50 representative routes
- **Pros:** Feasible at hobbyist scale, covers cluster diversity
- **Con:** Requires good cluster definitions upfront

## Evaluation Criteria

Please evaluate each strategy (and suggest any additional strategies I may have missed) against:

1. **Performance:** How well does it cover the full time-to-departure horizon (especially 30–90 days)?
2. **Cost Effectiveness:** API call efficiency, especially given DB Vendo rate limits
3. **Robustness:** Resilience to rate limits, API downtime, cold-start problems
4. **Data Quality:** Rich features per observation (price, fare family, load factor, etc.)
5. **Scalability:** How does it handle growth in users, routes, and time?
6. **Cold Start:** How quickly can it build useful training data for a new route?

Also identify:

- Are there other public datasets, APIs, or data sources I should consider?
- Are there DB API nuances (rate limits, bestprice behavior, data freshness) I should be aware of?
- Any strategies that combine multiple approaches for synergistic coverage?
