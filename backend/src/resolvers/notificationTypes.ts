/* eslint-disable @typescript-eslint/no-explicit-any */
import { GraphQLContext } from '../context';
import { getJourneyMonitor } from './user';

interface NotificationType {
  name: string;
  mapAdditionalData: (context: GraphQLContext, userId: string, data: { [key: string]: any }) => object;
}

export const NOTIFICATION_TYPES: { [key: string]: NotificationType } = {
  PRICE_ALERT: {
    name: 'PRICE_ALERT',
    mapAdditionalData: (context: GraphQLContext, userId: string, data: { [key: string]: any }) => {
      return { journeyMonitor: getJourneyMonitorByJourneyId(context, userId, data['journeyId']) };
    },
  },
  JOURNEY_EXPIRED: {
    name: 'JOURNEY_EXPIRED',
    mapAdditionalData: async (context: GraphQLContext, userId: string, data: { [key: string]: any }) => {
      const journey = await context.dbHafas.requeryJourney(data['refreshToken']);
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
