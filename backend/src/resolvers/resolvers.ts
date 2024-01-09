import { Resolvers } from '../schema/generated/resolvers.generated';
import {
  userQuery,
  userProfilePicturePresignedUrlQuery,
  userResolvers,
  updateUserProfilePicture,
  createUser,
  activateUser,
} from './user';
import {
  journeysQuery,
  monitorJourney,
  updateJourneyMonitors,
  updateJourneyMonitor,
  deleteJourneyMonitor,
} from './journey';
import { locationsQuery } from './location';
import { markNotificationAsRead, notificationResolvers } from './notification';

const resolvers: Resolvers = {
  User: userResolvers,
  Notification: notificationResolvers,
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
    monitorJourney: monitorJourney,
    updateJourneyMonitors: updateJourneyMonitors,
    updateJourneyMonitor: updateJourneyMonitor,
    deleteJourneyMonitor: deleteJourneyMonitor,
    markNotificationAsRead: markNotificationAsRead,
  },
};

export default resolvers;
