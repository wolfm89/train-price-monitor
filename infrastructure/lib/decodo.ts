import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Name of the SSM SecureString holding the Decodo Web Data API key.
 *
 * The value is never part of a CDK template: CI writes it from the repository
 * secret `DECODO_API_KEY` before deploying, and the function reads it at runtime
 * via the name in `DECODO_API_KEY_PARAM` (see shared/db-fetch.ts). Override
 * the name with the `decodo_api_key_param` context key.
 */
export const DEFAULT_DECODO_API_KEY_PARAM = '/train-price-monitor/decodo-api-key';

export function decodoApiKeyParamName(scope: Construct): string {
  return (scope.node.tryGetContext('decodo_api_key_param') as string | undefined) || DEFAULT_DECODO_API_KEY_PARAM;
}

/**
 * Grants the given functions read access to the API-key parameter.
 *
 * Same least privilege as the CDP endpoint grant: exactly `ssm:GetParameter` on
 * this one parameter, and no `kms:Decrypt` (the AWS-managed `aws/ssm` key already
 * permits decryption account-wide).
 */
export function grantDecodoApiKeyRead(scope: Construct, id: string, functions: cdk.aws_lambda.IFunction[]): string {
  const parameterName = decodoApiKeyParamName(scope);

  const statement = new iam.PolicyStatement({
    sid: `${id}Read`,
    actions: ['ssm:GetParameter'],
    resources: [
      cdk.Stack.of(scope).formatArn({
        service: 'ssm',
        resource: 'parameter',
        // Parameter ARNs carry the name without its leading slash.
        resourceName: parameterName.replace(/^\//, ''),
      }),
    ],
  });

  for (const fn of functions) fn.addToRolePolicy(statement);

  return parameterName;
}
