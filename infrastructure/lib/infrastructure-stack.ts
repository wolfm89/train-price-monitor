import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { ToolkitCleaner } from 'cloudstructs/lib/toolkit-cleaner';
import { CognitoAuth } from './cognito-auth';
import { Backend } from './backend';
import { Frontend, FrontendProps } from './frontend';

interface InfrastructureStackProps extends cdk.StackProps {
  /** ARN of the alert topic (owned by AlertingStack). */
  alertTopicArn?: string;
  /** ARNs of the DB proxy Lambdas, one per region (owned by DbProxyStack). */
  dbProxyFunctionArns?: string[];
}

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, frontendProps: FrontendProps, props?: InfrastructureStackProps) {
    super(scope, id, props);

    const sesFromEmail = this.node.tryGetContext('ses_from_email');
    if (!sesFromEmail) {
      throw new Error(
        "CDK context variable 'ses_from_email' is required. Set it in cdk.json or via -c ses_from_email=..."
      );
    }

    const alertTopic = props?.alertTopicArn
      ? cdk.aws_sns.Topic.fromTopicArn(this, 'AlertTopic', props.alertTopicArn)
      : undefined;

    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth', sesFromEmail);
    new Backend(
      this,
      'Backend',
      cognitoAuth.userPool,
      frontendProps.domainName,
      sesFromEmail,
      alertTopic,
      props?.dbProxyFunctionArns
    );
    new Frontend(this, 'Frontend', frontendProps);
    // Runs daily: every deploy adds a new asset image to the CDK bootstrap ECR
    // repository. ToolkitCleaner only removes assets no deployed stack still references;
    // keep unused assets for 10 days so a deploy/rollback race cannot delete them.
    new ToolkitCleaner(this, 'ToolkitCleaner', {
      scheduleExpression: ScheduleExpression.rate(cdk.Duration.days(1)),
      retainAssetsNewerThan: cdk.Duration.days(10),
    });
  }
}
