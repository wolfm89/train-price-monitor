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
