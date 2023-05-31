import { DynamoDBManager } from './dynamodb/DynamoDbManager';

const dynamodb = new DynamoDBManager();

export type GraphQLContext = {
  dynamodb: DynamoDBManager;
};

export async function createContext(): Promise<GraphQLContext> {
  return { dynamodb };
}
