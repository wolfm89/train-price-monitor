import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers } from '../schema/generated/resolvers.generated';
import { v4 as uuidv4 } from 'uuid';

/**
 * Resolves the 'journeys' query to retrieve a list of journeys based on provided arguments.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the query.
 * @param context - The GraphQL context.
 * @returns A list of journeys.
 */
export const journeysQuery: NonNullable<QueryResolvers['journeys']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
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
      refreshToken: journey.refreshToken,
      price: journey.price?.amount,
      means: journey.legs.map((leg) => (leg.line ? leg.line.productName : leg.walking ? 'walk' : undefined)),
    };
  });
};

/**
 * Resolves the 'watchJourney' mutation to add a new journey watch for a user.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The ID of the newly created journey watch.
 */
export const watchJourney: NonNullable<MutationResolvers['watchJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  // Retrieve user from the database
  const { Item: dbUser } = await context.entities.User.get({ id: args.userId });
  if (!dbUser) {
    throw new Error(`User with id ${args.userId} not found`);
  }

  // Generate a new journey watch ID using UUID
  const journeyWatchId = uuidv4();

  // Save the journey watch in the database
  await context.entities.Journey.put({
    id: journeyWatchId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    refreshToken: args.refreshToken,
  });

  return journeyWatchId;
};

/**
 * Resolves the 'updateJourneys' mutation to update all stored journeys.
 * @param _parent - The parent object.
 * @param _args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The number of journeys updated.
 */
export const updateJourneys: NonNullable<MutationResolvers['updateJourneys']> = async (
  _parent,
  _args,
  context: GraphQLContext
) => {
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
 * Resolves the 'updateJourney' mutation to update a specific journey.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The ID of the updated journey.
 */
export const updateJourney: NonNullable<MutationResolvers['updateJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  // Add user and journey ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: args.userId, journeyId: args.journeyId });

  // Retrieve the journey from the database
  const dbJourney = await context.entities.Journey.get({ userId: args.userId, id: args.journeyId });

  // Check if the journey exists
  if (!dbJourney.Item) {
    throw new Error(`Journey not found`);
  }

  // Get new price for journey and compare to limit price
  // If new price is higher than limit price, send notification
  const journey = await context.dbHafas.requeryJourney(dbJourney.Item.refreshToken);
  const newPrice = journey.price?.amount;

  // Log information about the updated journey
  if (!newPrice) {
    Logger.info(`No price found for journey`);
  } else if (newPrice >= dbJourney.Item.limitPrice) {
    Logger.info(`New price ${newPrice} for journey is higher than limit price ${dbJourney.Item.limitPrice}`);
    const from = journey.legs[0].origin?.name;
    const to = journey.legs[journey.legs.length - 1].destination?.name;

    // Save a notification in the database
    await context.entities.Notification.put({
      id: uuidv4(),
      userId: args.userId,
      journeyId: args.journeyId,
      message: `Price for journey from ${from} to ${to} is now higher than ${newPrice}€`,
      read: false,
      timestamp: new Date().toISOString(),
    });

    Logger.info(`Sent notification for journey`);
  } else {
    Logger.info(`New price ${newPrice} for journey is still lower than limit price ${dbJourney.Item.limitPrice}`);
  }

  return dbJourney.Item.id;
};
