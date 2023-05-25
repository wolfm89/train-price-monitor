import { Resolvers } from '../schema/generated/resolvers.generated';
import { userQuery, userResolvers, updateProfilePicture, createUser } from './user';

const resolvers: Resolvers = {
  User: userResolvers,
  Query: {
    user: userQuery,
  },
  Mutation: {
    updateProfilePicture: updateProfilePicture,
    createUser: createUser,
  },
};

export default resolvers;
