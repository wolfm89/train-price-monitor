import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class CognitoAuth extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const appName = this.node.tryGetContext('app_name');
    if (!appName) {
      throw new Error('The "app_name" context variable is not defined.');
    }

    // Create a user pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          mutable: true,
          required: true,
        },
        givenName: {
          required: true,
          mutable: false,
        },
        familyName: {
          required: true,
          mutable: false,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      userVerification: {
        emailSubject: `Verify your email for ${appName}`,
        emailBody:
          'Hello {username},\n\nPlease verify your email address by clicking the following link: {##Verify Email##}',
        emailStyle: cognito.VerificationEmailStyle.LINK,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a user pool app client
    userPool.addClient('UserPoolClient', {
      generateSecret: false,
    });

    // Create a Cognito domain
    userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: appName.toLowerCase().replace(/ /g, '-'),
      },
    });
  }
}
