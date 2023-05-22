import serverless from 'serverless-http';
import express from 'express';
import { createYoga } from 'graphql-yoga';
import { schema } from './schema';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 4000; // Use the specified port from environment variable or default to 4000

const yoga = createYoga({ schema });

// Bind GraphQL Yoga to the graphql endpoint to avoid rendering the playground on any path
app.use(yoga.graphqlEndpoint, yoga);

// Check if running locally or in Lambda environment
if (process.env.AWS_EXECUTION_ENV) {
  // Running in AWS Lambda
  module.exports.handler = serverless(app);
} else {
  // Running locally
  app.listen(port, () => {
    console.log(`Running a GraphQL API server at http://localhost:${port}/graphql`);
  });
}
