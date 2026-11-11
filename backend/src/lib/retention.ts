/**
 * Retention periods enforced through the table's DynamoDB TTL attribute
 * (`ttl`, epoch seconds). DynamoDB deletes expired items in the background,
 * usually within a few days. scripts/backfill-ttl-lib.mjs applies the same
 * rules to items written before TTL existed; keep both in sync.
 */
export const NOTIFICATION_RETENTION_DAYS = 90;

/**
 * Safety margin after a journey's expiry. The hourly refresher normally deletes
 * expired journeys itself (and notifies the user); TTL only catches journeys
 * the refresher never reached.
 */
export const JOURNEY_TTL_MARGIN_DAYS = 7;

const SECONDS_PER_DAY = 24 * 60 * 60;

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function journeyTtl(expires: Date): number {
  return epochSeconds(expires) + JOURNEY_TTL_MARGIN_DAYS * SECONDS_PER_DAY;
}

/**
 * A notification is kept for NOTIFICATION_RETENTION_DAYS, but never removed
 * before the journey it refers to: while it exists it also stops the refresher
 * from raising (and emailing) the same alert again.
 */
export function notificationTtl(createdAt: Date, journeyExpires?: Date): number {
  const retention = epochSeconds(createdAt) + NOTIFICATION_RETENTION_DAYS * SECONDS_PER_DAY;
  return journeyExpires ? Math.max(retention, journeyTtl(journeyExpires)) : retention;
}

/** Sign-ups that are not confirmed within this period are deleted from Cognito by a daily job. */
export const UNCONFIRMED_SIGNUP_RETENTION_DAYS = 7;

/** The usernames of unconfirmed sign-ups older than the retention period. */
export function expiredSignups(signups: { username: string; createdAt?: Date }[], now: Date = new Date()): string[] {
  const cutoff = now.getTime() - UNCONFIRMED_SIGNUP_RETENTION_DAYS * SECONDS_PER_DAY * 1000;
  return signups
    .filter((signup) => signup.createdAt !== undefined && signup.createdAt.getTime() < cutoff)
    .map((signup) => signup.username);
}
