import { User, Notification } from './model/trainPriceMonitor';
import { S3Manager } from './managers/S3Manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Manager();

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
};

export type GraphQLContext = {
  entities: Entities;
  s3: S3Manager;
};

export async function createContext(): Promise<GraphQLContext> {
  return { entities: { User, Notification }, s3 };
}
