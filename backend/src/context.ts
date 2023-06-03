import { DynamoDBManager } from './managers/DynamoDbManager';
import { S3Manager } from './managers/S3Manager';

const dynamodb = new DynamoDBManager();
const s3 = new S3Manager();

export type GraphQLContext = {
  dynamodb: DynamoDBManager;
  s3: S3Manager;
};

export async function createContext(): Promise<GraphQLContext> {
  return { dynamodb, s3 };
}
