/**
 * One-off repair for schedule items that the pre-clamp scheduler pushed to (or
 * past) their departure.
 *
 * `computeNextScrapeAt` now clamps, but the clamp only applies when an item is
 * next scraped. Items already scheduled at/after departure are never rescraped —
 * `selectDueTargets` deletes them as expired — so they are lost before the fix
 * can reach them. This script pulls them back inside the near window.
 *
 * Dry run by default:
 *   npx tsx src/scripts/repair-schedule.ts [--limit N]
 * Apply:
 *   npx tsx src/scripts/repair-schedule.ts --apply [--limit N]
 *
 * The table name comes from SCRAPER_TABLE_NAME (default: ScraperSchedule).
 * The table is provisioned at 5 RCU, so a full pass takes ~15 minutes; pages are
 * small and throttling is retried with backoff.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { computeTtdTier, dueKey, scheduleBounds } from '../ttd.js';
import { type ScheduleItem, type TtdTier } from '../types.js';

const TABLE_NAME = process.env.SCRAPER_TABLE_NAME ?? 'ScraperSchedule';
const PAGE_SIZE = 25;
/** Spread repaired items over this window instead of making them all due at once. */
const SPREAD_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 12 }), {
  marshallOptions: { removeUndefinedValues: true },
});

interface Options {
  apply: boolean;
  limit?: number;
}

interface Repair {
  pk: string;
  departureDate: string;
  from: string;
  to: string;
  tier: TtdTier;
  reason: 'enter-near' | 'due-now';
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit expects a positive integer');
      options.limit = value;
    } else if (arg === '--help' || arg === '-h') {
      log('Usage: repair-schedule [--apply] [--limit N]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function isThrottle(error: unknown): boolean {
  const name = (error as { name?: string }).name ?? '';
  return name === 'ProvisionedThroughputExceededException' || name === 'ThrottlingException';
}

async function withThrottleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isThrottle(error) || attempt >= 8) throw error;
      const waitMs = Math.min(30_000, 1000 * 2 ** attempt);
      log(`  throttled, retrying in ${waitMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function scanSchedule(limit?: number): Promise<ScheduleItem[]> {
  const items: ScheduleItem[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const page = await withThrottleRetry(() =>
      ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          Limit: PAGE_SIZE,
          ExclusiveStartKey: cursor,
        })
      )
    );
    items.push(...((page.Items ?? []) as ScheduleItem[]));
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (items.length % 500 === 0 || (!cursor && items.length > 0)) {
      log(`  scanned ${items.length} items`);
    }
  } while (cursor && (!limit || items.length < limit));

  return limit ? items.slice(0, limit) : items;
}

/** Decide the replacement for an item whose next scrape is at/after departure. */
function planRepair(item: ScheduleItem, now: Date): Repair | null {
  const { nearEntry, hardStop } = scheduleBounds(item.departure_date);
  const next = new Date(item.next_scrape_at);
  const nowMs = now.getTime();

  if (next.getTime() < hardStop.getTime()) return null;
  // Already past the last useful moment: leave it to expire.
  if (nowMs >= hardStop.getTime()) return null;

  const reason = nowMs < nearEntry.getTime() ? 'enter-near' : 'due-now';
  let target = reason === 'enter-near' ? nearEntry.getTime() : nowMs + Math.floor(Math.random() * SPREAD_MS);

  target = Math.min(target, hardStop.getTime() - MINUTE_MS);
  target = Math.max(target, nowMs + 1000);

  const at = new Date(target);
  return {
    pk: item.pk,
    departureDate: item.departure_date,
    from: item.next_scrape_at,
    to: at.toISOString(),
    tier: computeTtdTier(item.departure_date, at),
    reason,
  };
}

async function applyRepair(repair: Repair): Promise<void> {
  await withThrottleRetry(() =>
    ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: repair.pk, sk: 'SCHEDULE' },
        UpdateExpression: 'SET next_scrape_at = :next, due_key = :due, ttd_tier = :tier',
        ExpressionAttributeValues: {
          ':next': repair.to,
          ':due': dueKey(repair.tier, repair.to),
          ':tier': repair.tier,
        },
      })
    )
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();

  log(`table: ${TABLE_NAME}`);
  log(`mode:  ${options.apply ? 'APPLY' : 'DRY RUN'}${options.limit ? ` (limit ${options.limit})` : ''}`);
  log(`now:   ${now.toISOString()}`);

  const items = await scanSchedule(options.limit);
  const repairs = items.map((item) => planRepair(item, now)).filter((repair): repair is Repair => repair !== null);

  log(`scanned ${items.length} items, ${repairs.length} need repair`);
  const byReason = { 'enter-near': 0, 'due-now': 0 };
  for (const repair of repairs) byReason[repair.reason]++;
  log(`  enter-near: ${byReason['enter-near']}, due-now: ${byReason['due-now']}`);

  for (const repair of repairs.slice(0, 10)) {
    log(
      `  ${repair.departureDate} ${repair.pk.replace(/^ROUTE#/, '')} ` +
        `${repair.from} -> ${repair.to} (${repair.tier}, ${repair.reason})`
    );
  }
  if (repairs.length > 10) log(`  ... and ${repairs.length - 10} more`);

  if (!options.apply) {
    log('dry run: nothing written. Re-run with --apply to update the schedule.');
    return;
  }

  let written = 0;
  for (const repair of repairs) {
    await applyRepair(repair);
    written++;
    if (written % 100 === 0) log(`  updated ${written}/${repairs.length}`);
  }
  log(`updated ${written} items`);
}

await main();
