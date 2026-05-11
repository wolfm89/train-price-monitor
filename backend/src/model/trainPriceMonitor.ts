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
  }),
  computeKey: ({ id }) => ({
    pk: `USER#${id}`,
    sk: 'METADATA#',
  }),
});

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
  }),
  computeKey: ({ userId, id }) => ({
    pk: `USER#${userId}`,
    sk: `JOURNEY#${id}`,
  }),
});

export {
  TrainPriceMonitorTable,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
};
