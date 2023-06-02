import { Resolvers } from '../schema/generated/resolvers.generated';
import { userQuery, userResolvers, updateUserProfilePicture, createUser, activateUser } from './user';

const resolvers: Resolvers = {
  User: userResolvers,
  Query: {
    user: userQuery,
  },
  Mutation: {
    updateUserProfilePicture: updateUserProfilePicture,
    createUser: createUser,
    activateUser: activateUser,
  },
};

export default resolvers;
