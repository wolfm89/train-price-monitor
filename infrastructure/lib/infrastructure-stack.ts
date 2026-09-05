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
    // Runs daily rather than weekly: the backend and scraper images are ~1.2 GB
    // each (they bundle a Chromium headless shell), so every deploy adds a new
    // asset image to the CDK bootstrap ECR repository. ToolkitCleaner only
    // removes images no deployed stack still references, so it is safe to run
    // often, and doing so keeps ECR storage from accumulating gigabytes between
    // runs. Orphaned untagged layers are handled by a lifecycle policy on the
    // bootstrap repository (see infrastructure/README.md).
    new ToolkitCleaner(this, 'ToolkitCleaner', {
      scheduleExpression: ScheduleExpression.rate(cdk.Duration.days(1)),
    });
  }
}
