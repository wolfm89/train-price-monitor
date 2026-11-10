import { GraphQLContext } from '../context';
import { JourneyMonitor, User } from '../schema/generated/typeDefs.generated';
import { GetItemCommand, StoredJourney } from '../model/trainPriceMonitor';
import { getJourneyMonitor } from './user';

interface NotificationType {
  name: string;
  mapAdditionalData: (context: GraphQLContext, userId: string, data: { [key: string]: unknown }) => Promise<object>;
  formatEmail: (
    context: GraphQLContext,
    user: User,
    data: { [key: string]: unknown }
  ) => Promise<EmailNotificationInfo | null>;
}

export interface EmailNotificationInfo {
  to: string;
  subject: string;
  htmlBody: string;
}

/**
 * Thrown when an email no longer has enough data to be rendered. The SQS worker
 * treats this as an expected no-op and acks the message instead of retrying it
 * into the DLQ; genuine failures keep using ordinary errors.
 */
export class NotificationSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationSkipError';
  }
}

interface PriceAlertSnapshot {
  from?: string;
  to?: string;
  price?: number;
  limitPrice?: number;
  expires?: string;
}

function readPriceAlertSnapshot(data: { [key: string]: unknown }): PriceAlertSnapshot {
  return {
    from: typeof data['from'] === 'string' ? data['from'] : undefined,
    to: typeof data['to'] === 'string' ? data['to'] : undefined,
    price: typeof data['price'] === 'number' ? data['price'] : undefined,
    limitPrice: typeof data['limitPrice'] === 'number' ? data['limitPrice'] : undefined,
    expires: typeof data['expires'] === 'string' ? data['expires'] : undefined,
  };
}

/**
 * The notification survives a deleted journey (the email worker and the watchlist
 * can race the deletion). Serve the snapshot as an unavailable monitor instead of
 * dropping the notification with an error.
 */
function priceAlertFallbackMonitor(userId: string, data: { [key: string]: unknown }): JourneyMonitor {
  const snapshot = readPriceAlertSnapshot(data);
  return {
    id: typeof data['journeyId'] === 'string' ? data['journeyId'] : '',
    userId,
    limitPrice: snapshot.limitPrice ?? 0,
    expires: snapshot.expires ? new Date(snapshot.expires) : new Date(0),
    from: snapshot.from,
    to: snapshot.to,
    unavailable: true,
    journey: undefined,
  };
}

