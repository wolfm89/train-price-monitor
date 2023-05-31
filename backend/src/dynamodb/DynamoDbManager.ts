import AWS from 'aws-sdk';
import { DynamoDB } from 'aws-sdk';

// Define a class for managing the DynamoDB connection and operations
export class DynamoDBManager {
  private dynamodb: DynamoDB.DocumentClient;

  constructor() {
    // Set the AWS_PROFILE environment variable
    process.env.AWS_PROFILE = 'wolfgang_local_dev';

    // Configure the DynamoDB client with AWS SDK
    AWS.config.update({ region: 'eu-central-1' });
    // Initialize the DynamoDB client
    this.dynamodb = new AWS.DynamoDB.DocumentClient();
  }

  async put(tableName: string, params: { [key: string]: any }): Promise<void> {
    await this.dynamodb
      .put({
        TableName: tableName,
        Item: params,
      })
      .promise();
  }

  async get(
    tableName: string,
    key: DynamoDB.GetItemInput['Key'],
    ...attributes: string[]
  ): Promise<DynamoDB.AttributeMap | undefined> {
    const result = await this.dynamodb
      .get({
        TableName: tableName,
        Key: key,
        ProjectionExpression: attributes.join(','),
      })
      .promise();

    return result.Item;
  }
}
