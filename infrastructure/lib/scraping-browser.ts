import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Name of the SSM SecureString holding the managed unblocking-browser CDP
 * endpoint (which embeds the vendor zone password).
 *
 * The value is deliberately never part of a CDK template. CI writes it from a
 * repository secret before deploying, and the functions read it at runtime via
 * the name in `BROWSER_WS_ENDPOINT_PARAM` (see shared/browser-fetch.ts and the
 * "Browser-backed transport" section of AGENTS.md). Override the name with the
 * `scraping_browser_param` context key or `CDK_SCRAPING_BROWSER_PARAM`.
 */
export const DEFAULT_SCRAPING_BROWSER_PARAM = '/train-price-monitor/scraping-browser-url';

export function scrapingBrowserParamName(scope: Construct): string {
  return (scope.node.tryGetContext('scraping_browser_param') as string | undefined) || DEFAULT_SCRAPING_BROWSER_PARAM;
}

/**
 * Grants the given functions read access to the endpoint parameter and returns
 * its name, so callers can pass it as `BROWSER_WS_ENDPOINT_PARAM`.
 *
 * Least privilege: exactly the one API the shim calls, on exactly this parameter.
 * CDK's `grantRead` would also add `ssm:DescribeParameters`, `GetParameters` and
 * `GetParameterHistory`, none of which the runtime uses.
 *
 * No `kms:Decrypt` is required: the parameter is encrypted with the AWS-managed
 * `aws/ssm` key, whose policy already allows decryption for every principal in
 * the account (see "Setting up Parameter Store" in the Systems Manager docs). If
 * it is ever moved to a customer-managed key, add `kms:Decrypt` on that key's
 * ARN — a key alias ARN is not a valid KMS resource.
 */
export function grantScrapingBrowserEndpointRead(
  scope: Construct,
  id: string,
  functions: cdk.aws_lambda.IFunction[]
): string {
  const parameterName = scrapingBrowserParamName(scope);

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
