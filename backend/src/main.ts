import { readFileSync } from 'node:fs';
import * as serverlessExpress from '@vendia/serverless-express';
import express from 'express';
import cors from 'cors';
import { createYoga, createSchema } from 'graphql-yoga';
import resolvers from './resolvers/resolvers.js';
import dotenv from 'dotenv';
import { GraphQLContext, createContext } from './context.js';
import { YogaSchemaDefinition } from 'graphql-yoga/typings/plugins/useSchema';
import logger from './lib/logger.js';
import morgan from './config/morgan.js';
import bodyParser from 'body-parser';

dotenv.config(); // Load environment variables from .env file

const app = express();

if (process.env.AWS_EXECUTION_ENV) {
  app.use((req, res, next) => {
    const { context } = serverlessExpress.getCurrentInvoke();
    logger.addContext(context);
    next();
  });
}

app.use(bodyParser.json());
app.use(morgan);

const port = process.env.PORT || 4000; // Use the specified port from environment variable or default to 4000

const typeDefs = readFileSync('src/schema/schema.graphql', 'utf8');
const schema: YogaSchemaDefinition<GraphQLContext> = createSchema({
  typeDefs,
  resolvers,
}) as YogaSchemaDefinition<GraphQLContext>;
const yoga = createYoga({ schema, context: createContext });

// Enable all CORS requests
app.use(cors());
app.options('*', cors());

// Bind GraphQL Yoga to the graphql endpoint to avoid rendering the playground on any path
app.use(yoga.graphqlEndpoint, yoga);

// Check if running locally or in Lambda environment
if (process.env.AWS_EXECUTION_ENV) {
  // Running in AWS Lambda
  module.exports.handler = serverlessExpress.configure({ app });
} else {
  // Running locally
  app.listen(port, () => {
    console.log(`Running a GraphQL API server at http://localhost:${port}/graphql`);
  });
}
