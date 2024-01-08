import { GraphQLContext } from '../context';
import { MutationResolvers, NotificationResolvers } from '../schema/generated/resolvers.generated';
import Logger from '../lib/logger';
import { Notification } from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';

export const notificationResolvers: NotificationResolvers = {
  __resolveType(data) {
    if (data.type === NOTIFICATION_TYPES.PRICE_ALERT.name) {
      return 'PriceAlertNotification';
    }
    if (data.type === NOTIFICATION_TYPES.JOURNEY_EXPIRED.name) {
      return 'JourneyExpiryNotification';
    }
    return null; // GraphQLError is thrown
  },
};

export const markNotificationAsRead: NonNullable<MutationResolvers['markNotificationAsRead']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<Notification> => {
  // Add user and notification ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: args.userId, notificationId: args.notificationId });

  // Retrieve the notification from the database
  const { Item: dbNotification } = await context.entities.Notification.get({
    userId: args.userId,
    id: args.notificationId,
  });

  // Check if the notification exists
  if (!dbNotification) {
    throw new Error('Notification not found in database');
  }

  // Check if the notification is already read
  if (dbNotification.read) {
    Logger.info(`Notification is already read`);
    return dbNotification as Notification;
  }

  // Update the notification in the database
  const { Attributes: notification } = await context.entities.Notification.update(
    { userId: args.userId, id: args.notificationId, read: true },
    { returnValues: 'ALL_NEW' }
  );
  context.cache.invalidate([{ typename: 'Notification' }]);
  Logger.info(`Marked notification as read`);

  return notification as Notification;
};
