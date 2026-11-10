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
// The script is idempotent: rows already bound to the same sub are skipped, and
// a row bound to a different sub is reported as a conflict instead of overwritten.
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

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

const attributesOf = (user) =>
  Object.fromEntries((user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value]));

const counts = { bound: 0, alreadyBound: 0, missingRow: 0, conflict: 0, skipped: 0 };

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

async function bindUser(user) {
  const attributes = attributesOf(user);
  const sub = attributes.sub;
  const customId = attributes['custom:id'];

  if (!sub || !customId) {
    counts.skipped++;
    console.warn(`skip ${user.Username}: missing sub or custom:id`);
    return;
  }

  const key = { pk: `USER#${customId}`, sk: 'METADATA#' };
  const { Item: row } = await ddb.send(
    new GetCommand({
      TableName: table,
      Key: key,
    })
  );

  if (!row) {
    counts.missingRow++;
    console.warn(`skip ${customId}: no User row in ${table} (sub ${sub})`);
    return;
  }

  if (row.cognitoSub) {
    if (row.cognitoSub === sub) {
      counts.alreadyBound++;
      console.log(`ok   ${customId}: already bound to ${sub}`);
    } else {
      counts.conflict++;
      console.error(`FAIL ${customId}: row is bound to ${row.cognitoSub}, Cognito says ${sub}`);
    }
    return;
  }

  if (dryRun) {
    counts.bound++;
    console.log(`would bind ${customId} -> ${sub}`);
    return;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: 'SET cognitoSub = :sub',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(cognitoSub)',
        ExpressionAttributeValues: { ':sub': sub },
      })
    );
    counts.bound++;
    console.log(`bind ${customId} -> ${sub}`);
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      const { Item: current } = await ddb.send(new GetCommand({ TableName: table, Key: key }));
      if (current?.cognitoSub === sub) {
        counts.alreadyBound++;
        console.log(`ok   ${customId}: bound concurrently`);
        return;
      }
      counts.conflict++;
      console.error(`FAIL ${customId}: concurrent binding changed the row`);
      return;
    }
    throw error;
  }
}

const users = await listCognitoUsers();
console.log(`${dryRun ? 'DRY RUN: ' : ''}${users.length} Cognito users in ${userPoolId}, table ${table}`);

for (const user of users) {
  await bindUser(user);
}

console.log(
  `summary: bound=${counts.bound} alreadyBound=${counts.alreadyBound} missingRow=${counts.missingRow} conflict=${counts.conflict} skipped=${counts.skipped}`
);

if (counts.conflict > 0) {
  process.exitCode = 1;
}
