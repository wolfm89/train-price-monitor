import morgan, { StreamOptions } from 'morgan';

import { IncomingMessage } from 'http';

import Logger from '../lib/logger';

interface Request extends IncomingMessage {
  body: {
    query: string;
    variables: any;
  };
}

const stream: StreamOptions = {
  write: (message) => Logger.http(message.substring(0, message.lastIndexOf('\n'))),
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
  ':method :url :status :res[content-length] - :response-time ms\n:graphql-query\n:graphql-vars',
  {
    stream,
    skip,
  }
);

export default morganMiddleware;
