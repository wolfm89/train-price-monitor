import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, TableProps } from 'aws-cdk-lib/aws-dynamodb';

export const tableDefinitions: TableProps[] = [
  {
    tableName: 'TrainPriceMonitor',
    partitionKey: { name: 'pk', type: AttributeType.STRING },
    sortKey: { name: 'sk', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.DESTROY,
    // Journeys and notifications carry an epoch-seconds `ttl` (backend/src/lib/retention.ts).
    timeToLiveAttribute: 'ttl',
    pointInTimeRecoverySpecification: {
      pointInTimeRecoveryEnabled: true,
    },
  },
];
