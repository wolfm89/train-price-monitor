import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class CognitoAuth extends Construct {
  userPool: cognito.UserPool;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const appName = this.node.tryGetContext('app_name');
    if (!appName) {
      throw new Error('The "app_name" context variable is not defined.');
    }

    // Create a user pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      customAttributes: {
        id: new cognito.StringAttribute({ minLen: 36, maxLen: 36, mutable: false }),
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
        emailBody: 'Hello,<br><br>Please verify your email address by clicking the following link: {##Verify Email##}',
        emailStyle: cognito.VerificationEmailStyle.LINK,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a Cognito domain
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: appName.toLowerCase().replace(/ /g, '-'),
      },
    });

    // Create a user pool app client
    const userPoolClient = this.userPool.addClient('UserPoolClient', {
      generateSecret: false,
    });

    // Create an identity pool
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // Output the identity pool ID
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
    });

    // Output the user pool ID
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
    });
  }
}
