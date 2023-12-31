//#region Imports

import type { Context, SQSEvent } from 'aws-lambda';
import { AWSSimpleAdapterResponseType } from '@h4ad/serverless-adapter/lib/adapters/aws';
import {
  AdapterContract,
  AdapterRequest,
  EmptyResponse,
  GetResponseAdapterProps,
  OnErrorProps,
  getDefaultIfUndefined,
  getEventBodyAsBuffer,
} from '@h4ad/serverless-adapter';

//#endregion

/**
 * The options to customize the {@link SQSAdapter}
 *
 * @breadcrumb Adapters / AWS / SQSAdapter
 * @public
 */
export interface SQSAdapterOptions {
  /**
   * The path that will be used to create a request to be forwarded to the framework.
   *
   * @defaultValue /sqs
   */
  sqsForwardPath?: string;

  /**
   * The http method that will be used to create a request to be forwarded to the framework.
   *
   * @defaultValue POST
   */
  sqsForwardMethod?: string;

  /**
   * Tells if this adapter should support batch item failures.
   */
  batch?: true | false;
}

/**
 * The adapter to handle requests from AWS SQS.
 *
 * The option of `responseWithErrors` is ignored by this adapter and we always call `resolver.fail` with the error.
 *
 * {@link https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html | Event Reference}
 *
 * @example
 * ```typescript
 * const sqsForwardPath = '/your/route/sqs'; // default /sqs
 * const sqsForwardMethod = 'POST'; // default POST
 * const adapter = new SQSAdapter({ sqsForwardPath, sqsForwardMethod });
 * ```
 *
 * @breadcrumb Adapters / AWS / SQSAdapter
 * @public
 */
export class SQSAdapter implements AdapterContract<SQSEvent, Context, AWSSimpleAdapterResponseType> {
  //#region Constructor

  /**
   * Default constructor
   *
   * @param options - The options to customize the {@link SQSAdapter}
   */
  constructor(private readonly options: SQSAdapterOptions = {}) {
    this.options.sqsForwardPath = getDefaultIfUndefined(this.options.sqsForwardPath, '/sqs');
    this.options.sqsForwardMethod = getDefaultIfUndefined(this.options.sqsForwardMethod, 'POST');
  }

  //#endregion

  //#region Public Methods

  /**
   * Get the name of the adapter.
   *
   * @returns The name of the adapter.
   */
  public getAdapterName(): string {
    return SQSAdapter.name;
  }

  /**
   * Check if the adapter can handle the provided event.
   *
   * @param event - The event to check.
   * @returns True if the adapter can handle the event, otherwise false.
   */
  public canHandle(event: unknown): event is SQSEvent {
    const sqsEvent = event as Partial<SQSEvent>;

    if (!Array.isArray(sqsEvent?.Records)) return false;

    const eventSource = sqsEvent.Records[0]?.eventSource;

    return eventSource === 'aws:sqs';
  }

  /**
   * Get the request for the adapter.
   *
   * @param event - The event to create the request from.
   * @returns The adapter request.
   */
  public getRequest(event: SQSEvent): AdapterRequest {
    const path = this.options.sqsForwardPath!;
    const method = this.options.sqsForwardMethod!;

    const body = this.getBodyFromEvent(event);

    const [bufferedBody, contentLength] = getEventBodyAsBuffer(body, false);

    const headers = {
      host: 'sqs.amazonaws.com',
      'content-type': 'application/json',
      'content-length': String(contentLength),
    };

    return {
      method,
      headers,
      body: bufferedBody,
      path,
    };
  }

  /**
   * Get the response for the adapter.
   *
   * @param props - The properties to create the response from.
   * @returns The adapter response.
   */
  public getResponse(props: GetResponseAdapterProps<SQSEvent>): AWSSimpleAdapterResponseType {
    const { body, isBase64Encoded, event, statusCode } = props;

    if (this.hasInvalidStatusCode(statusCode)) {
      throw new Error(JSON.stringify({ body, isBase64Encoded, event, statusCode }));
    }

    if (!this.options.batch) return EmptyResponse;

    if (isBase64Encoded) {
      throw new Error(
        'SERVERLESS_ADAPTER: The response could not be base64 encoded when you set batch: true, the response should be a JSON.'
      );
    }

    if (!body) return EmptyResponse;

    return JSON.parse(body);
  }

  /**
   * Handle an error while forwarding the request.
   *
   * @param props - The properties to handle the error with.
   */
  public onErrorWhileForwarding(props: OnErrorProps<SQSEvent, AWSSimpleAdapterResponseType>): void {
    props.delegatedResolver.fail(props.error);
  }

  //#endregion

  //#region Protected Methods

  /**
   * Check if the status code is invalid.
   *
   * @param statusCode - The status code to check.
   * @returns True if the status code is invalid, otherwise false.
   */
  protected hasInvalidStatusCode(statusCode: number): boolean {
    return statusCode < 200 || statusCode >= 400;
  }

  /**
   * Get the body from the SQS event.
   *
   * @param event - The SQS event to get the body from.
   * @returns The body of the event.
   */
  protected getBodyFromEvent(event: SQSEvent): string {
    return event.Records[0]?.body || '';
  }

  //#endregion
}
