import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export class CognitoAuth extends Construct {
  userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, sesFromEmail: string) {
    super(scope, id);

    const appName = this.node.tryGetContext('app_name');
    if (!appName) {
      throw new Error('The "app_name" context variable is not defined.');
    }
    const mailDomain = sesFromEmail.slice(sesFromEmail.lastIndexOf('@') + 1);
    if (!mailDomain || mailDomain === sesFromEmail) {
      throw new Error(`ses_from_email '${sesFromEmail}' is not an email address`);
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
      // Confirmation and password-reset mails go through SES from the app's own
      // verified address, not from no-reply@verificationemail.com: the domain's
      // DKIM applies, replies reach the operator, and the pool limit is the SES
      // quota instead of 50 per day.
      email: cognito.UserPoolEmail.withSES({
        // The identity this stack creates and verifies for the configured sender.
        fromEmail: sesFromEmail,
        fromName: appName,
        // Same region as the identity Backend creates, whatever the stack region is.
        sesRegion: cdk.Stack.of(this).region,
        sesVerifiedDomain: mailDomain,
      }),
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
        emailSubject: `${appName}: E-Mail-Adresse bestätigen / Confirm your email address`,
        emailBody:
          'Guten Tag,<br><br>' +
          `bitte bestätigen Sie Ihre E-Mail-Adresse für ${appName}:<br>{##Verify Email##}<br><br>` +
          'Wenn Sie kein Konto angelegt haben, ignorieren Sie diese E-Mail.<br><br>' +
          'Hello,<br><br>' +
          `please confirm your email address for ${appName}:<br>{##Verify Email##}<br><br>` +
          'If you did not create an account, ignore this email.',
        emailStyle: cognito.VerificationEmailStyle.LINK,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The password-reset wording cannot be set through user pool properties, so a
    // CustomMessage trigger rewrites it. It needs EmailSendingAccount DEVELOPER,
    // which the pool gets above; every other trigger source passes through.
    const customMessageLogGroup = new logs.LogGroup(this, 'CustomMessageLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const customMessage = new lambda.Function(this, 'CustomMessage', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/custom-message')),
      description: 'Own wording for the Cognito password-reset mail',
      environment: { APP_NAME: appName },
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      logGroup: customMessageLogGroup,
    });
    this.userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_MESSAGE, customMessage);

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
