const EMAIL_PATTERN = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[a-z]{2,}/gi;

/**
 * Masks email addresses in text that is about to be logged. Error messages from
 * AWS SDK calls (SES in particular) can echo the recipient address back.
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '[email]');
}

/** Outcomes that are part of normal operation; logged as warnings so they do not trip the error alarms. */
const EXPECTED_ERROR_CODES = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT']);

export interface ErrorLogEntry {
  level: 'warn' | 'error';
  message: string;
  code?: string;
}

/**
 * Turns an error from the GraphQL pipeline into something safe to log.
 *
 * Parse, validation and variable-coercion errors carry no resolver path and
 * quote the client's input (a name, search text or a token passed in the
 * wrong variable), so only the fact and the code are logged. Resolver errors
 * keep their message, with email addresses masked.
 */
export function graphqlErrorLogEntry(error: unknown): ErrorLogEntry {
  if (!(error instanceof Error)) {
    return { level: 'error', message: 'Unknown GraphQL error' };
  }
  const rawCode = (error as { extensions?: { code?: unknown } }).extensions?.code;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  const level = code && EXPECTED_ERROR_CODES.has(code) ? 'warn' : 'error';
  const path = (error as { path?: unknown }).path;
  if (error.name === 'GraphQLError' && !path) {
    return { level, message: 'GraphQL request rejected', code };
  }
  return { level, message: redactEmails(error.message), code };
}
