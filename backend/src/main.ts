import { readFileSync } from 'node:fs';
import * as serverlessExpress from '@vendia/serverless-express';
import express from 'express';
import { createYoga, createSchema } from 'graphql-yoga';
import resolvers from './resolvers/resolvers';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 4000; // Use the specified port from environment variable or default to 4000

const typeDefs = readFileSync('src/schema/schema.graphql', 'utf8');
const schema = createSchema({ typeDefs, resolvers });
const yoga = createYoga({ schema });

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
