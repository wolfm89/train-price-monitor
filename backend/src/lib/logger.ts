import { Logger } from '@aws-lambda-powertools/logger';

const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';

// This method set the current severity based on
// the current NODE_ENV: show all the log levels
// if the server was run in development mode; otherwise,
// if it was run in production, show only warn and error messages.
const level = () => {
  return isDevelopment ? 'DEBUG' : 'WARN';
};

const logger = new Logger({ serviceName: 'tpm-backend', logLevel: level() });

export default logger;
