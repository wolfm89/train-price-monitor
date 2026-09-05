import { GraphQLContext } from '../context';
import { User } from '../schema/generated/typeDefs.generated';
import { GetItemCommand, StoredJourney } from '../model/trainPriceMonitor';
import { getJourneyMonitor } from './user';

interface NotificationType {
  name: string;
  mapAdditionalData: (context: GraphQLContext, userId: string, data: { [key: string]: unknown }) => Promise<object>;
  formatEmail: (
    context: GraphQLContext,
    user: User,
    data: { [key: string]: unknown }
  ) => Promise<EmailNotificationInfo>;
}

export interface EmailNotificationInfo {
  to: string;
  subject: string;
  htmlBody: string;
}

export const NOTIFICATION_TYPES: { [key: string]: NotificationType } = {
  PRICE_ALERT: {
    name: 'PRICE_ALERT',
    mapAdditionalData: async (context, userId, data) => {
      return { journeyMonitor: await getJourneyMonitorByJourneyId(context, userId, data['journeyId'] as string) };
    },
    formatEmail: async (context, user, data) => {
      const { id, from, to, journey, limitPrice } = await getJourneyMonitorByJourneyId(
        context,
        user.id,
        data['journeyId'] as string
      );
      if (!from || !to) {
        throw new Error('Could not retrieve journey station names');
      }
      const subject = `Price alert for your journey from ${from} to ${to}`;
      const htmlBody = `
        <p>Hi ${user.givenName},</p>
        <p>The price for your journey from <b>${from}</b> to <b>${to}</b> has changed.</p>
        <p>It is now <b>€${journey?.price?.toFixed(2)}</b> (your limit price was <b>€${limitPrice.toFixed(2)}</b>).</p>
        <p>Check it out here: <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/journeys#${id}">${
          process.env.FRONTEND_URL || 'http://localhost:3000'
        }/journeys#${id}</a></p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
  JOURNEY_EXPIRED: {
    name: 'JOURNEY_EXPIRED',
    mapAdditionalData: async (context, _userId, data) => {
      const journey = await context.dbHafas.requeryJourney(data['refreshToken'] as string);
      if (!journey) {
        throw new Error('Could not requery journey');
      }
      return {
        from: journey.legs[0].origin!.name!,
        to: journey.legs[journey.legs.length - 1].destination!.name!,
      };
    },
    formatEmail: async (context, user, data) => {
      const journey = await context.dbHafas.requeryJourney(data['refreshToken'] as string);
      if (!journey) {
        throw new Error('Could not requery journey');
      }
      const from = journey.legs[0].origin!.name!;
      const to = journey.legs[journey.legs.length - 1].destination!.name!;
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

async function getJourneyMonitorByJourneyId(context: GraphQLContext, userId: string, journeyId: string) {
  const { Item: dbJourney } = await context.entities.Journey.build(GetItemCommand)
    .key({ userId, id: journeyId })
    .send();
  if (!dbJourney) {
    throw new Error(`Journey with ID ${journeyId} not found in database`);
  }
  return getJourneyMonitor(dbJourney as StoredJourney);
}
