import morgan, { StreamOptions } from 'morgan';

import { IncomingMessage } from 'http';

import logger from '../lib/logger';

interface Request extends IncomingMessage {
  body: {
    query: string;
    variables: any;
  };
}

const stream: StreamOptions = {
  write: (message) => {
    const msg = message.substring(0, message.lastIndexOf('\n'));
    const msgParts = msg.split('|');
    const [logMessage, rawQuery, variables] = msgParts;
    if (rawQuery != 'undefined') {
      const query = rawQuery.replace(/\n/g, '').replace(/\s+/g, ' ');
      try {
        logger.info(logMessage, { cleanedQuery: query }, { variables: JSON.parse(variables) });
      } catch (e) {
        logger.info(logMessage, { cleanedQuery: query });
      }
    } else {
      logger.info(logMessage);
    }
  },
};

const skip = () => {
  const env = process.env.NODE_ENV || 'development';
  return env !== 'development';
};

const registerTokens = () => {
  morgan.token('graphql-query', (req: Request) => `${req.body.query}`);
  morgan.token('graphql-vars', (req: Request) => JSON.stringify(req.body.variables));
};

registerTokens();

const morganMiddleware = morgan(
  ':method :url :status :res[content-length] - :response-time ms|:graphql-query|:graphql-vars',
  {
    stream,
    skip,
  }
);

export default morganMiddleware;
