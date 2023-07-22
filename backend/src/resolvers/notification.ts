import { NotificationResolvers } from '../schema/generated/resolvers.generated';

export const notificationResolvers: NotificationResolvers = {
  id: (parent) => parent.id,
  userId: (parent) => parent.userId,
  journeyId: (parent) => parent.journeyId,
  message: (parent) => parent.message,
  timestamp: (parent) => parent.timestamp,
  read: (parent) => parent.read,
};
