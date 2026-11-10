import { createServer } from 'http';
import { execute, parse, GraphQLSchema, ExecutionResult } from 'graphql';
import type { Context, APIGatewayProxyEventV2, SQSEvent } from 'aws-lambda';
import { createYoga, createSchema, YogaSchemaDefinition, useErrorHandler } from 'graphql-yoga';
import { createInMemoryCache, useResponseCache } from '@graphql-yoga/plugin-response-cache';
import resolvers from './resolvers/resolvers';
import dotenv from 'dotenv';
import { GraphQLContext, createContext } from './context';
import logger from './lib/logger';
import { authClaimsFromRequest } from './lib/auth';
import { takeDbTransportStats } from '../../shared/db-fetch';
import typeDefs from './schema/schema.generated.json';

dotenv.config();

const cache = createInMemoryCache();

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
    // 30 s in-memory cache, scoped to this container and to the token's `sub`.
    // Mutation invalidation is local too: the refresher and other API containers
    // keep their own cache, so a background write can take up to 30 s to appear.
    // Accepted for this app; documented in AGENTS.md.
    useResponseCache({ session: (request) => authClaimsFromRequest(request)?.sub ?? null, cache, ttl: 30_000 }),
    useErrorHandler(({ errors, phase }) => {
      for (const error of errors) {
        if (error instanceof Error) {
          // Expected authorization outcomes are not operational errors: logging
          // them at ERROR would feed the SearchErrors alarm on every cross-user
          // probe or stale token.
          const code = (error as { extensions?: { code?: unknown } }).extensions?.code;
          if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') {
            logger.warn(error.message, { phase, code });
          } else {
            logger.error(error.message, { phase });
          }
        } else {
          logger.error(error);
        }
      }
    }),
  ],
});

function isSQSEvent(event: unknown): event is SQSEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'Records' in event &&
    (event as SQSEvent).Records?.[0]?.eventSource === 'aws:sqs'
  );
}

function isAPIGatewayEvent(event: unknown): event is APIGatewayProxyEventV2 {
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
  event: APIGatewayProxyEventV2
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

  try {
    // REST API v1 carries the method and path on the event itself; only HTTP API
    // v2 nests them under `requestContext.http`. `extractHttpContext` handles
    // both, so the invocation log is no longer blank on the deployed API.
    const httpContext = isAPIGatewayEvent(event) ? extractHttpContext(event) : null;

    logger.info('Lambda invoked', {
      eventSource: isSQSEvent(event) ? event.Records?.[0]?.eventSource : undefined,
      httpMethod: httpContext?.method,
      path: httpContext?.path,
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

      let result: ExecutionResult | undefined;
      let executeError: unknown;
      let transport: ReturnType<typeof takeDbTransportStats> | undefined;
      try {
        // No request means no auth claims: the SQS path may run the internal
        // mutations (updateJourneyMonitors, sendEmailNotification) that the
        // public API rejects.
        const graphqlContext = await createContext(cache, { isInternal: true });
        result = await execute({
          schema: schema as unknown as GraphQLSchema,
          document: parse(query),
          variableValues: variables,
          contextValue: graphqlContext,
        });
      } catch (error) {
        executeError = error;
      } finally {
        // Drain exactly once: a failed run must not leak its counters into the
        // next warm invocation and misattribute Decodo usage.
        transport = takeDbTransportStats();
      }

      if (executeError) {
        logger.error('SQS message processing failed', {
          error: executeError instanceof Error ? executeError.message : String(executeError),
          transport,
        });
        throw executeError;
      }

      if (result?.errors && result.errors.length > 0) {
        const messages = result.errors.map((e) => e.message).join('; ');
        logger.error('SQS message processing failed', {
          errorCount: result.errors.length,
          errors: result.errors.map((error) => ({ message: error.message, path: error.path })),
          transport,
        });
        // Throw so SQS retries the message (up to maxReceiveCount) before routing to the DLQ.
        // Expected outcomes like stale journeys are handled inside the resolver without errors,
        // so anything reaching here is a genuine transient failure worth retrying.
        throw new Error(`GraphQL execution error(s): ${messages}`);
      }

      logger.info('SQS message processed', { hasErrors: false, transport });
      return { statusCode: 200, body: '' };
    }

    if (!isAPIGatewayEvent(event)) {
      logger.error('Unknown event type', { event: JSON.stringify(event) });
      return { statusCode: 400, headers: CORS_HEADERS, body: 'Unknown event type' };
    }

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

    let response: Response | undefined;
    let responseBody = '';
    let requestError: unknown;
    let transport: ReturnType<typeof takeDbTransportStats> | undefined;
    try {
      response = await yoga.fetch(url, {
        method: httpContext.method,
        headers,
        body,
      });
      responseBody = await response.text();
    } catch (error) {
      requestError = error;
    } finally {
      // Drain exactly once, including when Yoga or the response stream threw.
      transport = takeDbTransportStats();
    }

    if (requestError || !response) {
      logger.error('GraphQL request failed', {
        error: requestError instanceof Error ? requestError.message : String(requestError),
        transport,
      });
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ errors: [{ message: 'Internal server error' }] }),
      };
    }

    logger.info('GraphQL response', {
      status: response.status,
      bodyLength: responseBody.length,
      transport,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } finally {
    // Safety net for warm containers: request-scoped keys must never reach the
    // next invocation, and the deprecated persistent store must stay empty.
    logger.resetKeys();
    logger.removePersistentKeys(['userId', 'journeyId', 'notificationId']);
  }
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
