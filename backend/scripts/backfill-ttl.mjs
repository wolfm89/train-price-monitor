// Gives journeys and notifications written before the table had a TTL
// attribute their `ttl`, so DynamoDB deletes them on the same schedule as new
// items (see src/lib/retention.ts). Run once per environment after the stack
// with `timeToLiveAttribute: 'ttl'` is deployed, from a machine with DynamoDB
// access:
//
//   node scripts/backfill-ttl.mjs --table TrainPriceMonitor --region eu-central-1
//
// Add --dry-run to print what would change without writing. Items whose new
// ttl already lies in the past are removed by DynamoDB shortly afterwards; that
// is the point. The script is idempotent: items that already have a ttl are
// skipped, and the conditional write never recreates an item deleted meanwhile.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { planTtlBackfill } from './backfill-ttl-lib.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

const region = argValue('region', process.env.AWS_REGION || 'eu-central-1');
const table = argValue('table', process.env.USER_TABLE_NAME || 'TrainPriceMonitor');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function scanJourneysAndNotifications() {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        // Only what the plan needs; `data`, `timestamp` and `ttl` are reserved words.
        ProjectionExpression: 'pk, sk, expires, #timestamp, #data, #ttl',
        FilterExpression: 'begins_with(sk, :journey) OR begins_with(sk, :notification)',
        ExpressionAttributeNames: { '#timestamp': 'timestamp', '#data': 'data', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':journey': 'JOURNEY#', ':notification': 'NOTIFICATION#' },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

const items = await scanJourneysAndNotifications();
const plan = planTtlBackfill(items);
const nowSeconds = Math.floor(Date.now() / 1000);
const alreadyDue = plan.updates.filter((update) => update.ttl <= nowSeconds).length;

console.log(
  `${dryRun ? 'DRY RUN: ' : ''}${items.length} journeys and notifications in ${table}; ` +
    `${plan.updates.length} need a ttl (${alreadyDue} already due), ${plan.skipped.length} skipped`
);
for (const entry of plan.skipped) {
  console.warn(`skip ${entry.sk}: ${entry.reason}`);
}

if (!dryRun) {
  let written = 0;
  let vanished = 0;
  for (const update of plan.updates) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: update.pk, sk: update.sk },
          UpdateExpression: 'SET #ttl = :ttl',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#ttl)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': update.ttl },
        })
      );
      written++;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        // Deleted, or given a ttl by the app, since the scan.
        vanished++;
        continue;
      }
      throw error;
    }
  }
  console.log(`summary: written=${written} changedMeanwhile=${vanished} skipped=${plan.skipped.length}`);
}
