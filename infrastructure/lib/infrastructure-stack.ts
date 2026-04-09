import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { ToolkitCleaner } from 'cloudstructs/lib/toolkit-cleaner';
import { CognitoAuth } from './cognito-auth';
import { Backend } from './backend';
import { Frontend, FrontendProps } from './frontend';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, frontendProps: FrontendProps, props?: cdk.StackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth');
    new Backend(this, 'Backend', cognitoAuth.userPool);
    new Frontend(this, 'Frontend', frontendProps);
    new ToolkitCleaner(this, 'ToolkitCleaner', {
      scheduleExpression: ScheduleExpression.rate(cdk.Duration.days(7)),
    });
  }
}
