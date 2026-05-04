import { readFileSync } from 'node:fs';
import { createServer } from 'http';
import { execute, parse, GraphQLSchema } from 'graphql';
import type { Context, APIGatewayProxyEventV2, SQSEvent } from 'aws-lambda';
import { createYoga, createSchema, YogaSchemaDefinition, useErrorHandler } from 'graphql-yoga';
import { createInMemoryCache, useResponseCache } from '@graphql-yoga/plugin-response-cache';
import resolvers from './resolvers/resolvers';
import dotenv from 'dotenv';
import { GraphQLContext, createContext } from './context';
import logger from './lib/logger';

dotenv.config();

const cache = createInMemoryCache();

const typeDefs = readFileSync('src/schema/schema.graphql', 'utf8');
const schema: YogaSchemaDefinition<unknown, GraphQLContext> = createSchema({
  typeDefs,
  resolvers,
}) as YogaSchemaDefinition<unknown, GraphQLContext>;

const YOGA_CORS_CONFIG = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
};

const yoga = createYoga({
  schema,
  context: ({ request }) => createContext(cache, { request }),
  fetchAPI: { fetch: globalThis.fetch },
  cors: YOGA_CORS_CONFIG,
  plugins: [
    useResponseCache({ session: () => null, cache }),
    useErrorHandler(({ errors, phase }) => {
      for (const error of errors) {
        if (error instanceof Error) {
          logger.error(error.message, { phase });
        } else {
          logger.error(error);
        }
      }
    }),
  ],
});

function isSQSEvent(event: APIGatewayProxyEventV2 | SQSEvent): event is SQSEvent {
  return 'Records' in event && (event as SQSEvent).Records?.[0]?.eventSource === 'aws:sqs';
}

function isAPIGatewayEvent(event: APIGatewayProxyEventV2 | SQSEvent): boolean {
  const e = event as APIGatewayProxyEventV2;
  // Check for v2 format (requestContext.http)
  if (e.requestContext?.http) return true;
  // Check for v1 format (pathParameters.proxy)
  if (e.pathParameters?.proxy) return true;
  // Check for API Gateway with requestContext
  if ((e.requestContext as unknown as Record<string, unknown>)?.resourceId) return true;
  return false;
}

function extractHttpContext(
  event: APIGatewayProxyEventV2 | SQSEvent
): { method: string; path: string; queryString: string } | null {
  const e = event as APIGatewayProxyEventV2;
  // Try v2 format first
  if (e.requestContext?.http) {
    return {
      method: e.requestContext.http.method,
      path: e.requestContext.http.path,
      queryString: e.rawQueryString || '',
    };
  }

  // Try v1 format (Lambda proxy integration)
  if (e.pathParameters?.proxy) {
    const path = '/' + e.pathParameters.proxy;
    const queryString = e.queryStringParameters
      ? new URLSearchParams(e.queryStringParameters as Record<string, string>).toString()
      : '';
    return {
      method: (e as unknown as Record<string, string>).httpMethod || 'GET',
      path,
      queryString,
    };
  }

  return null;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': YOGA_CORS_CONFIG.origin,
  'Access-Control-Allow-Methods': YOGA_CORS_CONFIG.methods.join(', '),
  'Access-Control-Allow-Headers': YOGA_CORS_CONFIG.allowedHeaders.join(', '),
};

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export const handler = async (event: APIGatewayProxyEventV2 | SQSEvent, context: Context): Promise<LambdaResponse> => {
  if (process.env.AWS_EXECUTION_ENV) {
    logger.addContext(context);
  }

  logger.info('Lambda invoked', {
    eventSource: isSQSEvent(event) ? event.Records?.[0]?.eventSource : undefined,
    httpMethod: !isSQSEvent(event) ? (event as APIGatewayProxyEventV2).requestContext?.http?.method : undefined,
    path: !isSQSEvent(event) ? (event as APIGatewayProxyEventV2).requestContext?.http?.path : undefined,
  });

  if (isSQSEvent(event)) {
    const body = event.Records[0]?.body || '{}';
    let query = 'mutation { updateJourneyMonitors }';
    let variables: Record<string, unknown> = {};

    try {
      const parsed = JSON.parse(body);
      if (parsed.query) {
        query = parsed.query;
        variables = parsed.variables || {};
      }
    } catch {
      logger.warn('Failed to parse SQS message body', { body });
    }

    logger.info('Processing SQS message', { query, hasVariables: Object.keys(variables).length > 0 });

    const graphqlContext = (await createContext(cache, {})) as GraphQLContext;
    const result = await execute({
      schema: schema as unknown as GraphQLSchema,
      document: parse(query),
      variableValues: variables,
      contextValue: graphqlContext,
    });
    if (result.errors && result.errors.length > 0) {
      logger.error('SQS message processing failed, dropping message', {
        errorCount: result.errors.length,
        errors: result.errors.map((error) => ({ message: error.message, path: error.path })),
      });
      return { statusCode: 200, body: '' }; // Don't throw - message will be removed from queue
    }
    logger.info('SQS message processed', { hasErrors: false });
    return { statusCode: 200, body: '' };
  }

  if (!isAPIGatewayEvent(event)) {
    logger.error('Unknown event type', { event: JSON.stringify(event) });
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Unknown event type' };
  }

  const httpContext = extractHttpContext(event);

  if (!httpContext) {
    logger.error('Failed to extract HTTP context', { event: JSON.stringify(event) });
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Invalid request' };
  }

  if (httpContext.method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const queryString = httpContext.queryString;
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const headers = event.headers as Record<string, string>;

  logger.info('Processing GraphQL request', {
    method: httpContext.method,
    path: httpContext.path,
    queryStringLength: queryString.length,
  });

  // Create a mock Request object for yoga
  const url = `https://example.com${httpContext.path}${queryString ? '?' + queryString : ''}`;

  const response = await yoga.fetch(url, {
    method: httpContext.method,
    headers,
    body,
  });

  const responseBody = await response.text();
  logger.info('GraphQL response', { status: response.status, bodyLength: responseBody.length });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
};

if (process.env.LOCAL_DEV) {
  const port = parseInt(process.env.PORT || '4000', 10);

  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    const url = `http://localhost:${port}${req.url}`;
    const response = await yoga.fetch(url, {
      method: req.method || 'GET',
      headers: req.headers as Record<string, string>,
      body: body || undefined,
    });

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(await response.text());
  });

  server.listen(port, () => {
    logger.info(`Running a GraphQL API server at http://localhost:${port}/graphql`);
  });
}
