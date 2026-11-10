import { Logger } from '@aws-lambda-powertools/logger';

// NODE_ENV is unset in Lambda, so the old `(NODE_ENV || 'development')` check
// silently made production DEBUG; setting NODE_ENV=production then made it WARN,
// which suppressed the INFO lines the fallback metrics depend on.
const isDevelopment = process.env.NODE_ENV === 'development';

const logLevel = (process.env.POWERTOOLS_LOG_LEVEL ??
  process.env.LOG_LEVEL ??
  (isDevelopment ? 'DEBUG' : 'INFO')) as NonNullable<ConstructorParameters<typeof Logger>[0]>['logLevel'];

const logger = new Logger({ serviceName: 'tpm-backend', logLevel });

export default logger;
