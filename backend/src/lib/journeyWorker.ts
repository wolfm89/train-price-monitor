import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Journey, Journeys } from 'hafas-client';
import type { GraphQLContext } from '../context';
import type { PricingOptions, QueryJourneysOptions } from '../managers/DbHafasManager';
import Logger from './logger';
import type { JourneyWorkerJob } from './journeyWorkerProtocol';

/**
 * How long the API waits for the worker. API Gateway cuts the user off at 29 s,
 * so this leaves headroom for the response to travel back.
 */
const INVOKE_TIMEOUT_MS = 24_000;

/**
 * Retry delays for a throttled invoke. The worker runs one invocation at a time
 * (reserved concurrency 1), so overlapping the three-minute keep-alive ping comes
 * back as a throttle; the ping itself is short, so a brief wait is enough.
 */
const THROTTLE_RETRY_DELAYS_MS = [300, 700, 1500, 3000];

const client = new LambdaClient({});

/**
 * Present only on the API function. The refresher runs the same resolver code
 * (via SQS) without it and keeps calling DB directly, which is correct: its runs
 * are long, nobody waits on them, and routing them through the single-slot
 * worker would block user searches.
 */
function workerFunctionName(): string | undefined {
  return process.env.JOURNEY_WORKER_FUNCTION;
}

/**
 * Runs a journey search in the worker, or inline when no worker is configured
 * (local development and the refresher).
 */
export async function queryJourneys(
  context: GraphQLContext,
  from: string,
  to: string,
  departure: Date,
  options?: QueryJourneysOptions
): Promise<Journeys> {
  if (!workerFunctionName()) {
    return context.dbHafas.queryJourneys(from, to, departure, options);
  }

  return invokeWorker<Journeys>({
    job: 'journeys',
    from,
    to,
    departure: departure.toISOString(),
    options,
  });
}

/**
 * Refreshes one journey via its refresh token in the worker, or inline when no
 * worker is configured.
 */
export async function refreshJourney(
  context: GraphQLContext,
  refreshToken: string,
  pricingOptions?: PricingOptions
): Promise<Journey | undefined> {
  if (!workerFunctionName()) {
    return context.dbHafas.requeryJourney(refreshToken, pricingOptions);
  }

  const journey = await invokeWorker<Journey | null>({ job: 'journey', refreshToken, pricingOptions });
  return journey ?? undefined;
}

/**
 * Asks the worker to establish and validate the session. Queued rather than
 * awaited: the worker is single-slot, and the caller (the search page) only needs
 * the session to be ready by the time the user presses Search.
 */
export async function warmUp(context: GraphQLContext): Promise<void> {
  if (!workerFunctionName()) {
    await context.dbHafas.warmUp();
    return;
  }

  await client.send(
    new InvokeCommand({
      FunctionName: workerFunctionName(),
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ job: 'keepAlive' })),
    })
  );
}

async function invokeWorker<T>(job: JourneyWorkerJob): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= THROTTLE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await invokeOnce<T>(job);
    } catch (error) {
      lastError = error;

      const throttled = error instanceof Error && error.name === 'TooManyRequestsException';
      const delay = THROTTLE_RETRY_DELAYS_MS[attempt];
      if (!throttled || delay === undefined || Date.now() - startedAt + delay > INVOKE_TIMEOUT_MS) {
        break;
      }

      Logger.warn('Journey worker throttled, retrying', { attempt: attempt + 1, delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function invokeOnce<T>(job: JourneyWorkerJob): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);

  try {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: workerFunctionName(),
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(job)),
      }),
      { abortSignal: controller.signal }
    );

    if (response.FunctionError) {
      throw new Error(workerErrorMessage(response.Payload));
    }

    return JSON.parse(Buffer.from(response.Payload ?? new Uint8Array()).toString()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function workerErrorMessage(payload?: Uint8Array): string {
  if (!payload) return 'Journey worker failed';

  try {
    const parsed = JSON.parse(Buffer.from(payload).toString()) as { errorMessage?: string };
    return parsed.errorMessage ?? 'Journey worker failed';
  } catch {
    return 'Journey worker failed';
  }
}
