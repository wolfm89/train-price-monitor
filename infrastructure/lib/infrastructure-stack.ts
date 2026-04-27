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

    const sesFromEmail = this.node.tryGetContext('ses_from_email');
    if (!sesFromEmail) {
      throw new Error(
        "CDK context variable 'ses_from_email' is required. Set it in cdk.json or via -c ses_from_email=..."
      );
    }

    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth');
    new Backend(this, 'Backend', cognitoAuth.userPool, frontendProps.domainName, sesFromEmail);
    new Frontend(this, 'Frontend', frontendProps);
    new ToolkitCleaner(this, 'ToolkitCleaner', {
      scheduleExpression: ScheduleExpression.rate(cdk.Duration.days(7)),
    });
  }
}
