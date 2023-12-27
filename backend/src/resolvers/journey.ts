import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers } from '../schema/generated/resolvers.generated';

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
  // store journey from args in DB for user and return journey
  const journey = args.journey;

  return journey;
};
