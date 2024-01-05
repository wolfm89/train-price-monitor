import { Journey } from 'hafas-client';
import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers } from '../schema/generated/resolvers.generated';
import { v4 as uuidv4 } from 'uuid';
import { Journey as GqlJourney, JourneyMonitor } from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';

/**
 * Resolves the 'journey.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the query.
 * @param context - The GraphQL context.
 * @returns A list of journeys.
 */
export const journeysQuery: NonNullable<QueryResolvers['journeys']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<GqlJourney[]> => {
  // Query journeys using Hafas API
  const journeys = await context.dbHafas.queryJourneys(args.from, args.to, args.departure);

  // Check if no journeys were found
  if (!journeys || !journeys.journeys || journeys.journeys.length === 0) {
    Logger.info(`No journeys found from ${args.from} to ${args.to} at ${args.departure.toISOString()}`);
    return [];
  }

  // Map and format the journeys for response
  return journeys.journeys.map((journey) => {
    return {
      from: args.from,
      to: args.to,
      departure: new Date(journey.legs[0].departure!),
      arrival: new Date(journey.legs[journey.legs.length - 1].arrival!),
      refreshToken: journey.refreshToken!,
      price: journey.price?.amount,
      means: getMeans(journey),
    };
  });
};

/**
 * Resolves the 'monitorJourney' mutation to add a new journey monitor for a user.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The ID of the newly created journey monitor.
 */
export const monitorJourney: NonNullable<MutationResolvers['monitorJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  // Retrieve user from the database
  const { Item: dbUser } = await context.entities.User.get({ id: args.userId });
  if (!dbUser) {
    throw new Error(`User with id ${args.userId} not found`);
  }

  // Generate a new journey monitor ID using UUID
  const journeyMonitorId = uuidv4();

  // Save the journey monitor in the database
  await context.entities.Journey.put({
    id: journeyMonitorId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    refreshToken: args.refreshToken,
    expires: args.expires,
  });
  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);

  return {
    id: journeyMonitorId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    expires: args.expires,
    journey: { refreshToken: args.refreshToken },
  };
};

/**
 * Resolves the 'updateJourneyMonitors' mutation to update all stored journeys.
 * @param _parent - The parent object.
 * @param _args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The number of journeys updated.
 */
export const updateJourneyMonitors: NonNullable<MutationResolvers['updateJourneyMonitors']> = async (
  _parent,
  _args,
  context: GraphQLContext
): Promise<number> => {
  // Query all journeys from the database
  const allJourneys = await context.entities.Journey.scan({
    filters: { attr: 'id', beginsWith: 'JOURNEY#' },
    attributes: ['userId', 'id'],
  });

  // Count the number of journeys
  const numberOfJourneys = allJourneys.Items ? allJourneys.Items.length : 0;

  Logger.info(`Found ${numberOfJourneys} journeys to update`);

  // Schedule message for each journey
  if (allJourneys.Items) {
    for (const journey of allJourneys.Items) {
      await context.sqs.sendUpdateJourneyMessage(journey.userId, journey.id);
    }
  }

  return numberOfJourneys;
};

/**
 * Resolves the 'updateJourneyMonitor' mutation to update a specific journey.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The ID of the updated journey.
 */
export const updateJourneyMonitor: NonNullable<MutationResolvers['updateJourneyMonitor']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  // Add user and journey ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: args.userId, journeyId: args.journeyId });

  // Retrieve the journey from the database
  const dbJourney = await context.entities.Journey.get({ userId: args.userId, id: args.journeyId });

  // Check if the journey exists
  if (!dbJourney.Item) {
    throw new Error('Journey not found in database');
  }

  const journeyMonitor: JourneyMonitor = {
    id: dbJourney.Item.id,
    userId: dbJourney.Item.userId,
    limitPrice: dbJourney.Item.limitPrice,
    expires: dbJourney.Item.expires,
    journey: { refreshToken: dbJourney.Item.refreshToken },
  };

  // Check if the journey has expired
  if (new Date(dbJourney.Item.expires) < new Date()) {
    Logger.info(`Journey has expired`);

    // Delete the journey from the database
    await context.entities.Journey.delete({ userId: args.userId, id: args.journeyId });
    context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
    Logger.info(`Deleted journey from database`);

    // Send a notification to the user that the journey has expired
    await context.entities.Notification.put({
      id: uuidv4(),
      userId: args.userId,
      type: NOTIFICATION_TYPES.JOURNEY_EXPIRED.name,
      read: false,
      timestamp: new Date().toISOString(),
      data: { refreshToken: dbJourney.Item.refreshToken },
    });
    context.cache.invalidate([{ typename: 'Notification' }]);

    return journeyMonitor;
  }

  // Check if notification already exists
  const existingNotifications = await context.entities.Notification.query(`USER#${args.userId}`, {
    beginsWith: 'NOTIFICATION#',
    filters: [{ attr: 'type', eq: NOTIFICATION_TYPES.PRICE_ALERT.name }],
    attributes: ['data'],
  });
  if (existingNotifications?.Items?.some((item) => item.data?.journeyId === args.journeyId)) {
    Logger.info(`Notification already exists for journey`);
    return journeyMonitor;
  }

  // Get new price for journey and compare to limit price
  // If new price is higher than limit price, send notification
  const journey = await context.dbHafas.requeryJourney(dbJourney.Item.refreshToken);
  if (!journey) {
    throw new Error('Could not requery journey');
  }
  const newPrice = journey.price?.amount;

  // Log information about the updated journey
  if (!newPrice) {
    Logger.info(`No price found for journey`);
  } else if (newPrice >= dbJourney.Item.limitPrice) {
    Logger.info(`New price ${newPrice} for journey is higher than limit price ${dbJourney.Item.limitPrice}`);

    // Save a notification in the database
    await context.entities.Notification.put({
      id: uuidv4(),
      userId: args.userId,
      type: NOTIFICATION_TYPES.PRICE_ALERT.name,
      read: false,
      timestamp: new Date().toISOString(),
      data: { journeyId: args.journeyId },
    });
    context.cache.invalidate([{ typename: 'Notification' }]);

    Logger.info(`Sent notification for journey`);
  } else {
    Logger.info(`New price ${newPrice} for journey is still lower than limit price ${dbJourney.Item.limitPrice}`);
  }

  return journeyMonitor;
};

export function getMeans(journey: Journey): string[] {
  return journey.legs.map((leg) => (leg.line ? leg.line.productName! : leg.walking ? 'walk' : ''));
}
