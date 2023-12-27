import { Resolvers } from '../schema/generated/resolvers.generated';
import {
  userQuery,
  userProfilePicturePresignedUrlQuery,
  userResolvers,
  updateUserProfilePicture,
  createUser,
  activateUser,
} from './user';
import { journeysQuery, watchJourney } from './journey';
import { locationsQuery } from './location';

const resolvers: Resolvers = {
  User: userResolvers,
  Query: {
    user: userQuery,
    userProfilePicturePresignedUrl: userProfilePicturePresignedUrlQuery,
    journeys: journeysQuery,
    locations: locationsQuery,
  },
  Mutation: {
    updateUserProfilePicture: updateUserProfilePicture,
    createUser: createUser,
    activateUser: activateUser,
    watchJourney: watchJourney,
  },
};

export default resolvers;
