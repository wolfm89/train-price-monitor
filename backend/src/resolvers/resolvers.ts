import { Resolvers } from '../schema/generated/resolvers.generated';
import {
  userQuery,
  userProfilePicturePresignedUrlQuery,
  userResolvers,
  updateUserProfilePicture,
  createUser,
  activateUser,
} from './user';
import { journeysQuery } from './journey';

const resolvers: Resolvers = {
  User: userResolvers,
  Query: {
    user: userQuery,
    userProfilePicturePresignedUrl: userProfilePicturePresignedUrlQuery,
    journeys: journeysQuery,
  },
  Mutation: {
    updateUserProfilePicture: updateUserProfilePicture,
    createUser: createUser,
    activateUser: activateUser,
  },
};

export default resolvers;