export const NOTIFICATION_TYPES: { [key: string]: NotificationType } = {
  PRICE_ALERT: {
    name: 'PRICE_ALERT',
    mapAdditionalData: async (context, userId, data) => {
      const journeyId = typeof data['journeyId'] === 'string' ? data['journeyId'] : undefined;
      if (!journeyId) {
        return { journeyMonitor: priceAlertFallbackMonitor(userId, data) };
      }
      const journeyMonitor = await getJourneyMonitorByJourneyId(context, userId, journeyId);
      return { journeyMonitor: journeyMonitor ?? priceAlertFallbackMonitor(userId, data) };
    },
    formatEmail: async (context, user, data) => {
      const journeyId = typeof data['journeyId'] === 'string' ? data['journeyId'] : undefined;
      if (!journeyId) {
        return null;
      }

      // New notifications carry everything the email needs, so a journey deleted
      // before the worker runs is no longer an error. Older ones fall back to DB.
      const snapshot = readPriceAlertSnapshot(data);
      let from = snapshot.from;
      let to = snapshot.to;
      let price = snapshot.price;
      let limitPrice = snapshot.limitPrice;

      if (from === undefined || to === undefined || price === undefined || limitPrice === undefined) {
        const monitor = await getJourneyMonitorByJourneyId(context, user.id, journeyId);
        if (!monitor) {
          return null;
        }
        from = monitor.from ?? from;
        to = monitor.to ?? to;
        price = monitor.journey?.price ?? price;
        limitPrice = monitor.limitPrice;
      }

      if (!from || !to || price === undefined || limitPrice === undefined) {
        return null;
      }

      const subject = `Price alert for your journey from ${from} to ${to}`;
      const htmlBody = `
        <p>Hi ${user.givenName},</p>
        <p>The price for your journey from <b>${from}</b> to <b>${to}</b> has changed.</p>
        <p>It is now <b>€${price.toFixed(2)}</b> (your limit price was <b>€${limitPrice.toFixed(2)}</b>).</p>
        <p>Check it out here: <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/journeys#${journeyId}">${
          process.env.FRONTEND_URL || 'http://localhost:3000'
        }/journeys#${journeyId}</a></p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
  JOURNEY_EXPIRED: {
    name: 'JOURNEY_EXPIRED',
    mapAdditionalData: async (context, _userId, data) => {
      return await resolveExpiredJourneyStations(context, data);
    },
    formatEmail: async (context, user, data) => {
      const { from, to } = await resolveExpiredJourneyStations(context, data);
      const subject = `Your journey from ${from} to ${to} has expired`;
      const htmlBody = `
        <p>Hi ${user.givenName},</p>
        <p>Your journey from <b>${from}</b> to <b>${to}</b> has expired and was therefore deleted.<br/>
        Visit <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/">${
          process.env.FRONTEND_URL || 'http://localhost:3000'
        }/</a> to monitor a new journey.</p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
  JOURNEY_STALE: {
    name: 'JOURNEY_STALE',
    mapAdditionalData: async (context, _userId, data) => {
      const fromId = data['fromId'] as string;
      const toId = data['toId'] as string;
      const fromStation = await context.dbHafas.getStationById(fromId);
      const toStation = await context.dbHafas.getStationById(toId);
      return {
        journeyId: data['journeyId'] as string,
        from: fromStation?.name ?? fromId,
        to: toStation?.name ?? toId,
      };
    },
    formatEmail: async (context, user, data) => {
      const fromId = data['fromId'] as string;
      const toId = data['toId'] as string;
      const fromStation = await context.dbHafas.getStationById(fromId);
      const toStation = await context.dbHafas.getStationById(toId);
      const from = fromStation?.name ?? fromId;
      const to = toStation?.name ?? toId;
      const journeyId = data['journeyId'] as string;
      const subject = `Your train from ${from} to ${to} can no longer be tracked`;
      const htmlBody = `
        <p>Hi ${user.givenName},</p>
        <p>The train from <b>${from}</b> to <b>${to}</b> that you're monitoring can no longer be tracked.</p>
        <p>This typically happens when the train has been <b>cancelled</b> or its <b>schedule has changed</b>.</p>
        <p>You may want to <a href="${
          process.env.FRONTEND_URL || 'http://localhost:3000'
        }/journeys#${journeyId}">delete this journey monitor</a> and set one up again once updated schedules are available.</p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
};

async function getJourneyMonitorByJourneyId(
  context: GraphQLContext,
  userId: string,
  journeyId: string
): Promise<JourneyMonitor | null> {
  const { Item: dbJourney } = await context.entities.Journey.build(GetItemCommand)
    .key({ userId, id: journeyId })
    .send();
  if (!dbJourney) {
    return null;
  }
  return getJourneyMonitor(dbJourney as StoredJourney);
}

/**
 * Station names for an expired journey, cheapest source first.
 *
 * Expiry deletes the Journey item, so the snapshot that held `cachedFrom` /
 * `cachedTo` is gone by the time the email is built. Both those names and the
 * station IDs are therefore copied onto the notification when it is created:
 *
 *  1. the persisted names, when the journey had been refreshed successfully;
 *  2. otherwise the station IDs, resolved against the bundled station data the
 *     same way JOURNEY_STALE does — local, so it works with DB unreachable;
 *  3. only failing both, a DB round-trip, which throws when DB is down and
 *     would fail the email into the DLQ.
 *
 * Tier 2 matters because the cached names only exist after a successful
 * refresh: a journey that expires before one ever succeeded stores neither name
 * (JSON.stringify omits undefined), which would otherwise go straight to DB.
 */
async function resolveExpiredJourneyStations(
  context: GraphQLContext,
  data: { [key: string]: unknown }
): Promise<{ from: string; to: string }> {
  const from = data['from'];
  const to = data['to'];

  if (typeof from === 'string' && typeof to === 'string') {
    return { from, to };
  }

  const fromId = data['fromId'];
  const toId = data['toId'];

  if (typeof fromId === 'string' && typeof toId === 'string') {
    const fromStation = await context.dbHafas.getStationById(fromId);
    const toStation = await context.dbHafas.getStationById(toId);
    return { from: fromStation?.name ?? fromId, to: toStation?.name ?? toId };
  }

  const refreshToken = data['refreshToken'];
  if (typeof refreshToken !== 'string') {
    throw new NotificationSkipError('No refresh token for expired journey');
  }

  const journey = await context.dbHafas.requeryJourney(refreshToken);
  if (!journey) {
    // The journey was deleted before the email was built. Expected, not a retry.
    throw new NotificationSkipError('Could not requery journey');
  }

  return {
    from: journey.legs[0].origin!.name!,
    to: journey.legs[journey.legs.length - 1].destination!.name!,
  };
}
