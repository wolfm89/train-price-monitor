import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_lambda as lambda, aws_logs as logs } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { resolve } from 'node:path';
import { DB_PROXY_FUNCTION_NAME, DB_TLS_PROFILES } from './config';

/**
 * DB egress proxy.
 *
 * DB's Akamai edge refuses some Lambda regions and rate-limits others, and the
 * accepted TLS fingerprint changes without notice. The stack is deployed once
 * per region in `DB_PROXY_REGIONS`; each Lambda performs the HTTPS call and
 * reports which fingerprint served it. The transport in `shared/db-fetch.ts`
 * tries the proxies in order and fails over on a refusal or a 429.
 *
 * No VPC, no NAT, no fixed cost: one small Lambda per region whose invocations
 * stay inside the free tier.
 */
export class DbProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'DbProxyLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    new NodejsFunction(this, 'DbProxy', {
      functionName: DB_PROXY_FUNCTION_NAME,
      entry: resolve(__dirname, '../lambda/db-proxy/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 128,
      // Keep the proxy shorter than the API's 29 s cap. The caller aborts the
      // invoke at DB_REQUEST_TIMEOUT_MS; the handler caps the inner request at 15 s.
      timeout: cdk.Duration.seconds(20),
      // One shared egress for the poller and the API. The transport measured six
      // parallel calls as the safe ceiling, so five leaves margin. Overflow
      // invokes are classified as proxy-busy, not DB failures.
      reservedConcurrentExecutions: 5,
      logGroup,
      environment: {
        // The caller sends the fingerprint that worked last time; this list is
        // the fallback order when there is no hint or the hint is refused.
        DB_TLS_PROFILES,
        DB_MAX_ATTEMPTS: '1',
        DB_TOTAL_BUDGET_MS: '18000',
        DB_REQUEST_TIMEOUT_MS: '15000',
        DB_MIN_GAP_MS: '0',
        DB_MAX_IN_FLIGHT: '1',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
  }
}
