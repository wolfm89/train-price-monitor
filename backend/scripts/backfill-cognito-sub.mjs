// Binds existing User rows to their Cognito `sub` before the authorization
// guard is deployed.
//
// New accounts get `cognitoSub` from the verified token in createUser. Rows that
// predate that binding have no value, and the guard intentionally rejects them:
// auto-binding the first caller who presents a public `custom:id` would let an
// attacker claim someone else's row. Run this once per environment, from a
// machine with Cognito and DynamoDB admin access:
//
//   node scripts/backfill-cognito-sub.mjs \
//     --user-pool-id eu-central-1_XXXXXXXXX \
//     --table TrainPriceMonitor \
//     --region eu-central-1
//
// Add --dry-run to print what would change without writing.
//
// `custom:id` is client-chosen and not unique, so the script preflights the
// whole Cognito user list before writing: a custom:id shared by two accounts is
// ambiguous, and an unbound row is only bound when its email (and, when both
// sides have them, the immutable names) matches the Cognito user. Ambiguities
// and conflicts fail closed and prevent every write. The script is idempotent:
// rows already bound to the same sub are skipped, and a row bound to a
// different sub is reported as a conflict instead of overwritten.
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { groupUsersByCustomId, planBindings } from './backfill-cognito-sub-lib.mjs';

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
const userPoolId = argValue('user-pool-id', process.env.COGNITO_USER_POOL_ID);

if (!userPoolId) {
  throw new Error('Pass --user-pool-id or set COGNITO_USER_POOL_ID');
}

const cognito = new CognitoIdentityProviderClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

async function listCognitoUsers() {
  const users = [];
  let paginationToken;
  do {
    const page = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        PaginationToken: paginationToken,
      })
    );
    users.push(...(page.Users ?? []));
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return users;
}

/** Reads every relevant User row before any decision or write. */
async function loadUserRows(users) {
  const rows = new Map();
  for (const customId of groupUsersByCustomId(users).keys()) {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { pk: `USER#${customId}`, sk: 'METADATA#' },
      })
    );
    if (Item) rows.set(customId, Item);
  }
  return rows;
}

function printPlan(plan) {
  for (const entry of plan.skipped) {
    console.warn(`skip ${entry.username}: ${entry.reason}`);
  }
  for (const entry of plan.missingRow) {
    console.warn(`skip ${entry.customId}: no User row in ${table} (sub ${entry.sub})`);
  }
  for (const entry of plan.alreadyBound) {
    console.log(`ok   ${entry.customId}: already bound to ${entry.sub}`);
  }
  for (const entry of plan.ambiguous) {
    const users = entry.users.map((user) => `${user.username}=${user.sub}`).join(', ');
    console.error(`AMBIGUOUS ${entry.customId}: ${users}`);
  }
  for (const entry of plan.conflicts) {
    console.error(`FAIL ${entry.customId} (${entry.username}): ${entry.reason}`);
  }
  if (dryRun) {
    for (const entry of plan.bindings) {
      console.log(`would bind ${entry.customId} -> ${entry.sub}`);
    }
  }
}

function printSummary(counts) {
  console.log(
    `summary: bound=${counts.bound} alreadyBound=${counts.alreadyBound} missingRow=${counts.missingRow} ` +
      `conflict=${counts.conflict} ambiguous=${counts.ambiguous} skipped=${counts.skipped}`
  );
}

const users = await listCognitoUsers();
console.log(`${dryRun ? 'DRY RUN: ' : ''}${users.length} Cognito users in ${userPoolId}, table ${table}`);

const rows = await loadUserRows(users);
const plan = planBindings(users, rows);
printPlan(plan);

const counts = {
  bound: 0,
  alreadyBound: plan.alreadyBound.length,
  missingRow: plan.missingRow.length,
  conflict: plan.conflicts.length,
  ambiguous: plan.ambiguous.length,
  skipped: plan.skipped.length,
};

if (plan.ambiguous.length > 0 || plan.conflicts.length > 0) {
  console.error('Refusing to write: resolve the ambiguous or conflicting bindings first.');
  if (dryRun) {
    console.log(`wouldBind=${plan.bindings.length}`);
  }
  printSummary(counts);
  process.exitCode = 1;
} else if (dryRun) {
  console.log(`wouldBind=${plan.bindings.length}`);
  printSummary(counts);
} else {
  for (const entry of plan.bindings) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: `USER#${entry.customId}`, sk: 'METADATA#' },
          UpdateExpression: 'SET cognitoSub = :sub',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(cognitoSub)',
          ExpressionAttributeValues: { ':sub': entry.sub },
        })
      );
      counts.bound++;
      console.log(`bind ${entry.customId} -> ${entry.sub}`);
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        const { Item: current } = await ddb.send(
          new GetCommand({
            TableName: table,
            Key: { pk: `USER#${entry.customId}`, sk: 'METADATA#' },
          })
        );
        if (current?.cognitoSub === entry.sub) {
          counts.alreadyBound++;
          console.log(`ok   ${entry.customId}: bound concurrently`);
          continue;
        }
        counts.conflict++;
        console.error(`FAIL ${entry.customId}: concurrent binding changed the row`);
        process.exitCode = 1;
        break;
      }
      throw error;
    }
  }
  printSummary(counts);
  if (counts.conflict > 0) {
    process.exitCode = 1;
  }
}
