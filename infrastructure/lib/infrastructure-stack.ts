import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CognitoAuth } from './cognito-auth';
import { Backend } from './backend';
import { Frontend } from './frontend';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth');
    new Backend(this, 'Backend', cognitoAuth.userPool);
    new Frontend(this, 'Frontend');
  }
}
