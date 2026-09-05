import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Journey, Leg } from 'hafas-client';

import { type ScheduleItem, type ParquetRow, type TtdTier } from './types.js';
import { rowsToParquet } from './parquet.js';
import { computeTtdTier, computeNextScrapeAt } from './ttd.js';
import { positiveIntFromEnv } from './env.js';
import { fetchDayJourneys } from './client.js';
import { ROUTE_CATALOG } from './routes.js';

const logger = new Logger({ serviceName: 'scraper-poller' });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client(process.env.AWS_ENDPOINT_URL ? { forcePathStyle: true } : {});

const TABLE_NAME = process.env.SCRAPER_TABLE_NAME!;
const BUCKET_NAME = process.env.SCRAPER_BUCKET_NAME!;

/**
 * Max targets per invocation. Each target = 2 API calls.
 *
 * Tunable via env so the cadence/batch trade-off can be adjusted against the
 * Lambda free tier without a code change. Routing requests through a real
 * browser (see ../../shared/browser-fetch.ts) costs ~2.5 s per API call
 * instead of ~0.5 s, and needs 1024 MB instead of 256 MB, so the sustainable
 * batch is much smaller than it was for the raw-HTTP transport.
 */
const BATCH_SIZE = positiveIntFromEnv('SCRAPER_BATCH_SIZE', 10, logger);
/** Abort if elapsed exceeds this many milliseconds. Must stay below the
 * function timeout (180 s) with enough room to finish the current target. */
const ABORT_THRESHOLD_MS = 150_000;
/**
 * Sleep between targets to spread API load.
 *
 * Zero because the browser transport already self-throttles: a single API call
 * now takes ~2.5 s end to end, which is *more* spacing than the ~2.0 s the old
 * raw-HTTP path achieved with a 1.5 s sleep between ~0.5 s calls. Keeping the
 * sleep would add pure billed idle time (~29% of each run) for no extra
 * pacing. Verified against the live API: 20 back-to-back browser requests all
 * returned 201 with no rate limiting.
 */
const INTER_TARGET_SLEEP_MS = 0;

const routeById = new Map(ROUTE_CATALOG.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the dominant load factor from a journey's legs.
 * Priority: very-high > high > low > null
 */
function extractLoadFactor(journey: Journey): string | null {
  const legs = (journey.legs ?? []) as Leg[];
  const factors = legs.map((l) => (l as unknown as { loadFactor?: string }).loadFactor).filter(Boolean) as string[];
  if (factors.includes('very-high')) return 'very-high';
  if (factors.includes('high')) return 'high';
  if (factors.length > 0) return 'low';
  return null;
}

/**
 * Build ParquetRow entries from a list of journeys returned by the API.
 * One row per journey.
 */
function buildRows(
  journeys: Journey[],
  serviceClass: 1 | 2,
  routeId: string,
  originEva: string,
  originName: string,
  destEva: string,
  destName: string,
  observedAt: Date
): ParquetRow[] {
  const rows: ParquetRow[] = [];

  for (const j of journeys) {
    if (!j.price?.amount) continue; // skip journeys without a price

    const legs = (j.legs ?? []) as Leg[];
    if (legs.length === 0) continue;

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    const depPlanned = firstLeg.plannedDeparture ? new Date(firstLeg.plannedDeparture) : null;
    const arrPlanned = lastLeg.plannedArrival ? new Date(lastLeg.plannedArrival) : null;
    if (!depPlanned || !arrPlanned) continue;

    const durationMs = arrPlanned.getTime() - depPlanned.getTime();
    const durationMinutes = Math.round(durationMs / 60_000);
    const daysToDeparture = (depPlanned.getTime() - observedAt.getTime()) / (24 * 60 * 60 * 1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const line = (firstLeg as any).line;
    const trainType: string = line?.productName ?? line?.product ?? 'UNKNOWN';
    const trainNumber: string = line?.name ?? 'UNKNOWN';

    rows.push({
      observed_at: observedAt,
      service_class: serviceClass,
      route_id: routeId,
      origin_eva: originEva,
      origin_name: originName,
      dest_eva: destEva,
      dest_name: destName,
      departure_planned: depPlanned,
      arrival_planned: arrPlanned,
      train_type: trainType,
      train_number: trainNumber,
      transfers: Math.max(0, legs.length - 1),
      duration_minutes: durationMinutes,
      days_to_departure: daysToDeparture,
      fare_lowest_eur: j.price.amount,
      load_factor: extractLoadFactor(j),
    });
  }

  return rows;
}

/**
 * Write an aggregated Parquet batch file to S3.
 * Key layout: prices/year=YYYY/month=MM/day=DD/batch_{epoch}_{random}.parquet
 */
async function writeToS3(rows: ParquetRow[], observedAt: Date): Promise<void> {
  const buffer = rowsToParquet(rows);

  const y = observedAt.getUTCFullYear();
  const m = String(observedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(observedAt.getUTCDate()).padStart(2, '0');
  const epoch = Math.floor(observedAt.getTime() / 1000);
  const randomSuffix = Math.floor(Math.random() * 1000000).toString(36);
  const key = `prices/year=${y}/month=${m}/day=${d}/batch_${epoch}_${randomSuffix}.parquet`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: new Uint8Array(buffer),
      ContentType: 'application/octet-stream',
    })
  );

  logger.info('Parquet written to S3', { key, rows: rows.length });
}

