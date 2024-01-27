import { GraphQLContext } from '../context';
import { User } from '../schema/generated/typeDefs.generated';
import { getJourneyMonitor } from './user';

interface NotificationType {
  name: string;
  mapAdditionalData: (context: GraphQLContext, userId: string, data: { [key: string]: unknown }) => object;
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
    mapAdditionalData: (context, userId, data) => {
      return { journeyMonitor: getJourneyMonitorByJourneyId(context, userId, data['journeyId'] as string) };
    },
    formatEmail: async (context, user, data) => {
      const { id, journey, limitPrice } = await getJourneyMonitorByJourneyId(
        context,
        user.id,
        data['journeyId'] as string
      );
      if (!journey) {
        throw new Error('Could not retrieve journey');
      }
      const subject = `Price alert for your journey from ${journey.from} to ${journey.to}`;
      const htmlBody = `
        <p>Hi ${user.givenName},</p>
        <p>The price for your journey from <b>${journey.from}</b> to <b>${journey.to}</b> has changed.</p>
        <p>It is now <b>€${journey.price?.toFixed(2)}</b> (your limit price was <b>€${limitPrice.toFixed(2)}</b>).</p>
        <p>Check it out here: <a href="https://tpm.wolfgangmoser.eu/journeys#${id}">https://tpm.wolfgangmoser.eu/journeys#${id}</a></p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
  JOURNEY_EXPIRED: {
    name: 'JOURNEY_EXPIRED',
    mapAdditionalData: async (context, userId, data) => {
      const journey = await context.dbHafas.requeryJourney(data['refreshToken'] as string);
      if (!journey) {
        throw new Error('Could not requery journey');
      }
      return {
        journey: {
          refreshToken: journey.refreshToken!,
          from: journey.legs[0].origin!.name!,
          to: journey.legs[journey.legs.length - 1].destination!.name!,
          departure: new Date(journey.legs[0].plannedDeparture!),
          arrival: new Date(journey.legs[journey.legs.length - 1].plannedArrival!),
          price: journey.price?.amount,
        },
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
        Visit <a href="https://tpm.wolfgangmoser.eu/">https://tpm.wolfgangmoser.eu/</a> to monitor a new journey.</p>
        <p>Best regards,<br/>Train Price Monitor</p>
      `;
      return { to: user.email, subject, htmlBody };
    },
  },
};

async function getJourneyMonitorByJourneyId(context: GraphQLContext, userId: string, journeyId: string) {
  // Retrieve the journey from the database
  const { Item: dbJourney } = await context.entities.Journey.get({ userId, id: journeyId });
  if (!dbJourney) {
    throw new Error(`Journey with ID ${journeyId} not found in database`);
  }
  // Create a journey monitor object including the journey
  return getJourneyMonitor(context, dbJourney);
}
