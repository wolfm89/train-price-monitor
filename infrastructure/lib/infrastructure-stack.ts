import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CognitoAuth } from './cognito-auth';


export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new CognitoAuth(this, 'CognitoAuth')
  }
}
