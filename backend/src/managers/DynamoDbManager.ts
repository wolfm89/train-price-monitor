import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  AttributeValue,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

// Define a class for managing the DynamoDB connection and operations
export class DynamoDBManager {
  private dynamodb: DynamoDBClient;

  constructor() {
    // Initialize the DynamoDB client
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
  }

  async put(tableName: string, params: { [key: string]: any }): Promise<void> {
    const cmd = new PutItemCommand({
      TableName: tableName,
      Item: params,
    });
    await this.dynamodb.send(cmd);
  }

  async update(
    tableName: string,
    key: Record<string, AttributeValue>,
    valueMap: Record<string, AttributeValue>
  ): Promise<Record<string, AttributeValue>> {
    const placeholders = Object.entries(valueMap)
      .map(([key]) => `${key} = :${key}`)
      .join(', ');
    const expressionAttributeValues = Object.entries(valueMap).reduce(
      (result, [key, value]) => ({
        ...result,
        [`:${key}`]: value,
      }),
      {}
    );
    const cmd = new UpdateItemCommand({
      TableName: tableName,
      Key: key,
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeValues: expressionAttributeValues,
      UpdateExpression: `SET ${placeholders}`,
    });
    const result = await this.dynamodb.send(cmd);
    return result.Attributes!;
  }

  async get(
    tableName: string,
    key: Record<string, AttributeValue>,
    ...attributes: string[]
  ): Promise<Record<string, AttributeValue>> {
    const cmd = new GetItemCommand({
      TableName: tableName,
      Key: key,
      ...(attributes.length != 0 && { ProjectionExpression: attributes.join(',') }),
    });
    const result = await this.dynamodb.send(cmd);
    return result.Item!;
  }
}
