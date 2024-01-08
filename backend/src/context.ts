import { Cache } from '@graphql-yoga/plugin-response-cache';
import { User, Notification, Journey } from './model/trainPriceMonitor';
import { S3Manager } from './managers/S3Manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DbHafasManager } from './managers/DbHafasManager';
import dotenv from 'dotenv';
import { SQSManager } from './managers/SQSManager';

dotenv.config();
const TPM_SQS_QUEUE_URL = process.env.TPM_SQS_QUEUE_URL;

if (!TPM_SQS_QUEUE_URL) {
  throw new Error('TPM_SQS_QUEUE_URL is not defined in process.env');
}

const s3 = new S3Manager();
const sqs = new SQSManager(TPM_SQS_QUEUE_URL);
const dbHafas = new DbHafasManager();

const marshallOptions = {
  // Whether to automatically convert empty strings, blobs, and sets to `null`.
  convertEmptyValues: true,
  // Whether to remove undefined values while marshalling.
  removeUndefinedValues: true,
};

if (!User.table) {
  throw new Error('Table is not initialized');
}
const translateConfig = { marshallOptions };
User.table.DocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  translateConfig
);

type Entities = {
  User: typeof User;
  Notification: typeof Notification;
  Journey: typeof Journey;
};

export type GraphQLContext = {
  cache: Cache;
  entities: Entities;
  s3: S3Manager;
  sqs: SQSManager;
  dbHafas: DbHafasManager;
};

export async function createContext(cache: Cache): Promise<GraphQLContext> {
  return { cache, entities: { User, Notification, Journey }, s3, sqs, dbHafas };
}
