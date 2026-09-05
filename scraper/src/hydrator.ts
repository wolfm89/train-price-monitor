import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { ROUTE_CATALOG } from './routes.js';
import { computeTtdTier, computeNextScrapeAt } from './ttd.js';
import { positiveIntFromEnv } from './env.js';

const logger = new Logger({ serviceName: 'scraper-hydrator' });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.SCRAPER_TABLE_NAME!;
const LOOKAHEAD_DAYS = positiveIntFromEnv('HYDRATOR_LOOKAHEAD_DAYS', 60, logger);

/**
 * How many of the furthest-out days to (re-)seed on a normal run.
 *
 * Only one day actually becomes newly visible per night, but seeding a small
 * window absorbs missed or failed runs without needing a full re-seed. The
 * previous behaviour re-seeded the entire lookahead window every night: with
 * 140 routes x 90 days that is 12,600 conditional writes against a table
 * provisioned at 5 WCU — about 42 minutes of write capacity, which no Lambda
 * can complete, so the function timed out and retried nightly without ever
 * finishing. Failed conditional writes still consume write capacity, so the
 * 99% of writes that were no-ops were exactly what exhausted the budget.
 */
const SEED_WINDOW_DAYS = positiveIntFromEnv('HYDRATOR_SEED_WINDOW_DAYS', 3, logger);

/**
 * Seed the whole lookahead window instead of just the newest days, and delete
 * rows beyond it. Intended for one-off backfills after a schema/horizon change,
 * invoked manually — a full seed needs far more write capacity than a nightly
 * run, so it must not be the scheduled behaviour.
 */
const FULL_SEED = process.env.HYDRATOR_FULL_SEED === '1';

/**
 * Write all items using PutCommand with ConditionExpression to avoid overwriting existing rows.
 * Process items in concurrency-limited chunks.
 */
async function writeAllItems(
  items: Record<string, unknown>[]
): Promise<{ written: number; skipped: number; failed: number }> {
  let written = 0;
  let skipped = 0;
  let failed = 0;

  const CONCURRENCY = 50;
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    chunks.push(items.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (item) => {
        try {
          await ddb.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk)',
            })
          );
          return 'written';
        } catch (err: any) {
          if (err.name === 'ConditionalCheckFailedException') {
            return 'skipped';
          }
          throw err;
        }
      })
    );

    for (const res of results) {
      if (res.status === 'fulfilled') {
        if (res.value === 'written') {
          written++;
        } else {
          skipped++;
        }
      } else {
        failed++;
        logger.error('Failed to write item', { err: String(res.reason) });
      }
    }
  }

  return { written, skipped, failed };
}

/**
 * Delete PENDING rows whose departure lies beyond the current lookahead window.
 *
 * Shrinking the horizon would otherwise leave the now-out-of-range rows in
 * place: their TTL is keyed on departure, so they would linger for months while
 * still being returned as due and consuming the poller's scrape budget.
 */
async function pruneBeyondHorizon(horizonDateStr: string): Promise<number> {
  let deleted = 0;
  let cursor: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByNextScrape',
        KeyConditionExpression: '#status = :pending',
        FilterExpression: 'departure_date > :horizon',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': 'PENDING', ':horizon': horizonDateStr },
        ExclusiveStartKey: cursor as Record<string, never> | undefined,
      })
    );

    for (const item of page.Items ?? []) {
      await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: item.pk, sk: item.sk } }));
      deleted++;
    }

    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return deleted;
}

export const handler = async (): Promise<void> => {
  const now = new Date();

  // Normal runs only seed the far end of the window; everything closer was
  // seeded by earlier runs and is being actively scraped.
  const startDay = FULL_SEED ? 0 : Math.max(0, LOOKAHEAD_DAYS - SEED_WINDOW_DAYS);

  logger.info('Hydrator started', {
    routeCount: ROUTE_CATALOG.length,
    lookaheadDays: LOOKAHEAD_DAYS,
    startDay,
    fullSeed: FULL_SEED,
  });

  // Build all schedule items in memory first (no I/O)
  const items: Record<string, unknown>[] = [];

  for (const route of ROUTE_CATALOG) {
    for (let d = startDay; d < LOOKAHEAD_DAYS; d++) {
      const departureDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
      const departureDateStr = departureDate.toISOString().slice(0, 10);

      const tier = computeTtdTier(departureDateStr, now);
      // Spread initial scrapes randomly across the first interval window
      const nextScrapeAt = computeNextScrapeAt(tier, now);

      // TTL: two days after departure so DynamoDB auto-expires stale rows
      const departureMidnight = new Date(`${departureDateStr}T00:00:00Z`);
      const ttl = Math.floor(departureMidnight.getTime() / 1000) + 2 * 86_400;

      items.push({
        pk: `ROUTE#${route.id}#DATE#${departureDateStr}`,
        sk: 'SCHEDULE',
        route_id: route.id,
        departure_date: departureDateStr,
        origin_eva: route.originEva,
        dest_eva: route.destEva,
        status: 'PENDING',
        next_scrape_at: nextScrapeAt.toISOString(),
        ttd_tier: tier,
        scrape_count: 0,
        created_at: now.toISOString(),
        ttl,
      });
    }
  }

  logger.info('Starting conditional writes', { totalItems: items.length });

  const { written, skipped, failed } = await writeAllItems(items);

  logger.info('Hydration complete', { written, skipped, failed, totalItems: items.length });

  if (FULL_SEED) {
    const horizon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + LOOKAHEAD_DAYS - 1));
    const pruned = await pruneBeyondHorizon(horizon.toISOString().slice(0, 10));
    logger.info('Pruned rows beyond lookahead horizon', { pruned, horizon: horizon.toISOString().slice(0, 10) });
  }
};