/**
 * Update the DynamoDB schedule item after a successful scrape.
 */
async function markScraped(item: ScheduleItem, now: Date, newTier: TtdTier): Promise<void> {
  const nextScrapeAt = computeNextScrapeAt(newTier, now);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: item.pk, sk: 'SCHEDULE' },
      UpdateExpression:
        'SET next_scrape_at = :next, last_scraped_at = :now, ttd_tier = :tier, scrape_count = if_not_exists(scrape_count, :zero) + :inc',
      ExpressionAttributeValues: {
        ':next': nextScrapeAt.toISOString(),
        ':now': now.toISOString(),
        ':tier': newTier,
        ':inc': 1,
        ':zero': 0,
      },
    })
  );
}

/**
 * Reschedule a target for a short retry (used on 429 or transient errors).
 */
async function scheduleRetry(item: ScheduleItem, delayMs: number, now: Date): Promise<void> {
  const retryAt = new Date(now.getTime() + delayMs);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: item.pk, sk: 'SCHEDULE' },
      UpdateExpression: 'SET next_scrape_at = :next',
      ExpressionAttributeValues: { ':next': retryAt.toISOString() },
    })
  );
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (): Promise<void> => {
  const start = Date.now();
  const now = new Date(start);

  // Query GSI for targets that are due
  const queryResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ByNextScrape',
      KeyConditionExpression: '#status = :pending AND next_scrape_at <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now.toISOString() },
      Limit: BATCH_SIZE,
    })
  );

  const targets = (queryResult.Items ?? []) as ScheduleItem[];
  logger.info('Poller started', { targets: targets.length });

  if (targets.length === 0) {
    return;
  }

  const allBatchRows: ParquetRow[] = [];

  for (const target of targets) {
    // Abort if we're approaching the Lambda timeout
    if (Date.now() - start > ABORT_THRESHOLD_MS) {
      logger.warn('Approaching timeout, aborting batch');
      break;
    }

    const route = routeById.get(target.route_id);
    if (!route) {
      logger.error('Unknown route_id', { route_id: target.route_id });
      continue;
    }

    const departureDate = new Date(`${target.departure_date}T12:00:00Z`);
    const observedAt = now;

    try {
      // Two API calls: 2nd class and 1st class
      const [journeys2nd, journeys1st] = await Promise.all([
        fetchDayJourneys(route.originEva, route.destEva, departureDate, false),
        fetchDayJourneys(route.originEva, route.destEva, departureDate, true),
      ]);

      const rows2nd = buildRows(
        journeys2nd,
        2,
        route.id,
        route.originEva,
        route.originName,
        route.destEva,
        route.destName,
        observedAt
      );
      const rows1st = buildRows(
        journeys1st,
        1,
        route.id,
        route.originEva,
        route.originName,
        route.destEva,
        route.destName,
        observedAt
      );
      const allRows = [...rows2nd, ...rows1st];

      if (allRows.length === 0) {
        logger.warn('No priced rows returned', { route_id: target.route_id, departure_date: target.departure_date });
      } else {
        allBatchRows.push(...allRows);
      }

      // Reschedule based on updated TTD
      const newTier = computeTtdTier(target.departure_date, observedAt);
      await markScraped(target, observedAt, newTier);

      logger.info('Target scraped', {
        route_id: target.route_id,
        departure_date: target.departure_date,
        rows2nd: rows2nd.length,
        rows1st: rows1st.length,
        newTier,
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
        logger.warn('Rate limited by Vendo API', { route_id: target.route_id });
        await scheduleRetry(target, 5 * 60 * 1000, observedAt); // retry in 5 min
      } else {
        // Leave next_scrape_at unchanged so the next invocation retries
        logger.error('Failed to scrape target', {
          route_id: target.route_id,
          departure_date: target.departure_date,
          err: msg,
        });
      }
      continue;
    }

    // Brief pause between targets to spread API load
    if (Date.now() - start < ABORT_THRESHOLD_MS) {
      await sleep(INTER_TARGET_SLEEP_MS);
    }
  }

  if (allBatchRows.length > 0) {
    await writeToS3(allBatchRows, now);
  }

  logger.info('Poller finished', { elapsedMs: Date.now() - start });
};
