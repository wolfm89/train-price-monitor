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
      return { journeyMonitor: getJourneyMonitorByJourneyId(context, userId, data['journeyId']) };
    },
  },
};

async function getJourneyMonitorByJourneyId(context: GraphQLContext, userId: string, journeyId: string) {
  // Retrieve the journey from the database
  const { Item: dbJourney } = await context.entities.Journey.get({ userId, id: journeyId });
  // Create a journey monitor object including the journey
  return getJourneyMonitor(context, dbJourney!);
}
