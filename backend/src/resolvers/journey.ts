import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers } from '../schema/generated/resolvers.generated';
import { v4 as uuidv4 } from 'uuid';

export const journeysQuery: NonNullable<QueryResolvers['journeys']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  const journeys = await context.dbHafas.queryJourneys(args.from, args.to, args.departure);
  if (journeys === undefined || journeys.journeys === undefined || journeys.journeys.length === 0) {
    Logger.info(`No journeys found from ${args.from} to ${args.to} at ${args.departure.toISOString()}`);
    return [];
  }
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

export const watchJourney: NonNullable<MutationResolvers['watchJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  const { Item: dbUser } = await context.entities.User.get({ id: args.userId });
  if (!dbUser) {
    throw new Error(`User with id ${args.userId} not found`);
  }
  const journeyWatchId = uuidv4();
  await context.entities.Journey.put({
    id: journeyWatchId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    refreshToken: args.refreshToken,
  });
  return journeyWatchId;
};

export const updateJourneys: NonNullable<MutationResolvers['updateJourneys']> = async (
  _parent,
  _args,
  context: GraphQLContext
) => {
  const allJourneys = await context.entities.Journey.scan({
    filters: { attr: 'id', beginsWith: 'JOURNEY#' },
    attributes: ['userId', 'id'],
  });
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

export const updateJourney: NonNullable<MutationResolvers['updateJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  const journey = await context.entities.Journey.get({ userId: args.userId, id: args.journeyId });

  if (!journey.Item) {
    throw new Error(`Journey with id ${args.journeyId} for user ${args.userId} not found`);
  }

  Logger.info(`Updating journey ${args.journeyId} for user ${args.userId}`);

  // Get new price for journey and compare to limit price
  // If new price is higher than limit price, send notification
  // TODO: Add queue URL to gitpod setup

  return journey.Item.id;
};
