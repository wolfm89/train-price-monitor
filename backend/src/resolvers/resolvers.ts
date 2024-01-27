import { Resolvers } from '../schema/generated/resolvers.generated';
import {
  userQuery,
  userProfilePicturePresignedUrlQuery,
  userResolvers,
  updateUserProfilePicture,
  createUser,
  updateUserSettings,
  deleteUser,
} from './user';
import {
  journeysQuery,
  monitorJourney,
  updateJourneyMonitors,
  updateJourneyMonitor,
  deleteJourneyMonitor,
} from './journey';
import { locationsQuery } from './location';
import { markNotificationAsRead, sendEmailNotification, notificationResolvers } from './notification';

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
    updateUserSettings: updateUserSettings,
    deleteUser: deleteUser,
    monitorJourney: monitorJourney,
    updateJourneyMonitors: updateJourneyMonitors,
    updateJourneyMonitor: updateJourneyMonitor,
    deleteJourneyMonitor: deleteJourneyMonitor,
    markNotificationAsRead: markNotificationAsRead,
    sendEmailNotification: sendEmailNotification,
  },
};

export default resolvers;
