// Retention rules for items written before the table had a TTL attribute.
// Same rules as src/lib/retention.ts; keep both in sync.

export const NOTIFICATION_RETENTION_DAYS = 90;
export const JOURNEY_TTL_MARGIN_DAYS = 7;

const SECONDS_PER_DAY = 24 * 60 * 60;
const JOURNEY_PREFIX = 'JOURNEY#';
const NOTIFICATION_PREFIX = 'NOTIFICATION#';

function toEpochSeconds(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function journeyTtl(expiresIso) {
  const expires = toEpochSeconds(expiresIso);
  return expires === undefined ? undefined : expires + JOURNEY_TTL_MARGIN_DAYS * SECONDS_PER_DAY;
}

export function notificationTtl(timestampIso, journeyExpiresIso) {
  const createdAt = toEpochSeconds(timestampIso);
  if (createdAt === undefined) return undefined;
  const retention = createdAt + NOTIFICATION_RETENTION_DAYS * SECONDS_PER_DAY;
  const journey = journeyExpiresIso === undefined ? undefined : journeyTtl(journeyExpiresIso);
  return journey === undefined ? retention : Math.max(retention, journey);
}

function linkedJourneyId(notification) {
  try {
    const data = JSON.parse(notification.data ?? '{}');
    return typeof data.journeyId === 'string' ? data.journeyId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plans a `ttl` for every journey and notification that has none yet. Items
 * that already carry a numeric ttl, and all other item types, are left alone.
 * Returns the updates plus the keys that could not be planned.
 */
export function planTtlBackfill(items) {
  const journeyExpires = new Map();
  for (const item of items) {
    if (typeof item.sk === 'string' && item.sk.startsWith(JOURNEY_PREFIX)) {
      journeyExpires.set(`${item.pk}|${item.sk.slice(JOURNEY_PREFIX.length)}`, item.expires);
    }
  }

  const updates = [];
  const skipped = [];
  for (const item of items) {
    if (typeof item.sk !== 'string' || typeof item.ttl === 'number') continue;

    let ttl;
    if (item.sk.startsWith(JOURNEY_PREFIX)) {
      ttl = journeyTtl(item.expires);
    } else if (item.sk.startsWith(NOTIFICATION_PREFIX)) {
      const journeyId = linkedJourneyId(item);
      ttl = notificationTtl(item.timestamp, journeyId ? journeyExpires.get(`${item.pk}|${journeyId}`) : undefined);
    } else {
      continue;
    }

    if (ttl === undefined) {
      skipped.push({ pk: item.pk, sk: item.sk, reason: 'no valid date to derive the ttl from' });
    } else {
      updates.push({ pk: item.pk, sk: item.sk, ttl });
    }
  }
  return { updates, skipped };
}
