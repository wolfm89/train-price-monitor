// Deletes SES email identities of Train Price Monitor accounts that no longer
// exist (see cleanup-ses-identities-lib.mjs). Run once, after the stack that
// grants ses:DeleteEmailIdentity is deployed, from a machine with SES and
// DynamoDB access:
//
//   node scripts/cleanup-ses-identities.mjs --keep trainpricemonitor@wolfgangmoser.eu --dry-run
//   node scripts/cleanup-ses-identities.mjs --keep trainpricemonitor@wolfgangmoser.eu
//
// --keep is required (the sender identity) and may be repeated. Identities of
// current users stay: in the sandbox they are needed to receive alerts. After
// SES production access, docs/privacy/email-and-ses.md removes all of them.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteEmailIdentityCommand, ListEmailIdentitiesCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { maskEmail, planIdentityCleanup } from './cleanup-ses-identities-lib.mjs';

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

function argValues(name) {
  return args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : [])).filter(Boolean);
}

const region = argValue('region', process.env.AWS_REGION || 'eu-central-1');
const table = argValue('table', process.env.USER_TABLE_NAME || 'TrainPriceMonitor');
const keep = argValues('keep');

if (keep.length === 0) {
  throw new Error('Pass --keep <sender address> so the sender identity is never deleted');
}

const ses = new SESv2Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function listIdentities() {
  const identities = [];
  let nextToken;
  do {
    const page = await ses.send(new ListEmailIdentitiesCommand({ NextToken: nextToken, PageSize: 1000 }));
    identities.push(...(page.EmailIdentities ?? []));
    nextToken = page.NextToken;
  } while (nextToken);
  return identities;
}

async function listUserEmails() {
  const emails = [];
  let exclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'email',
        FilterExpression: 'sk = :metadata',
        ExpressionAttributeValues: { ':metadata': 'METADATA#' },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    emails.push(...(page.Items ?? []).map((item) => item.email));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return emails;
}

const [identities, userEmails] = await Promise.all([listIdentities(), listUserEmails()]);
const { toDelete, kept } = planIdentityCleanup(identities, userEmails, keep);

console.log(
  `${dryRun ? 'DRY RUN: ' : ''}${identities.length} SES identities, ${userEmails.length} users; ` +
    `${toDelete.length} orphaned email identities, ${kept} kept`
);

for (const address of toDelete) {
  if (dryRun) {
    console.log(`would delete ${maskEmail(address)}`);
    continue;
  }
  await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: address }));
  console.log(`deleted ${maskEmail(address)}`);
}
