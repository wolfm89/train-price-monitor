import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, TableProps } from 'aws-cdk-lib/aws-dynamodb';

export const tableDefinitions: TableProps[] = [
  {
    tableName: 'users',
    partitionKey: { name: 'id', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  },
];
