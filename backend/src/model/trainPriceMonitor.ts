import { Table, Entity } from 'dynamodb-toolbox';
import { GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand } from 'dynamodb-toolbox';
import { QueryCommand, ScanCommand } from 'dynamodb-toolbox';
import { item, string, number, boolean } from 'dynamodb-toolbox/schema';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const marshallOptions = {
  convertEmptyValues: true,
  removeUndefinedValues: true,
};

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const documentClient = DynamoDBDocumentClient.from(dynamoDBClient, { marshallOptions });

const TrainPriceMonitorTable = new Table({
  name: 'TrainPriceMonitor',
  partitionKey: { name: 'pk', type: 'string' },
  sortKey: { name: 'sk', type: 'string' },
  documentClient,
});

export const User = new Entity({
  name: 'User',
  table: TrainPriceMonitorTable,
  schema: item({
    id: string().key(),
    sk: string().hidden().default('METADATA#'),
    email: string().required(),
    givenName: string().required(),
    familyName: string().optional(),
    profilePicture: string().optional(),
    emailNotificationsEnabled: boolean().default(true).required(),
    loyaltyCards: string().optional(),
    ageGroup: string().optional(),
    deutschlandTicketDiscount: boolean().optional(),
    // Cognito `sub` bound to this row when the account is created. The
    // authorization guard compares it with the verified token, so it must never
    // be accepted from a GraphQL argument. Optional because rows that predate
    // the binding are backfilled by scripts/backfill-cognito-sub.mjs.
    cognitoSub: string().optional(),
  }),
  computeKey: ({ id }) => ({
    pk: `USER#${id}`,
    sk: 'METADATA#',
  }),
});

/**
 * Shape of a stored `User` item as read back from DynamoDB.
 */
export interface StoredUser {
  id: string;
  email: string;
  givenName: string;
  familyName?: string;
  profilePicture?: string;
  emailNotificationsEnabled: boolean;
  loyaltyCards?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
  cognitoSub?: string;
}

export const Notification = new Entity({
  name: 'Notification',
  table: TrainPriceMonitorTable,
  schema: item({
    userId: string().key(),
    id: string().key(),
    type: string().required(),
    timestamp: string().required(),
    read: boolean().default(false).required(),
    sent: boolean().default(false).required(),
    data: string().optional(),
    // DynamoDB TTL (epoch seconds), see lib/retention.ts.
    ttl: number().optional(),
  }),
  computeKey: ({ userId, id }) => ({
    pk: `USER#${userId}`,
    sk: `NOTIFICATION#${id}`,
  }),
});

export const Journey = new Entity({
  name: 'Journey',
  table: TrainPriceMonitorTable,
  schema: item({
    userId: string().key(),
    id: string().key(),
    limitPrice: number().required(),
    refreshToken: string().required(),
    expires: string().required(),
    fromId: string().required(),
    toId: string().required(),
    departure: string().required(),
    firstClass: boolean().optional(),
    bike: boolean().optional(),
    loyaltyCard: string().optional(),
    ageGroup: string().optional(),
    deutschlandTicketDiscount: boolean().optional(),
    // Snapshot of the last successful DB lookup. The read path (watchlist)
    // serves these fields instead of querying DB, so rendering the watchlist
    // costs no network calls and keeps working while DB is unreachable.
    // Written by the refresher; absence of `lastCheckedAt` means "never
    // successfully fetched", which the API reports as `unavailable`.
    cachedPrice: number().optional(),
    cachedDeparture: string().optional(),
    cachedArrival: string().optional(),
    cachedMeans: string().optional(),
    cachedFrom: string().optional(),
    cachedTo: string().optional(),
    lastCheckedAt: string().optional(),
    // DynamoDB TTL (epoch seconds), see lib/retention.ts.
    ttl: number().optional(),
  }),
  computeKey: ({ userId, id }) => ({
    pk: `USER#${userId}`,
    sk: `JOURNEY#${id}`,
  }),
});

/**
 * Shape of a stored `Journey` item as read back from DynamoDB, including the
 * cached snapshot written by the refresher.
 */
export interface StoredJourney {
  userId: string;
  id: string;
  limitPrice: number;
  refreshToken: string;
  expires: string;
  fromId: string;
  toId: string;
  departure: string;
  firstClass?: boolean;
  bike?: boolean;
  loyaltyCard?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
  cachedPrice?: number;
  cachedDeparture?: string;
  cachedArrival?: string;
  cachedMeans?: string;
  cachedFrom?: string;
  cachedTo?: string;
  lastCheckedAt?: string;
  ttl?: number;
}

export {
  TrainPriceMonitorTable,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
};
