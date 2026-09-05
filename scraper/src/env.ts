import type { Logger } from '@aws-lambda-powertools/logger';

/**
 * Reads a positive-integer tuning value from the environment.
 *
 * `Number(process.env.X ?? fallback)` looks equivalent but is not: the `??`
 * only guards an *unset* variable, so a variable that is set but empty or
 * non-numeric yields `0` or `NaN` rather than the fallback. Those values then
 * fail in ways that are hard to trace back to a typo — `Limit: 0` is rejected
 * by DynamoDB outright ("valid min value: 1"), while a `NaN` day count silently
 * turns a seeding loop into a no-op that still reports success.
 *
 * These are set by CDK in normal operation, but Lambda environment variables
 * are also editable by hand, which is exactly how a bad value arrives.
 */
export function positiveIntFromEnv(name: string, fallback: number, logger: Logger): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    logger.warn('Ignoring invalid environment value, using default', {
      variable: name,
      value: raw,
      fallback,
    });
    return fallback;
  }

  return parsed;
}
