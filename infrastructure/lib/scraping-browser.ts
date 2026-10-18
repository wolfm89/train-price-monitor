import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam, aws_ssm as ssm } from 'aws-cdk-lib';
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
 * Two permissions are needed: `ssm:GetParameter` for the parameter itself, and
 * `kms:Decrypt` for the key the SecureString was encrypted with. With no explicit
 * key that is the AWS-managed `alias/aws/ssm`, whose policy allows use but still
 * requires the caller's IAM policy to permit decryption.
 */
export function grantScrapingBrowserEndpointRead(
  scope: Construct,
  id: string,
  functions: cdk.aws_lambda.IFunction[]
): string {
  const parameterName = scrapingBrowserParamName(scope);
  const stack = cdk.Stack.of(scope);

  // fromSecureStringParameterAttributes records a reference only: there is no
  // synth-time lookup, so the secret never has to be readable by whoever runs
  // `cdk synth` (and nothing about the value reaches the template).
  const parameter = ssm.StringParameter.fromSecureStringParameterAttributes(scope, id, { parameterName });

  // Reading a SecureString needs `ssm:GetParameter` *and* `kms:Decrypt` on the key
  // it was encrypted with. With no explicit key that is the AWS-managed
  // `alias/aws/ssm`. The grant is written straight onto the function roles (an
  // imported alias cannot contribute a key policy) and scoped to that alias, so
  // moving the parameter to a customer-managed key fails loudly with AccessDenied
  // rather than silently needing a wider policy.
  const decryptStatement = new iam.PolicyStatement({
    sid: 'DecryptScrapingBrowserEndpoint',
    actions: ['kms:Decrypt'],
    resources: [stack.formatArn({ service: 'kms', resource: 'alias', resourceName: 'aws/ssm' })],
  });

  for (const fn of functions) {
    parameter.grantRead(fn);
    fn.addToRolePolicy(decryptStatement);
  }

  return parameterName;
}
