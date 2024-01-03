import { readFileSync } from 'node:fs';
import { ServerlessAdapter, getCurrentInvoke } from '@h4ad/serverless-adapter';
import { ExpressFramework } from '@h4ad/serverless-adapter/lib/frameworks/express';
import { DefaultHandler } from '@h4ad/serverless-adapter/lib/handlers/default';
import { PromiseResolver } from '@h4ad/serverless-adapter/lib/resolvers/promise';
import { ApiGatewayV1Adapter } from '@h4ad/serverless-adapter/lib/adapters/aws';
import express from 'express';
import cors from 'cors';
import { createYoga, createSchema, YogaSchemaDefinition } from 'graphql-yoga';
import { useResponseCache } from '@graphql-yoga/plugin-response-cache';
import resolvers from './resolvers/resolvers';
import dotenv from 'dotenv';
import { GraphQLContext, createContext } from './context';
import logger from './lib/logger';
import morgan from './config/morgan';
import bodyParser from 'body-parser';
import { Logger } from '@aws-lambda-powertools/logger';
import { SQSAdapter } from './adapters/SQSAdapter';

dotenv.config(); // Load environment variables from .env file

const app = express();

if (process.env.AWS_EXECUTION_ENV) {
  app.use((_req, _res, next) => {
    const { context } = getCurrentInvoke();
    logger.addContext(context);
    next();
  });
}

app.use(bodyParser.json());
app.use(morgan);

const port = process.env.PORT || 4000; // Use the specified port from environment variable or default to 4000

const typeDefs = readFileSync('src/schema/schema.graphql', 'utf8');
const schema: YogaSchemaDefinition<unknown, GraphQLContext> = createSchema({
  typeDefs,
  resolvers,
}) as YogaSchemaDefinition<unknown, GraphQLContext>;
const yoga = createYoga({ schema, context: createContext, plugins: [useResponseCache({ session: () => null })] });

// Enable all CORS requests
app.use(cors());
app.options('*', cors());

// Bind GraphQL Yoga to the graphql endpoint to avoid rendering the playground on any path
app.use(yoga.graphqlEndpoint, yoga);

class ServerlessExpressLogger {
  constructor(private logger: Logger) {}

  info = (message: string) => this.logger.info(message);
  debug = (message: string) => this.logger.debug(message);
  warn = (message: string) => this.logger.warn(message);
  error = (message: string) => this.logger.error(message);
  verbose = (message: string) => this.debug(message);
}

// Check if running locally or in Lambda environment
if (process.env.AWS_EXECUTION_ENV) {
  // Running in AWS Lambda
  module.exports.handler = ServerlessAdapter.new(app)
    .setLogger(new ServerlessExpressLogger(logger))
    .setFramework(new ExpressFramework())
    .setHandler(new DefaultHandler())
    .setResolver(new PromiseResolver())
    .addAdapter(new ApiGatewayV1Adapter())
    .addAdapter(new SQSAdapter({ sqsForwardPath: '/graphql', sqsForwardMethod: 'POST' }))
    .build();
} else {
  // Running locally
  app.listen(port, () => {
    console.log(`Running a GraphQL API server at http://localhost:${port}/graphql`);
  });
}
