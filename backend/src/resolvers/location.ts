import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { QueryResolvers } from '../schema/generated/resolvers.generated';

export const locationsQuery: NonNullable<QueryResolvers['locations']> = async (
  _parent,
  args,
  context: GraphQLContext
) => {
  const locations = await context.dbHafas.queryLocations(args.query);
  if (locations === undefined || locations.length === 0) {
    Logger.info(`No locations found for ${args.query}`);
    return [];
  }
  return locations.map((location) => {
    return {
      type: location.type,
      name: location.name,
      id: location.id,
    };
  });
};
