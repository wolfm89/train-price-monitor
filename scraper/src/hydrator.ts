import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { ROUTE_CATALOG } from './routes.js';
import { computeTtdTier, computeNextScrapeAt } from './ttd.js';

const logger = new Logger({ serviceName: 'scraper-hydrator' });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.SCRAPER_TABLE_NAME!;
const LOOKAHEAD_DAYS = Number(process.env.HYDRATOR_LOOKAHEAD_DAYS ?? 90);

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

export const handler = async (): Promise<void> => {
  const now = new Date();
  logger.info('Hydrator started', { routeCount: ROUTE_CATALOG.length, lookaheadDays: LOOKAHEAD_DAYS });

  // Check which routes are already seeded for tomorrow
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const CONCURRENCY = 50;
  const seededRoutes = new Set<string>();

  const routeChunks: (typeof ROUTE_CATALOG)[] = [];
  for (let i = 0; i < ROUTE_CATALOG.length; i += CONCURRENCY) {
    routeChunks.push(ROUTE_CATALOG.slice(i, i + CONCURRENCY));
  }

  for (const chunk of routeChunks) {
    await Promise.all(
      chunk.map(async (route) => {
        try {
          const getRes = await ddb.send(
            new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: `ROUTE#${route.id}#DATE#${tomorrowStr}`,
                sk: 'SCHEDULE',
              },
            })
          );
          if (getRes.Item) {
            seededRoutes.add(route.id);
          }
        } catch (err) {
          logger.warn('Failed to probe route seeding status', { routeId: route.id, err: String(err) });
        }
      })
    );
  }

  logger.info('Route seeding scan complete', { seededCount: seededRoutes.size });

  // Build all schedule items in memory first (no I/O)
  const items: Record<string, unknown>[] = [];

  for (const route of ROUTE_CATALOG) {
    const startDay = 0;

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
};
